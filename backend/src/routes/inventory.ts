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
  const raw    = before + opts.changeQuantity;
  const after  = Math.max(0, raw);

  if (raw < 0) {
    console.warn(
      `[applyStockChange] ⚠️ 防负库存保护触发 | productId=${opts.productId} type=${opts.type}` +
      ` | before=${before} change=${opts.changeQuantity} → 计算值=${raw}，已强制截止为 0` +
      (opts.referenceId ? ` | refId=${opts.referenceId}` : ''),
    );
  }

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
// PUT /api/inventory/purchase-orders/:id/receive   采购单确认入库（支持分批到货）
//
// Body（均可选，不传则向后兼容使用 purchaseQuantity）：
//   warehouseId?  number   指定入库仓（未传则使用采购单绑定仓）
//   items?        Array<{ productId: number; receivedQuantity: number }>
//
// 状态流转：
//   允许起始状态：PLACED | IN_TRANSIT | PARTIAL
//   本次入库后：
//     累计 receivedQuantity >= 计划 quantity → RECEIVED（全部到货，闭环）
//     累计 receivedQuantity <  计划 quantity → PARTIAL（部分到货，等待下批）
//
// 事务逻辑：
//   ① 累加 PurchaseOrderItem.receivedQuantity（按 productIds JSON 映射）
//   ② WarehouseStock upsert：stockQuantity += 本次实盘量
//   ③ GREATEST(0, inTransitQuantity - 本次实盘量)（在途库存扣减）
//   ④ applyStockChange → stockActual 重聚合 + PURCHASE_IN 库存流水
//   ⑤ 状态判断：totalReceived >= totalPlan → RECEIVED，否则 → PARTIAL
//   ⑥ 全部到货时：产品 status → SELECTED
// ────────────────────────────────────────────────────────────────────
router.put('/purchase-orders/:id/receive', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const id = parseInt(String(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId: bodyWhId, items: receivedItems } = (req.body ?? {}) as {
      warehouseId?: number;
      items?: Array<{ productId: number; receivedQuantity: number }>;
    };

    // ── 查主单 + 子单 + 关联产品 ──────────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items:    { select: { id: true, productIds: true, quantity: true, receivedQuantity: true } },
        products: { select: { id: true, sku: true, purchaseQuantity: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 状态拦截 ──────────────────────────────────────────────────
    const RECEIVE_ALLOWED = ['PLACED', 'IN_TRANSIT', 'PARTIAL'];
    if (!RECEIVE_ALLOWED.includes(order.status)) {
      const hint = order.status === 'RECEIVED'
        ? '该采购单已全部入库，请勿重复操作'
        : `当前状态 ${order.status} 不支持入库，请先完成下单`;
      res.status(400).json({ code: 400, data: null, message: hint });
      return;
    }

    // ── 目标仓库（body > 采购单绑定仓）────────────────────────────
    const whId = bodyWhId ?? order.warehouseId ?? null;
    const wh = whId
      ? await prisma.warehouse.findUnique({ where: { id: whId }, select: { id: true, name: true } })
      : null;

    // ── 构建产品全集（FK 正常 + FK 断裂兜底）─────────────────────
    const productIdSet = new Set<number>(order.products.map((p) => p.id));
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) productIdSet.add(pid);
      } catch { /* ignore */ }
    }
    if (productIdSet.size === 0) {
      res.status(400).json({ code: 400, data: null, message: '该采购单无关联产品，无法入库' });
      return;
    }

    const knownProdMap = new Map(order.products.map((p) => [p.id, p]));
    const missingIds   = Array.from(productIdSet).filter((pid) => !knownProdMap.has(pid));
    if (missingIds.length > 0) {
      const fallback = await prisma.product.findMany({
        where:  { id: { in: missingIds } },
        select: { id: true, sku: true, purchaseQuantity: true },
      });
      for (const p of fallback) knownProdMap.set(p.id, p);
    }
    const allProducts = Array.from(knownProdMap.values());

    // ── 本次实盘量 Map（未传则兜底用 purchaseQuantity）────────────
    const receivedMap = new Map<number, number>();
    if (Array.isArray(receivedItems) && receivedItems.length > 0) {
      for (const ri of receivedItems) {
        if (ri.receivedQuantity <= 0) {
          res.status(400).json({ code: 400, data: null, message: `productId=${ri.productId} 的入库数量必须 > 0` });
          return;
        }
        receivedMap.set(ri.productId, ri.receivedQuantity);
      }
    } else {
      for (const prod of allProducts) {
        receivedMap.set(prod.id, Math.max(1, prod.purchaseQuantity ?? 1));
      }
    }

    // ── productId → PurchaseOrderItem 映射（含计划量和已收量） ──
    const productToItemMap = new Map<number, number>();          // productId → itemId
    const productToItemData = new Map<number, { quantity: number; receivedQuantity: number }>(); // 用于防超收
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          if (!productToItemMap.has(pid)) {
            productToItemMap.set(pid, item.id);
            productToItemData.set(pid, { quantity: item.quantity, receivedQuantity: item.receivedQuantity });
          }
        }
      } catch { /* ignore */ }
    }

    // ★★★ 防超收硬拦截：本次入库量 + 已入库量 不可超过计划采购量 ★★★
    const overReceiveErrors: string[] = [];
    for (const [productId, thisQty] of receivedMap.entries()) {
      const itemData = productToItemData.get(productId);
      if (!itemData) continue;
      const alreadyReceived = itemData.receivedQuantity;
      const planQty         = itemData.quantity;
      if (alreadyReceived + thisQty > planQty) {
        const prod = allProducts.find((p) => p.id === productId);
        overReceiveErrors.push(
          `SKU [${prod?.sku ?? productId}]：本次入库 ${thisQty} + 已入库 ${alreadyReceived} = ${alreadyReceived + thisQty}，超出计划采购量 ${planQty}`,
        );
      }
    }
    if (overReceiveErrors.length > 0) {
      res.status(400).json({
        code:    400,
        data:    null,
        message: `入库总数不可超过采购总数，拒绝超收！\n${overReceiveErrors.join('\n')}`,
      });
      return;
    }

    const stockChanges: Array<{ productId: number; sku: string | null; receivedQty: number; before: number; after: number }> = [];

    await prisma.$transaction(async (tx) => {
      for (const prod of allProducts) {
        const receivedQty = receivedMap.get(prod.id) ?? 0;
        if (receivedQty <= 0) continue;

        // ① 累加 PurchaseOrderItem.receivedQuantity
        const itemId = productToItemMap.get(prod.id);
        if (itemId) {
          await tx.purchaseOrderItem.update({
            where: { id: itemId },
            data:  { receivedQuantity: { increment: receivedQty } },
          });
        }

        // ② WarehouseStock upsert（有仓库时才操作）
        if (whId) {
          await tx.warehouseStock.upsert({
            where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
            create: { productId: prod.id, warehouseId: whId, stockQuantity: receivedQty, inTransitQuantity: 0 },
            update: { stockQuantity: { increment: receivedQty } },
          });

          // ③ 扣减在途库存（GREATEST 防负数）
          await tx.$executeRaw`
            UPDATE warehouse_stocks
            SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${receivedQty})
            WHERE  product_id = ${prod.id}
            AND    warehouse_id = ${whId}
          `;
        }

        // ④ stockActual 重聚合 + 写 PURCHASE_IN 流水
        const planQty  = prod.purchaseQuantity ?? 1;
        const diffNote = receivedQty !== planQty ? `（计划 ${planQty} 件，本次实收 ${receivedQty} 件）` : '';
        const { before, after } = await applyStockChange(tx, {
          productId:      prod.id,
          warehouseId:    whId ?? null,
          changeQuantity: receivedQty,
          type:           'PURCHASE_IN',
          referenceId:    order.orderNo,
          remark:         `采购单 ${order.orderNo} 入库${diffNote}${wh ? `（仓库: ${wh.name}）` : ''}`,
          createdBy:      userId,
        });
        stockChanges.push({ productId: prod.id, sku: prod.sku, receivedQty, before, after });
      }

      // ⑤ 读取所有子单最新累计量，判断 PARTIAL 还是 RECEIVED
      const updatedItems = await tx.purchaseOrderItem.findMany({
        where:  { purchaseOrderId: id },
        select: { quantity: true, receivedQuantity: true },
      });
      const totalPlan     = updatedItems.reduce((s, i) => s + i.quantity,         0);
      const totalReceived = updatedItems.reduce((s, i) => s + i.receivedQuantity, 0);

      // ★ 核心状态判断：这里才是 PARTIAL / RECEIVED 的分岔口
      const newStatus = totalReceived >= totalPlan ? 'RECEIVED' : 'PARTIAL';

      await tx.purchaseOrder.update({
        where: { id },
        data:  {
          status:      newStatus as any,
          warehouseId: whId ?? order.warehouseId,
        },
      });

      // ⑥ 全部到货时：产品回归正常在售态
      if (newStatus === 'RECEIVED' && allProducts.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: allProducts.map((p) => p.id) } },
          data:  { status: 'SELECTED' },
        });
      }
    });

    // 读取事务提交后的最终状态
    const finalOrder  = await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } });
    const finalStatus = finalOrder?.status ?? 'PARTIAL';
    const totalReceivedQty = stockChanges.reduce((s, c) => s + c.receivedQty, 0);

    console.log(
      `[receive] 采购单 ${order.orderNo} 入库 → status=${finalStatus}，` +
      `${stockChanges.length} SKU 合计实收 ${totalReceivedQty} 件`,
    );

    res.json({
      code: 200,
      data: {
        orderId:         id,
        orderNo:         order.orderNo,
        status:          finalStatus,
        warehouse:       wh ?? null,
        stockedSkuCount: stockChanges.length,
        totalQuantity:   totalReceivedQty,
        details:         stockChanges,
        isPartial:       finalStatus === 'PARTIAL',
      },
      message: finalStatus === 'RECEIVED'
        ? `采购单 ${order.orderNo} 全部入库完成（${stockChanges.length} 个 SKU 共 ${totalReceivedQty} 件）`
        : `本次入库 ${totalReceivedQty} 件，采购单部分到货（PARTIAL），可继续入库或强制结单`,
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
