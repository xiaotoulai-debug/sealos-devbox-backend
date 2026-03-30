/**
 * 库存进销存 API
 *
 * POST /api/inventory/batch-adjust     — 人工批量盘点调库（写 MANUAL_ADJUST 流水）
 * PUT  /api/inventory/purchase-orders/:id/receive — 采购单确认入库（写 PURCHASE_IN 流水）
 * GET  /api/inventory/logs             — 库存流水查询（分页）
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { InventoryLogType } from '@prisma/client';

const router = Router();
router.use(authenticate);

// ────────────────────────────────────────────────────────────────────
// 工具：在事务中写一条库存流水并更新 Product.stockActual
//       warehouseId 可选——传入时记录到流水，不影响主逻辑
// ────────────────────────────────────────────────────────────────────
export async function applyStockChange(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  opts: {
    productId: number;
    changeQuantity: number;         // 正=入库，负=出库
    type: InventoryLogType;
    warehouseId?: number | null;    // 多仓：记录到流水（可空，兼容老逻辑）
    referenceId?: string | null;
    remark?: string | null;
    createdBy?: number | null;
  },
): Promise<{ before: number; after: number }> {
  const prod = await tx.product.findUnique({
    where: { id: opts.productId },
    select: { stockActual: true },
  });
  const before = prod?.stockActual ?? 0;
  const after = Math.max(0, before + opts.changeQuantity);

  await tx.product.update({
    where: { id: opts.productId },
    data: { stockActual: after },
  });

  await tx.inventoryLog.create({
    data: {
      productId:      opts.productId,
      warehouseId:    opts.warehouseId ?? null,
      type:           opts.type,
      changeQuantity: opts.changeQuantity,
      beforeQuantity: before,
      afterQuantity:  after,
      referenceId:    opts.referenceId ?? null,
      remark:         opts.remark ?? null,
      createdBy:      opts.createdBy ?? null,
    },
  });

  return { before, after };
}

// ────────────────────────────────────────────────────────────────────
// POST /api/inventory/batch-adjust   人工批量盘点调库（多仓版）
//
// Body:
//   warehouseId: number          ← 必填，指定盘点仓库
//   items: Array<{
//     productId: number;
//     newStock:  number;          ← 盘点后目标库存量（绝对值）
//     remark?:   string;
//   }>
//
// 核心逻辑（事务内）：
//   1. 读 WarehouseStock 现有库存 → 计算 changeQuantity
//   2. upsert WarehouseStock（目标仓的库存设为 newStock）
//   3. 重新汇总该产品全部仓库的库存 → 同步更新 Product.stockActual（大 total）
//   4. 写 MANUAL_ADJUST 流水（含 warehouseId）
// ────────────────────────────────────────────────────────────────────
router.post('/batch-adjust', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { warehouseId, items } = req.body as {
      warehouseId: number;
      items: Array<{ productId: number; newStock: number; remark?: string }>;
    };

    // ── 参数校验 ──────────────────────────────────────────────────
    if (!Number.isInteger(warehouseId) || warehouseId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId 必填且必须为正整数' });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供至少一条调库明细' });
      return;
    }
    for (const item of items) {
      if (!Number.isInteger(item.productId) || item.productId <= 0) {
        res.status(400).json({ code: 400, data: null, message: `productId ${item.productId} 无效` });
        return;
      }
      if (typeof item.newStock !== 'number' || item.newStock < 0) {
        res.status(400).json({ code: 400, data: null, message: 'newStock 必须为非负数' });
        return;
      }
    }

    // ── 校验仓库存在 ──────────────────────────────────────────────
    const warehouse = await prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) {
      res.status(400).json({ code: 400, data: null, message: `仓库 ID ${warehouseId} 不存在` });
      return;
    }

    // ── 校验产品存在 ──────────────────────────────────────────────
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isDeleted: false },
      select: { id: true, sku: true, chineseName: true },
    });
    if (products.length !== productIds.length) {
      const found = new Set(products.map((p) => p.id));
      const missing = productIds.filter((id) => !found.has(id));
      res.status(400).json({ code: 400, data: null, message: `产品 ID [${missing.join(', ')}] 不存在` });
      return;
    }
    const productMap = new Map(products.map((p) => [p.id, p]));

    // ── 预读该仓库下所有涉及产品的当前库存 ──────────────────────
    const existingStocks = await prisma.warehouseStock.findMany({
      where: { warehouseId, productId: { in: productIds } },
      select: { productId: true, stockQuantity: true },
    });
    const stockMap = new Map(existingStocks.map((s) => [s.productId, s.stockQuantity]));

    const results: Array<{
      productId: number; sku: string | null;
      warehouseId: number; warehouseName: string;
      before: number; after: number; change: number;
    }> = [];

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const prod     = productMap.get(item.productId)!;
        const before   = stockMap.get(item.productId) ?? 0;   // 该仓库原库存
        const after    = item.newStock;
        const changeQty = after - before;

        // ① upsert WarehouseStock（无论是否有变化都写入，保证记录存在）
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: item.productId, warehouseId } },
          create: { productId: item.productId, warehouseId, stockQuantity: after, lockedQuantity: 0 },
          update: { stockQuantity: after },
        });

        // ② 重新汇总该产品在所有仓库的库存 → 同步到 Product.stockActual
        const allStocks = await tx.warehouseStock.findMany({
          where:  { productId: item.productId },
          select: { stockQuantity: true },
        });
        const totalStock = allStocks.reduce((sum, s) => sum + s.stockQuantity, 0);
        await tx.product.update({
          where: { id: item.productId },
          data:  { stockActual: totalStock },
        });

        // ③ 写库存流水（changeQty = 0 时也记录盘点动作）
        await tx.inventoryLog.create({
          data: {
            productId:      item.productId,
            warehouseId,
            type:           'MANUAL_ADJUST',
            changeQuantity: changeQty,
            beforeQuantity: before,
            afterQuantity:  after,
            remark:         item.remark ?? `人工盘点（${warehouse.name}）：${before} → ${after}`,
            createdBy:      userId,
          },
        });

        results.push({
          productId:     item.productId,
          sku:           prod.sku,
          warehouseId,
          warehouseName: warehouse.name,
          before, after, change: changeQty,
        });
      }
    });

    const changed = results.filter((r) => r.change !== 0).length;
    res.json({
      code: 200,
      data: { warehouseId, warehouseName: warehouse.name, results, changed, total: results.length },
      message: `批量调库完成（${warehouse.name}）：${changed} 条变更，${results.length - changed} 条持平`,
    });
  } catch (err: any) {
    console.error('[POST /api/inventory/batch-adjust]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ────────────────────────────────────────────────────────────────────
// PUT /api/inventory/purchase-orders/:id/receive   采购单确认入库
//
// 业务逻辑（事务内）：
//   1. 检查采购单状态为 PLACED 或 IN_TRANSIT（防重复入库）
//   2. 查采购单关联的所有 Product（通过 purchaseOrderId）
//   3. 每个产品 stockActual += purchaseQuantity（默认 1）
//   4. 写 PURCHASE_IN 流水，referenceId = 采购单 orderNo
//   5. 将采购单状态更新为 RECEIVED
// ────────────────────────────────────────────────────────────────────
router.put('/purchase-orders/:id/receive', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, orderNo: true, status: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'RECEIVED') {
      res.status(400).json({ code: 400, data: null, message: '该采购单已入库，请勿重复操作' });
      return;
    }

    // 查所有关联产品
    const products = await prisma.product.findMany({
      where: { purchaseOrderId: id, isDeleted: false },
      select: { id: true, sku: true, chineseName: true, purchaseQuantity: true, stockActual: true },
    });

    if (products.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '该采购单下没有关联产品，无法入库' });
      return;
    }

    const stockChanges: Array<{ productId: number; sku: string | null; before: number; after: number; qty: number }> = [];

    await prisma.$transaction(async (tx) => {
      for (const prod of products) {
        const qty = prod.purchaseQuantity ?? 1;
        const { before, after } = await applyStockChange(tx, {
          productId:   prod.id,
          changeQuantity: qty,
          type:        'PURCHASE_IN',
          referenceId: order.orderNo,
          remark:      `采购单 ${order.orderNo} 入库`,
          createdBy:   userId,
        });
        stockChanges.push({ productId: prod.id, sku: prod.sku, before, after, qty });
      }

      // 更新采购单状态为 RECEIVED
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'RECEIVED' },
      });
    });

    const totalQty = stockChanges.reduce((s, c) => s + c.qty, 0);
    console.log(`[入库] 采购单 ${order.orderNo} 已入库，${stockChanges.length} 个 SKU，合计 +${totalQty}`);

    res.json({
      code: 200,
      data: {
        orderId: id,
        orderNo: order.orderNo,
        stockChanges,
        totalSkus: stockChanges.length,
        totalQty,
      },
      message: `采购单 ${order.orderNo} 入库成功，${stockChanges.length} 个 SKU 共增加 ${totalQty} 件库存`,
    });
  } catch (err: any) {
    console.error('[PUT /api/inventory/purchase-orders/:id/receive]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ────────────────────────────────────────────────────────────────────
// GET /api/inventory/logs   库存流水查询（分页）
// Query: page, pageSize, productId, type, referenceId
// ────────────────────────────────────────────────────────────────────
router.get('/logs', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
    const skip     = (page - 1) * pageSize;

    const where: any = {};
    if (req.query.productId) {
      const pid = parseInt(String(req.query.productId), 10);
      if (!isNaN(pid)) where.productId = pid;
    }
    if (req.query.type) {
      const t = String(req.query.type).toUpperCase();
      if (['PURCHASE_IN', 'FBE_OUT', 'MANUAL_ADJUST'].includes(t)) {
        where.type = t as InventoryLogType;
      }
    }
    if (req.query.referenceId) {
      where.referenceId = { contains: String(req.query.referenceId), mode: 'insensitive' };
    }

    const [total, list] = await prisma.$transaction([
      prisma.inventoryLog.count({ where }),
      prisma.inventoryLog.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          product: { select: { id: true, sku: true, chineseName: true, imageUrl: true } },
        },
      }),
    ]);

    res.json({ code: 200, data: { total, page, pageSize, list }, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/inventory/logs]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
