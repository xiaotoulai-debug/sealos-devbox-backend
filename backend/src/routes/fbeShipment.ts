/**
 * FBE 发货单 API（4 阶段仓储状态机）
 *
 * 状态机流转规则：
 *   PENDING     → ALLOCATING  : 仅改单据状态，无库存变动
 *   ALLOCATING  → SHIPPED     : ★强校验 stockActual >= quantity；通过后扣本地库存 + 加在途
 *   SHIPPED     → ARRIVED     : 扣在途库存（inTransitQuantity -），回填 receivedQuantity
 *   PENDING/ALLOCATING → CANCELLED : 无库存变动
 *   SHIPPED     → CANCELLED   : 撤销在途（inTransitQuantity -），归还本地库存（stockActual +）
 *
 * 进销存联动（ALLOCATING→SHIPPED）：
 *   ① 检查每个 SKU: stockActual >= 发货数量，否则 throw，事务回滚
 *   ② stockActual -= quantity，写 FBE_OUT InventoryLog 流水
 *   ③ inTransitQuantity += quantity
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { FbeShipmentStatus } from '@prisma/client';
import { applyStockChange } from './inventory';

const router = Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────
// 工具：生成唯一发货单号  FBE-YYYYMMDD-XXXX（当日自增序号）
// ─────────────────────────────────────────────────────────────────────
async function generateShipmentNumber(): Promise<string> {
  const date = new Date();
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const prefix = `FBE-${datePart}-`;

  const last = await prisma.fbeShipment.findFirst({
    where: { shipmentNumber: { startsWith: prefix } },
    orderBy: { shipmentNumber: 'desc' },
    select: { shipmentNumber: true },
  });
  const seq = last ? parseInt(last.shipmentNumber.slice(prefix.length), 10) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────
// 合法状态流转表（4 阶段状态机）
// ─────────────────────────────────────────────────────────────────────
const VALID_TRANSITIONS: Record<FbeShipmentStatus, FbeShipmentStatus[]> = {
  PENDING:    ['ALLOCATING', 'CANCELLED'],
  ALLOCATING: ['SHIPPED',    'CANCELLED'],
  SHIPPED:    ['ARRIVED',    'CANCELLED'],
  ARRIVED:    [],
  CANCELLED:  [],
};

const ALL_STATUSES = ['PENDING', 'ALLOCATING', 'SHIPPED', 'ARRIVED', 'CANCELLED'];

// ─────────────────────────────────────────────────────────────────────
// POST /api/fbe-shipments   创建发货单
// Body:
//   shopId: number                必填，发货目标店铺
//   warehouseId?: number          出库仓库 ID（多仓架构，传入时执行 WarehouseStock 强校验+锁定）
//   shipmentNumber?: string       自定义单号（不传则自动生成）
//   remark?: string
//   items: [{ sku, quantity, productId? }]
//
// 防呆①: 所有 SKU 必须在本地 Product 表中存在
// 防呆②: 所有 SKU 必须已绑定到目标 shopId 的平台产品
// 防呆③(多仓): 若传 warehouseId，检查 WarehouseStock.stockQuantity - lockedQuantity >= quantity
// 锁仓: 创建成功后将 PENDING 阶段的出库量锁入 lockedQuantity，防止并发超发
// ─────────────────────────────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { shopId, warehouseId, shipmentNumber: customNumber, remark, items } = req.body as {
      shopId?: number;
      warehouseId?: number;
      shipmentNumber?: string;
      remark?: string;
      items: Array<{ sku: string; quantity: number; productId?: number }>;
    };

    // ── 必填校验 ─────────────────────────────────────────────────────
    if (!shopId || !Number.isInteger(shopId) || shopId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'shopId 必填且必须为有效店铺 ID' });
      return;
    }
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请至少添加一个发货明细' });
      return;
    }
    for (const item of items) {
      if (!item.sku || typeof item.sku !== 'string' || !item.sku.trim()) {
        res.status(400).json({ code: 400, data: null, message: 'items 中每条记录必须提供有效的 sku' });
        return;
      }
      if (!item.quantity || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        res.status(400).json({ code: 400, data: null, message: 'quantity 必须为正整数' });
        return;
      }
    }

    // ── 校验店铺存在 ──────────────────────────────────────────────────
    const shop = await prisma.shopAuthorization.findUnique({
      where: { id: shopId },
      select: { id: true, shopName: true },
    });
    if (!shop) {
      res.status(400).json({ code: 400, data: null, message: `店铺 ID ${shopId} 不存在` });
      return;
    }

    // ── 校验出库仓库存在（若传入）────────────────────────────────────
    const validWarehouseId = Number.isInteger(warehouseId) && (warehouseId as number) > 0
      ? (warehouseId as number)
      : null;

    if (validWarehouseId !== null) {
      const wh = await prisma.warehouse.findUnique({
        where: { id: validWarehouseId },
        select: { id: true, name: true, status: true },
      });
      if (!wh) {
        res.status(400).json({ code: 400, data: null, message: `仓库 ID ${validWarehouseId} 不存在` });
        return;
      }
      if (wh.status !== 'ACTIVE') {
        res.status(400).json({ code: 400, data: null, message: `仓库「${wh.name}」已停用，无法出库` });
        return;
      }
    }

    // ── 以 SKU 为桥梁查询本地 Product 表 ────────────────────────────
    const skus = [...new Set(items.map((i) => i.sku.trim()))];
    const products = await prisma.product.findMany({
      where: { sku: { in: skus }, isDeleted: false },
      select: { id: true, sku: true, chineseName: true, stockActual: true, purchasePrice: true },
    });

    const foundSkuSet = new Set(products.map((p) => p.sku!));
    const missingSkus = skus.filter((s) => !foundSkuSet.has(s));
    if (missingSkus.length > 0) {
      res.status(400).json({
        code: 400, data: null,
        message: `SKU [${missingSkus.join(', ')}] 在本地库存中不存在，请先在【库存 SKU】页面创建对应产品`,
      });
      return;
    }

    // ── 跨店铺防呆：SKU 必须已绑定到目标店铺 ───────────────────────
    const skusInShop = await prisma.storeProduct.findMany({
      where: { shopId, mappedInventorySku: { in: skus } },
      select: { mappedInventorySku: true },
    });
    const mappedSkuSet = new Set(skusInShop.map((s) => s.mappedInventorySku as string));
    const notMapped = products
      .filter((p) => !mappedSkuSet.has(p.sku!))
      .map((p) => `SKU [${p.sku}]（${p.chineseName ?? '无中文名'}）`);
    if (notMapped.length > 0) {
      res.status(400).json({
        code: 400, data: null,
        message: `以下产品未关联到店铺「${shop.shopName}」，请先在平台产品页绑定 SKU 后再建单：\n${notMapped.join('\n')}`,
      });
      return;
    }

    // ── 多仓强校验：检查指定仓库的可用库存（stockQuantity - lockedQuantity）──
    const skuToProductId    = new Map(products.map((p) => [p.sku!, p.id]));
    const skuToPurchasePrice = new Map(products.map((p) => [p.sku!, Number(p.purchasePrice ?? 0)]));

    if (validWarehouseId !== null) {
      const productIds = products.map((p) => p.id);
      const whStocks = await prisma.warehouseStock.findMany({
        where: { warehouseId: validWarehouseId, productId: { in: productIds } },
        select: { productId: true, stockQuantity: true, lockedQuantity: true },
      });
      const whStockMap = new Map(whStocks.map((s) => [s.productId, s]));

      // SKU → productId → WarehouseStock 可用量校验
      const insufficient: string[] = [];
      for (const item of items) {
        const productId = skuToProductId.get(item.sku.trim())!;
        const ws        = whStockMap.get(productId);
        const available = ws ? ws.stockQuantity - ws.lockedQuantity : 0;
        if (available < item.quantity) {
          insufficient.push(
            `SKU [${item.sku}] 仓库可用库存 ${available.toFixed(0)} < 需出库 ${item.quantity}`,
          );
        }
      }
      if (insufficient.length > 0) {
        res.status(400).json({
          code: 400, data: null,
          message: `库存不足，无法建单：\n${insufficient.join('\n')}`,
        });
        return;
      }
    }

    // ── 自定义单号去重 ────────────────────────────────────────────────
    let finalNumber: string;
    if (customNumber?.trim()) {
      const exists = await prisma.fbeShipment.findUnique({ where: { shipmentNumber: customNumber.trim() } });
      if (exists) {
        res.status(400).json({ code: 400, data: null, message: `单号 "${customNumber.trim()}" 已存在，请换一个` });
        return;
      }
      finalNumber = customNumber.trim();
    } else {
      finalNumber = await generateShipmentNumber();
    }

    // ── 快照货值：Σ(item.quantity × product.purchasePrice)────────────
    // 建单时冻结，防止未来采购价变动影响历史单据核算
    const totalProductValue = items.reduce((sum, item) => {
      const price = skuToPurchasePrice.get(item.sku.trim()) ?? 0;
      return sum + item.quantity * price;
    }, 0);

    // ── 事务：创建发货单 + 锁定 WarehouseStock.lockedQuantity ────────
    const shipment = await prisma.$transaction(async (tx) => {
      const s = await tx.fbeShipment.create({
        data: {
          shipmentNumber:    finalNumber,
          shopId,
          warehouseId:       validWarehouseId,
          totalProductValue: parseFloat(totalProductValue.toFixed(2)),
          remark:            remark ?? null,
          ownerId:           userId,
          items: {
            create: items.map((i) => ({
              productId:        skuToProductId.get(i.sku.trim())!,
              quantity:         i.quantity,
              receivedQuantity: 0,
            })),
          },
        },
        include: {
          items: {
            include: {
              product: { select: { id: true, sku: true, chineseName: true, imageUrl: true, stockActual: true } },
            },
          },
          shop:      { select: { id: true, shopName: true, region: true } },
          warehouse: { select: { id: true, name: true, type: true } },
          owner:     { select: { id: true, name: true } },
        },
      });

      // 锁仓：PENDING 阶段将出库量计入 lockedQuantity，防止并发超发
      if (validWarehouseId !== null) {
        for (const item of items) {
          const productId = skuToProductId.get(item.sku.trim())!;
          await tx.warehouseStock.upsert({
            where:  { productId_warehouseId: { productId, warehouseId: validWarehouseId } },
            create: { productId, warehouseId: validWarehouseId, stockQuantity: 0, lockedQuantity: item.quantity },
            update: { lockedQuantity: { increment: item.quantity } },
          });
        }
      }

      return s;
    });

    res.json({ code: 200, data: shipment, message: '发货单创建成功' });
  } catch (err: any) {
    const msg: string = err?.message ?? '服务器内部错误';
    if (msg.startsWith('库存不足')) {
      res.status(400).json({ code: 400, data: null, message: msg });
    } else {
      console.error('[FBE] 创建发货单失败:', msg);
      res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/fbe-shipments   发货单列表（含明细）
// Query: page, pageSize, status, shipmentNumber
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
    const skip     = (page - 1) * pageSize;

    const where: any = {};
    if (req.query.status) {
      const s = String(req.query.status).toUpperCase();
      if (ALL_STATUSES.includes(s)) {
        where.status = s as FbeShipmentStatus;
      }
    }
    if (req.query.shipmentNumber) {
      where.shipmentNumber = { contains: String(req.query.shipmentNumber), mode: 'insensitive' };
    }
    if (req.query.shopId) {
      const sid = parseInt(String(req.query.shopId), 10);
      if (!isNaN(sid)) where.shopId = sid;
    }

    const [total, rawList] = await prisma.$transaction([
      prisma.fbeShipment.count({ where }),
      prisma.fbeShipment.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true, sku: true, pnk: true, chineseName: true, title: true,
                  imageUrl: true, stockActual: true, inTransitQuantity: true,
                  purchasePrice: true,
                  // 各仓库存明细，前端列表行可直接计算可用库存
                  warehouseStocks: {
                    select: {
                      id: true, warehouseId: true, stockQuantity: true,
                      lockedQuantity: true, inTransitQuantity: true, unitCost: true,
                      warehouse: { select: { id: true, name: true, type: true, status: true } },
                    },
                  },
                },
              },
            },
          },
          shop:      { select: { id: true, shopName: true, region: true } },
          warehouse: { select: { id: true, name: true, type: true, status: true } },
          owner:     { select: { id: true, name: true } },
        },
      }),
    ]);

    // 追加前端列表页所需的聚合字段：产品款数 & 发货总量
    const list = rawList.map((s) => ({
      ...s,
      productCount:  s.items.length,
      totalQuantity: s.items.reduce((sum, i) => sum + i.quantity, 0),
    }));

    res.json({ code: 200, data: { total, page, pageSize, list }, message: 'success' });
  } catch (err: any) {
    console.error('[FBE] 获取发货单列表失败:', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/fbe-shipments/:id   发货单详情
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id    = parseInt(rawId, 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    const raw = await prisma.fbeShipment.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, pnk: true, sku: true, title: true, chineseName: true,
                imageUrl: true, brand: true, category: true,
                purchasePrice: true, stockActual: true, inTransitQuantity: true,
                // 带出各仓库存，前端详情页可计算实时剩余库存
                warehouseStocks: {
                  select: {
                    id: true, warehouseId: true, stockQuantity: true,
                    lockedQuantity: true, inTransitQuantity: true, unitCost: true,
                    warehouse: { select: { id: true, name: true, type: true, status: true } },
                  },
                },
              },
            },
          },
        },
        shop:      { select: { id: true, shopName: true, region: true } },
        warehouse: { select: { id: true, name: true, type: true, status: true } },
        owner:     { select: { id: true, name: true } },
      },
    });

    if (!raw) {
      res.status(404).json({ code: 404, data: null, message: '发货单不存在' });
      return;
    }

    const shipment = {
      ...raw,
      productCount:  raw.items.length,
      totalQuantity: raw.items.reduce((sum, i) => sum + i.quantity, 0),
    };
    res.json({ code: 200, data: shipment, message: 'success' });
  } catch (err: any) {
    console.error('[FBE] 获取发货单详情失败:', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/fbe-shipments/:id   编辑发货单（单号 / 备注 / 明细数量）
// Body: { shipmentNumber?, remark?, items?: [{ id: itemId, quantity: newQty }] }
// 防呆：仅 PENDING 或 ALLOCATING 状态允许编辑
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id    = parseInt(rawId, 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    const current = await prisma.fbeShipment.findUnique({
      where: { id },
      select: { id: true, status: true, shipmentNumber: true },
    });
    if (!current) {
      res.status(404).json({ code: 404, data: null, message: '发货单不存在' });
      return;
    }

    // 核心防呆：只有 PENDING / ALLOCATING 允许改单号和数量
    if (!['PENDING', 'ALLOCATING'].includes(current.status)) {
      res.status(400).json({
        code: 400,
        data: null,
        message: `当前状态为 ${current.status}，不允许编辑。仅"待处理"或"配货中"状态可修改`,
      });
      return;
    }

    const { shipmentNumber, remark, items } = req.body as {
      shipmentNumber?: string;
      remark?: string;
      items?: Array<{ id: number; quantity: number }>;
    };

    // ── 单号唯一性校验 ──────────────────────────────────────────────
    const updateData: any = {};
    if (shipmentNumber !== undefined && shipmentNumber.trim() !== '') {
      const trimmed = shipmentNumber.trim();
      if (trimmed !== current.shipmentNumber) {
        const exists = await prisma.fbeShipment.findUnique({ where: { shipmentNumber: trimmed } });
        if (exists) {
          res.status(400).json({ code: 400, data: null, message: `单号 "${trimmed}" 已被占用` });
          return;
        }
        updateData.shipmentNumber = trimmed;
      }
    }
    if (remark !== undefined) {
      updateData.remark = remark || null;
    }

    // ── 事务：更新主单 + 更新明细数量 ────────────────────────────────
    await prisma.$transaction(async (tx) => {
      if (Object.keys(updateData).length > 0) {
        await tx.fbeShipment.update({ where: { id }, data: updateData });
      }
      if (Array.isArray(items) && items.length > 0) {
        for (const item of items) {
          if (!item.id || !Number.isInteger(item.id)) continue;
          if (!item.quantity || !Number.isInteger(item.quantity) || item.quantity <= 0) {
            throw new Error(`明细 ID ${item.id} 的 quantity 必须为正整数`);
          }
          await tx.fbeShipmentItem.update({
            where: { id: item.id },
            data:  { quantity: item.quantity },
          });
        }
      }
    });

    // 返回更新后的完整数据
    const updated = await prisma.fbeShipment.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, pnk: true, sku: true, title: true, chineseName: true,
                imageUrl: true, stockActual: true, inTransitQuantity: true,
              },
            },
          },
        },
        shop:  { select: { id: true, shopName: true, region: true } },
        owner: { select: { id: true, name: true } },
      },
    });

    const result = updated ? {
      ...updated,
      productCount:  updated.items.length,
      totalQuantity: updated.items.reduce((sum, i) => sum + i.quantity, 0),
    } : null;

    res.json({ code: 200, data: result, message: '发货单更新成功' });
  } catch (err: any) {
    const msg = err?.message ?? '服务器内部错误';
    if (msg.includes('quantity')) {
      res.status(400).json({ code: 400, data: null, message: msg });
    } else {
      console.error('[FBE] 编辑发货单失败:', msg);
      res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/fbe-shipments/:id/status   状态流转（核心业务逻辑）
// Body: { status: 'ALLOCATING' | 'SHIPPED' | 'ARRIVED' | 'CANCELLED' }
//
// 关键防呆规则（ALLOCATING → SHIPPED）：
//   遍历明细，逐一检查 stockActual >= quantity。
//   任何一个不满足 → 抛出详细错误，事务自动回滚，库存零损耗。
// ─────────────────────────────────────────────────────────────────────
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const rawId    = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id       = parseInt(rawId, 10);
    const userId   = req.user!.userId;

    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    const newStatus = String(req.body?.status ?? '').toUpperCase() as FbeShipmentStatus;
    if (!ALL_STATUSES.includes(newStatus)) {
      res.status(400).json({
        code: 400, data: null,
        message: `无效的状态值，合法值: ${ALL_STATUSES.join(' / ')}`,
      });
      return;
    }

    // 查当前发货单（含明细 + 出库仓库）
    const current = await prisma.fbeShipment.findUnique({
      where: { id },
      include: {
        items: { select: { id: true, productId: true, quantity: true } },
      },
    });

    if (!current) {
      res.status(404).json({ code: 404, data: null, message: '发货单不存在' });
      return;
    }

    const currentStatus = current.status;
    if (currentStatus === newStatus) {
      res.status(400).json({ code: 400, data: null, message: `当前已经是 ${newStatus} 状态` });
      return;
    }

    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      res.status(400).json({
        code: 400, data: null,
        message: `不允许从 ${currentStatus} 流转到 ${newStatus}。合法下一步: [${allowed.join(', ') || '无'}]`,
      });
      return;
    }

    // ─── 事务执行状态更新 + 库存联动 ──────────────────────────────
    const updated = await prisma.$transaction(async (tx) => {
      // ── 更新单据状态 ─────────────────────────────────────────────
      const shipment = await tx.fbeShipment.update({
        where: { id },
        data: { status: newStatus },
      });

      const whId = current.warehouseId;   // 出库仓库（null = 老数据兼容，走旧逻辑）

      if (newStatus === 'ALLOCATING') {
        // ① PENDING → ALLOCATING：仅改状态，无库存变动
        console.log(`[FBE] #${id}(${current.shipmentNumber}) PENDING→ALLOCATING，等待配货`);

      } else if (newStatus === 'SHIPPED') {
        // ② ALLOCATING → SHIPPED（★ 核心出库路径）
        const productIds = current.items.map((i) => i.productId);

        if (whId !== null) {
          // ── 多仓模式：基于 WarehouseStock 强校验 + 扣减 ────────────
          const whStocks = await tx.warehouseStock.findMany({
            where:  { warehouseId: whId, productId: { in: productIds } },
            select: { productId: true, stockQuantity: true, lockedQuantity: true },
          });
          const prodSkuMap = new Map(
            (await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }))
              .map((p) => [p.id, p.sku]),
          );
          const whStockMap = new Map(whStocks.map((s) => [s.productId, s]));

          // a. 校验锁定库存：ALLOCATING→SHIPPED 时库存已在建单/配货时被 lockedQuantity 占位，
          //    此处只需确认 lockedQuantity >= 发货量（确保之前确实锁了足量货）。
          //    ★ 不能再用 stockQuantity - lockedQuantity（可用量），那是给"新建单"用的校验，
          //       对已锁定订单来说可用量永远是 0，会产生死锁报错。
          const insufficient: string[] = [];
          for (const item of current.items) {
            const ws     = whStockMap.get(item.productId);
            const locked = ws?.lockedQuantity ?? 0;
            const stock  = ws?.stockQuantity  ?? 0;
            if (locked < item.quantity) {
              insufficient.push(
                `SKU [${prodSkuMap.get(item.productId) ?? `#${item.productId}`}] ` +
                `锁定量 ${locked} < 需发 ${item.quantity}（物理库存 ${stock}）`,
              );
            }
          }
          if (insufficient.length > 0) {
            throw new Error(`库存锁定量不足，无法发货：\n${insufficient.join('\n')}`);
          }

          // b. 扣减 WarehouseStock + 释放本次锁定 + 同步 Product.stockActual + 写流水
          let totalQty = 0;
          for (const item of current.items) {
            // 扣减仓库库存，同时释放锁定量
            await tx.warehouseStock.update({
              where: { productId_warehouseId: { productId: item.productId, warehouseId: whId } },
              data: {
                stockQuantity:  { decrement: item.quantity },
                lockedQuantity: { decrement: item.quantity },  // 释放 PENDING 时锁定的量
              },
            });
            // 重新汇总全仓 → 同步 Product.stockActual
            const allWs = await tx.warehouseStock.findMany({
              where:  { productId: item.productId },
              select: { stockQuantity: true },
            });
            const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
            await tx.product.update({
              where: { id: item.productId },
              data:  { stockActual: totalStock, inTransitQuantity: { increment: item.quantity } },
            });
            // 写 FBE_OUT 流水
            await applyStockChange(tx, {
              productId:      item.productId,
              warehouseId:    whId,
              changeQuantity: -item.quantity,
              type:           'FBE_OUT',
              referenceId:    String(id),
              remark:         `FBE 发货单 ${current.shipmentNumber} 出库（仓库 #${whId}）`,
              createdBy:      userId,
            });
            totalQty += item.quantity;
          }
          console.log(
            `[FBE] #${id}(${current.shipmentNumber}) ALLOCATING→SHIPPED（多仓 warehouseId=${whId}），` +
            `${current.items.length} SKU 合计出库 ${totalQty}，在途 +${totalQty}`,
          );

        } else {
          // ── 兼容模式：无 warehouseId，沿用旧的 Product.stockActual 逻辑 ──
          const stocks = await tx.product.findMany({
            where:  { id: { in: productIds } },
            select: { id: true, sku: true, stockActual: true },
          });
          const stockMap = new Map(stocks.map((s) => [s.id, s]));

          const insufficient: string[] = [];
          for (const item of current.items) {
            const prod = stockMap.get(item.productId);
            if ((prod?.stockActual ?? 0) < item.quantity) {
              insufficient.push(
                `SKU [${prod?.sku ?? `#${item.productId}`}] 库存 ${prod?.stockActual ?? 0} < 需发货 ${item.quantity}`,
              );
            }
          }
          if (insufficient.length > 0) throw new Error(`库存不足，无法发货：\n${insufficient.join('\n')}`);

          let totalQty = 0;
          for (const item of current.items) {
            await applyStockChange(tx, {
              productId:      item.productId,
              changeQuantity: -item.quantity,
              type:           'FBE_OUT',
              referenceId:    String(id),
              remark:         `FBE 发货单 ${current.shipmentNumber} 出库`,
              createdBy:      userId,
            });
            await tx.product.update({
              where: { id: item.productId },
              data:  { inTransitQuantity: { increment: item.quantity } },
            });
            totalQty += item.quantity;
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) ALLOCATING→SHIPPED（兼容模式），合计出库 ${totalQty}`);
        }

      } else if (newStatus === 'ARRIVED') {
        // ③ SHIPPED → ARRIVED：扣在途库存 + 回填实收数量
        let totalQty = 0;
        for (const item of current.items) {
          const prod = await tx.product.findUnique({
            where:  { id: item.productId },
            select: { inTransitQuantity: true },
          });
          const safeDecrement = Math.min(item.quantity, prod?.inTransitQuantity ?? 0);
          await tx.product.update({
            where: { id: item.productId },
            data:  { inTransitQuantity: { decrement: safeDecrement } },
          });
          await tx.fbeShipmentItem.update({
            where: { id: item.id },
            data:  { receivedQuantity: item.quantity },
          });
          totalQty += safeDecrement;
        }
        console.log(`[FBE] #${id}(${current.shipmentNumber}) SHIPPED→ARRIVED，在途清账 -${totalQty}`);

      } else if (newStatus === 'CANCELLED') {
        if (currentStatus === 'SHIPPED') {
          // ④a SHIPPED → CANCELLED：撤销在途 + 归还本地库存
          let totalQty = 0;
          for (const item of current.items) {
            const prod = await tx.product.findUnique({
              where:  { id: item.productId },
              select: { inTransitQuantity: true },
            });
            const safeDecrement = Math.min(item.quantity, prod?.inTransitQuantity ?? 0);

            if (whId !== null) {
              // 多仓：归还至 WarehouseStock
              await tx.warehouseStock.update({
                where: { productId_warehouseId: { productId: item.productId, warehouseId: whId } },
                data:  { stockQuantity: { increment: item.quantity } },
              });
              const allWs = await tx.warehouseStock.findMany({
                where:  { productId: item.productId },
                select: { stockQuantity: true },
              });
              const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
              await tx.product.update({
                where: { id: item.productId },
                data:  { stockActual: totalStock, inTransitQuantity: { decrement: safeDecrement } },
              });
            } else {
              await tx.product.update({
                where: { id: item.productId },
                data:  { inTransitQuantity: { decrement: safeDecrement } },
              });
            }
            await applyStockChange(tx, {
              productId:      item.productId,
              warehouseId:    whId,
              changeQuantity: +item.quantity,
              type:           'MANUAL_ADJUST',
              referenceId:    String(id),
              remark:         `FBE 发货单 ${current.shipmentNumber} 取消，退回本地库存`,
              createdBy:      userId,
            });
            totalQty += item.quantity;
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) SHIPPED→CANCELLED，在途撤销 -${totalQty}，库存 +${totalQty}`);

        } else {
          // ④b PENDING/ALLOCATING → CANCELLED：释放锁定量（多仓模式）
          if (whId !== null) {
            for (const item of current.items) {
              await tx.warehouseStock.updateMany({
                where: { productId: item.productId, warehouseId: whId },
                data:  { lockedQuantity: { decrement: item.quantity } },
              });
            }
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) ${currentStatus}→CANCELLED，锁定量已释放`);
        }
      }

      return shipment;
    });

    res.json({ code: 200, data: updated, message: `发货单 ${current.shipmentNumber} 状态已更新为 ${newStatus}` });
  } catch (err: any) {
    const msg: string = err?.message ?? '服务器内部错误';
    // 库存不足是业务错误，400 返回给前端
    if (msg.startsWith('库存不足')) {
      res.status(400).json({ code: 400, data: null, message: msg });
    } else {
      console.error('[FBE] 更新发货单状态失败:', msg);
      res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/fbe-shipments/:id/costs   登记/更新运费
//
// 接收：{ overseasFreight?, domesticFreight? }（两者均可选，至少传一个）
// 任意状态的发货单均可更新费用（运费往往在发货后才能确认）
// ─────────────────────────────────────────────────────────────────────
router.patch('/:id/costs', async (req: Request, res: Response) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id    = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    const { overseasFreight, domesticFreight } = req.body ?? {};

    // 至少需要传入一个费用字段
    const hasOverseas  = overseasFreight  !== undefined && overseasFreight  !== null;
    const hasDomestic  = domesticFreight  !== undefined && domesticFreight  !== null;
    if (!hasOverseas && !hasDomestic) {
      res.status(400).json({
        code: 400, data: null,
        message: '至少需要提供 overseasFreight（海外头程）或 domesticFreight（国内运费）中的一个',
      });
      return;
    }

    // 数值校验
    if (hasOverseas && (isNaN(Number(overseasFreight)) || Number(overseasFreight) < 0)) {
      res.status(400).json({ code: 400, data: null, message: 'overseasFreight 必须是非负数' });
      return;
    }
    if (hasDomestic && (isNaN(Number(domesticFreight)) || Number(domesticFreight) < 0)) {
      res.status(400).json({ code: 400, data: null, message: 'domesticFreight 必须是非负数' });
      return;
    }

    // 确认发货单存在
    const exists = await prisma.fbeShipment.findUnique({
      where:  { id },
      select: { id: true, shipmentNumber: true, totalProductValue: true, overseasFreight: true, domesticFreight: true },
    });
    if (!exists) {
      res.status(404).json({ code: 404, data: null, message: '发货单不存在' });
      return;
    }

    // 构建更新数据（仅更新传入的字段）
    const updateData: { overseasFreight?: number; domesticFreight?: number } = {};
    if (hasOverseas) updateData.overseasFreight = parseFloat(Number(overseasFreight).toFixed(2));
    if (hasDomestic) updateData.domesticFreight = parseFloat(Number(domesticFreight).toFixed(2));

    const updated = await prisma.fbeShipment.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, shipmentNumber: true, status: true,
        totalProductValue: true, overseasFreight: true, domesticFreight: true,
      },
    });

    // 总费用快速汇总（方便前端展示）
    const totalCost = parseFloat(
      (updated.totalProductValue + updated.overseasFreight + updated.domesticFreight).toFixed(2),
    );

    console.log(
      `[FBE-COSTS] 发货单 #${id}(${updated.shipmentNumber}) 费用更新：` +
      `货值=${updated.totalProductValue} 海运=${updated.overseasFreight} 国内运=${updated.domesticFreight} 合计=${totalCost}`,
    );

    res.json({
      code: 200,
      data: { ...updated, totalCost },
      message: '费用登记成功',
    });
  } catch (err: any) {
    console.error('[PATCH /api/fbe-shipments/:id/costs]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/fbe-shipments/:id   超管专属删除（含库存回滚）
//
// 权限：requireSuperAdmin — 非超管直接 403
//
// 库存回滚规则（按当前状态）：
//   PENDING / ALLOCATING → 释放 WarehouseStock.lockedQuantity
//   SHIPPED              → 归还 WarehouseStock.stockQuantity + 扣减 inTransitQuantity
//   ARRIVED / CANCELLED  → 库存已结算，无需回滚
//
// 事务顺序：
//   ① 库存回滚（WarehouseStock / Product）
//   ② 删除 FbeShipmentItem（onDelete:Cascade 也可自动，但显式更安全）
//   ③ 删除 FbeShipment 主表
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id    = parseInt(rawId, 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    // ── 查单（含明细 + 状态 + 出库仓库）──────────────────────────
    const shipment = await prisma.fbeShipment.findUnique({
      where: { id },
      include: {
        items: { select: { id: true, productId: true, quantity: true } },
      },
    });
    if (!shipment) {
      res.status(404).json({ code: 404, data: null, message: '发货单不存在' });
      return;
    }

    const { status, warehouseId, shipmentNumber, items } = shipment;

    // ── 事务：库存回滚 + 级联删除 ─────────────────────────────────
    await prisma.$transaction(async (tx) => {

      // ① 库存回滚：根据当前状态决定回滚方式
      if (warehouseId !== null) {
        // ── 多仓模式 ─────────────────────────────────────────────
        if (status === 'PENDING' || status === 'ALLOCATING') {
          // 释放锁定量（创建时已 lockedQuantity += qty）
          for (const item of items) {
            await tx.warehouseStock.updateMany({
              where: { productId: item.productId, warehouseId },
              data:  { lockedQuantity: { decrement: item.quantity } },
            });
          }
          console.log(`[FBE-DEL] #${id}(${shipmentNumber}) ${status}，释放 lockedQuantity`);

        } else if (status === 'SHIPPED') {
          // 归还实物库存 + 扣减在途（SHIPPED 时已 stockQuantity - / inTransitQuantity +）
          for (const item of items) {
            await tx.warehouseStock.updateMany({
              where: { productId: item.productId, warehouseId },
              data:  { stockQuantity: { increment: item.quantity } },
            });
            // 重新汇总 → 同步 Product.stockActual
            const allWs = await tx.warehouseStock.findMany({
              where:  { productId: item.productId },
              select: { stockQuantity: true },
            });
            const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
            const prod = await tx.product.findUnique({
              where: { id: item.productId }, select: { inTransitQuantity: true },
            });
            await tx.product.update({
              where: { id: item.productId },
              data: {
                stockActual:      totalStock,
                inTransitQuantity: { decrement: Math.min(item.quantity, prod?.inTransitQuantity ?? 0) },
              },
            });
            // 写一条 MANUAL_ADJUST 流水标记管理员强删回滚
            await applyStockChange(tx, {
              productId:      item.productId,
              warehouseId,
              changeQuantity: +item.quantity,
              type:           'MANUAL_ADJUST',
              referenceId:    String(id),
              remark:         `超管删除 FBE 发货单 ${shipmentNumber}，库存回滚`,
              createdBy:      req.user!.userId,
            });
          }
          console.log(`[FBE-DEL] #${id}(${shipmentNumber}) SHIPPED，仓库库存已归还`);

        } else {
          // ARRIVED / CANCELLED：库存已结算，无需回滚
          console.log(`[FBE-DEL] #${id}(${shipmentNumber}) 状态=${status}，库存无需回滚`);
        }

      } else {
        // ── 兼容模式（无 warehouseId，回滚旧字段 Product.stockActual）──
        if (status === 'SHIPPED') {
          for (const item of items) {
            await applyStockChange(tx, {
              productId:      item.productId,
              changeQuantity: +item.quantity,
              type:           'MANUAL_ADJUST',
              referenceId:    String(id),
              remark:         `超管删除 FBE 发货单 ${shipmentNumber}，库存回滚（兼容模式）`,
              createdBy:      req.user!.userId,
            });
            const prod = await tx.product.findUnique({
              where: { id: item.productId }, select: { inTransitQuantity: true },
            });
            await tx.product.update({
              where: { id: item.productId },
              data: { inTransitQuantity: { decrement: Math.min(item.quantity, prod?.inTransitQuantity ?? 0) } },
            });
          }
        }
        // PENDING/ALLOCATING 兼容模式下无库存占用，无需处理
      }

      // ② 删除明细（Cascade 也会处理，显式更清晰）
      await tx.fbeShipmentItem.deleteMany({ where: { shipmentId: id } });

      // ③ 删除主单
      await tx.fbeShipment.delete({ where: { id } });
    });

    console.log(`[FBE-DEL] 超管 ${req.user!.username} 删除发货单 #${id}(${shipmentNumber})，状态=${status}`);
    res.json({
      code: 200,
      data: { id, shipmentNumber, status },
      message: `发货单 ${shipmentNumber} 已删除，库存已回滚`,
    });
  } catch (err: any) {
    console.error('[DELETE /api/fbe-shipments/:id]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '删除失败，请稍后重试' });
  }
});

export default router;
