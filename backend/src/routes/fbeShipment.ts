/**
 * FBE 发货单 API（4 阶段仓储状态机）
 *
 * 状态机流转规则：
 *   PENDING     → ALLOCATING  : ★延迟锁库点；校验仓库 stockQuantity 足量后转入 lockedQuantity
 *   ALLOCATING  → SHIPPED     : 释放 lockedQuantity + 加 FBE 在途；禁止再次扣 stockQuantity
 *   SHIPPED     → ARRIVED     : 扣在途库存（inTransitQuantity -），回填 receivedQuantity
 *   PENDING     → CANCELLED : 无库存变动
 *   ALLOCATING  → CANCELLED : lockedQuantity 退回 stockQuantity
 *   SHIPPED     → CANCELLED   : 撤销在途（inTransitQuantity -），归还本地库存（stockActual +）
 *
 * 进销存联动：
 *   ① PENDING→ALLOCATING：检查 WarehouseStock.stockQuantity >= quantity，否则 throw，事务回滚
 *   ② PENDING→ALLOCATING：stockQuantity -= quantity，lockedQuantity += quantity
 *   ③ ALLOCATING→SHIPPED：lockedQuantity -= quantity，FBE inTransitQuantity += quantity
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
//   warehouseId?: number          出库仓库 ID（多仓架构；建单不锁库，PENDING→ALLOCATING 时锁库）
//   shipmentNumber?: string       自定义单号（不传则自动生成）
//   remark?: string
//   items: [{ sku, quantity, productId? }]
//
// 防呆①: 所有 SKU 必须在本地 Product 表中存在
// 防呆②: 所有 SKU 必须已绑定到目标 shopId 的平台产品
// 防呆③: 建单阶段不检查库存、不锁库，支持无库存预建单
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

    const skuToProductId    = new Map(products.map((p) => [p.sku!, p.id]));
    const skuToPurchasePrice = new Map(products.map((p) => [p.sku!, Number(p.purchasePrice ?? 0)]));

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

    // ── 纯建单：PENDING 阶段不校验库存、不锁库，允许无库存预建单 ─────
    const shipment = await prisma.fbeShipment.create({
      data: {
        shipmentNumber:    finalNumber,
        status:            'PENDING',
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

    res.json({ code: 200, data: shipment, message: '发货单创建成功' });
  } catch (err: any) {
    const msg: string = err?.message ?? '未知错误';
    console.error('[FBE] 创建发货单失败:', err);
    if (msg.startsWith('库存不足')) {
      res.status(400).json({ code: 400, data: null, message: msg });
    } else {
      res.status(500).json({ code: 500, data: null, message: `发货单创建失败：${msg}` });
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
// ─────────────────────────────────────────────────────────────────────
// GET /api/fbe-shipments/counts   各状态发货单数量统计
// ★ 必须注册在 /:id 之前，否则 Express 将 "counts" 误匹配为 :id 参数
// ─────────────────────────────────────────────────────────────────────
router.get('/counts', async (req: Request, res: Response) => {
  try {
    const rows = await prisma.fbeShipment.groupBy({
      by:     ['status'],
      _count: { id: true },
    });

    const counts: Record<string, number> = {
      PENDING:    0,
      ALLOCATING: 0,
      SHIPPED:    0,
      ARRIVED:    0,
      CANCELLED:  0,
    };
    for (const row of rows) {
      counts[row.status] = row._count.id;
    }

    res.json({ code: 200, data: counts, message: 'success' });
  } catch (err: any) {
    console.error('[FBE] 统计各状态数量失败:', err?.message);
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
// PUT /api/fbe-shipments/:id   编辑发货单（单号 / 备注 / 明细数量 / 追加新SKU）
//
// Body: {
//   shipmentNumber?: string,
//   remark?: string,
//   items?: Array<
//     | { id: number; quantity: number }                        // ★ 更新已有行：必须带 FbeShipmentItem.id
//     | { storeProductId: number; quantity: number }           // ★ 追加新行：带平台产品ID，无 id 字段
//   >
// }
//
// 防呆：仅 PENDING 或 ALLOCATING 状态允许编辑
//
// 追加新SKU逻辑（与初次建单完全对齐）：
//   ① storeProductId → StoreProduct.mappedInventorySku → Product
//   ② 校验 mappedInventorySku 已绑定到发货单目标 shopId
//   ③ 若发货单有 warehouseId，校验 WarehouseStock 可用量（stockQuantity - lockedQuantity >= quantity）
//   ④ 在同一事务内 fbeShipmentItem.create + warehouseStock.lockedQuantity += quantity
//   ⑤ 更新 fbeShipment.totalProductValue（追加货值快照）
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
    const id    = parseInt(rawId, 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '发货单 ID 无效' });
      return;
    }

    // 查主单：需要 warehouseId 和 shopId 用于追加新行的锁仓校验
    const current = await prisma.fbeShipment.findUnique({
      where:  { id },
      select: { id: true, status: true, shipmentNumber: true, warehouseId: true, shopId: true },
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

    type UpdateItem = { id: number; quantity: number };
    type AppendItem = { storeProductId: number; quantity: number };

    const { shipmentNumber, remark, items } = req.body as {
      shipmentNumber?: string;
      remark?: string;
      items?: Array<UpdateItem | AppendItem>;
    };

    // ── 分拣 items：已有行（有 id）vs 新追加行（有 storeProductId，无 id）──
    const updateItems: UpdateItem[] = [];
    const appendItems: AppendItem[] = [];

    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        if (!item.quantity || !Number.isInteger(item.quantity) || item.quantity <= 0) {
          res.status(400).json({ code: 400, data: null, message: 'quantity 必须为正整数' });
          return;
        }
        if ('id' in item && Number.isInteger((item as UpdateItem).id)) {
          updateItems.push(item as UpdateItem);
        } else if ('storeProductId' in item && Number.isInteger((item as AppendItem).storeProductId)) {
          appendItems.push(item as AppendItem);
        } else {
          // ★ 明确拒绝：元素既没有合法 id（更新已有行），也没有合法 storeProductId（追加新行）
          res.status(400).json({
            code: 400,
            data: null,
            message: `items 元素格式非法：每个元素必须携带合法的 "id"（更新已有明细）或 "storeProductId"（追加新产品），收到：${JSON.stringify(item)}`,
          });
          return;
        }
      }
    }

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

    // ── 追加行前置校验（事务外，避免脏数据进入事务）────────────────
    // 结构：{ productId, sku, chineseName, purchasePrice, storeProductId }
    type ResolvedAppend = {
      storeProductId: number;
      productId:      number;
      sku:            string;
      chineseName:    string | null;
      purchasePrice:  number;
      quantity:       number;
    };
    const resolvedAppends: ResolvedAppend[] = [];

    if (appendItems.length > 0) {
      const storeProductIds = appendItems.map((i) => i.storeProductId);

      // ① 查 StoreProduct，确认属于本发货单的 shopId，并拿到 mappedInventorySku
      const storeProducts = await prisma.storeProduct.findMany({
        where:  { id: { in: storeProductIds }, shopId: current.shopId ?? undefined },
        select: { id: true, mappedInventorySku: true, name: true, shopId: true },
      });
      const storeProductMap = new Map(storeProducts.map((sp) => [sp.id, sp]));

      // 找不到或不属于本店铺的 ID
      const notFound = storeProductIds.filter((spId) => !storeProductMap.has(spId));
      if (notFound.length > 0) {
        res.status(400).json({
          code: 400, data: null,
          message: `平台产品 ID [${notFound.join(', ')}] 不存在或不属于本发货单店铺`,
        });
        return;
      }

      // ② 检查 mappedInventorySku 必须已绑定
      const unmapped = storeProducts.filter((sp) => !sp.mappedInventorySku).map((sp) => sp.id);
      if (unmapped.length > 0) {
        res.status(400).json({
          code: 400, data: null,
          message: `平台产品 ID [${unmapped.join(', ')}] 尚未绑定内部库存 SKU，请先在平台产品页完成绑定`,
        });
        return;
      }

      // ③ 通过 mappedInventorySku 查本地 Product
      const mappedSkus = storeProducts.map((sp) => sp.mappedInventorySku as string);
      const products   = await prisma.product.findMany({
        where:  { sku: { in: mappedSkus }, isDeleted: false },
        select: { id: true, sku: true, chineseName: true, purchasePrice: true },
      });
      const productBySkuMap = new Map(products.map((p) => [p.sku!, p]));

      // 库存 SKU 在 Product 表不存在
      const missingSkus = mappedSkus.filter((s) => !productBySkuMap.has(s));
      if (missingSkus.length > 0) {
        res.status(400).json({
          code: 400, data: null,
          message: `SKU [${missingSkus.join(', ')}] 在本地库存中不存在，请先在【库存 SKU】页面创建对应产品`,
        });
        return;
      }

      // ④ 延迟锁库：PENDING 追加不校验库存；ALLOCATING 追加才校验实时可用库存
      const whId = current.warehouseId;
      if (current.status === 'ALLOCATING' && whId !== null) {
        const productIds = products.map((p) => p.id);
        const whStocks   = await prisma.warehouseStock.findMany({
          where:  { warehouseId: whId, productId: { in: productIds } },
          select: { productId: true, stockQuantity: true },
        });
        const whStockMap = new Map(whStocks.map((s) => [s.productId, s]));

        const insufficient: string[] = [];
        for (const appendItem of appendItems) {
          const sp        = storeProductMap.get(appendItem.storeProductId)!;
          const product   = productBySkuMap.get(sp.mappedInventorySku!)!;
          const ws        = whStockMap.get(product.id);
          const available = ws ? ws.stockQuantity : 0;
          if (available < appendItem.quantity) {
            insufficient.push(
              `SKU [${product.sku}] 仓库可用库存 ${available} < 需追加 ${appendItem.quantity}`,
            );
          }
        }
        if (insufficient.length > 0) {
          res.status(400).json({
            code: 400, data: null,
            message: `库存不足，无法追加：\n${insufficient.join('\n')}`,
          });
          return;
        }
      }

      // ⑤ 组装 resolvedAppends（带齐事务内所需字段）
      for (const appendItem of appendItems) {
        const sp      = storeProductMap.get(appendItem.storeProductId)!;
        const product = productBySkuMap.get(sp.mappedInventorySku!)!;
        resolvedAppends.push({
          storeProductId: appendItem.storeProductId,
          productId:      product.id,
          sku:            product.sku!,
          chineseName:    product.chineseName,
          purchasePrice:  Number(product.purchasePrice ?? 0),
          quantity:       appendItem.quantity,
        });
      }
    }

    // ── 事务：主单更新 + 明细修改；PENDING 不锁库，ALLOCATING 做差额锁库 ─────
    await prisma.$transaction(async (tx) => {
      // A. 更新主单头部字段（单号/备注）
      if (Object.keys(updateData).length > 0) {
        await tx.fbeShipment.update({ where: { id }, data: updateData });
      }

      // B. 更新已有明细行的数量；ALLOCATING 状态下同步调整锁库差额
      for (const item of updateItems) {
        const existing = await tx.fbeShipmentItem.findUnique({
          where:  { id: item.id },
          select: { id: true, shipmentId: true, productId: true, quantity: true },
        });
        if (!existing || existing.shipmentId !== id) {
          throw new Error(`发货明细 #${item.id} 不存在或不属于当前发货单`);
        }

        const delta = item.quantity - existing.quantity;
        if (current.status === 'ALLOCATING' && current.warehouseId !== null && delta !== 0) {
          if (delta > 0) {
            const ws = await tx.warehouseStock.findUnique({
              where:  { productId_warehouseId: { productId: existing.productId, warehouseId: current.warehouseId } },
              select: { stockQuantity: true },
            });
            const available = ws?.stockQuantity ?? 0;
            if (available < delta) {
              throw new Error(`库存不足，无法增加配货数量：SKU #${existing.productId} 可用 ${available} < 需追加 ${delta}`);
            }
            const locked = await tx.warehouseStock.updateMany({
              where: {
                productId:     existing.productId,
                warehouseId:   current.warehouseId,
                stockQuantity: { gte: delta },
              },
              data:  {
                stockQuantity:  { decrement: delta },
                lockedQuantity: { increment: delta },
              },
            });
            if (locked.count !== 1) {
              throw new Error(`库存不足，无法增加配货数量：SKU #${existing.productId} 库存已被并发占用，请刷新后重试`);
            }
          } else {
            const releaseQty = Math.abs(delta);
            await tx.warehouseStock.updateMany({
              where: { productId: existing.productId, warehouseId: current.warehouseId },
              data:  {
                stockQuantity:  { increment: releaseQty },
                lockedQuantity: { decrement: releaseQty },
              },
            });
          }

          const allWs = await tx.warehouseStock.findMany({
            where:  { productId: existing.productId },
            select: { stockQuantity: true },
          });
          const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
          await tx.product.update({
            where: { id: existing.productId },
            data:  { stockActual: totalStock },
          });
        }

        await tx.fbeShipmentItem.update({
          where: { id: item.id },
          data:  { quantity: item.quantity },
        });
      }

      // C. 追加新明细行；PENDING 不锁库，ALLOCATING 立即锁新增量
      if (resolvedAppends.length > 0) {
        const whId = current.warehouseId;
        let addedProductValue = 0;

        for (const ra of resolvedAppends) {
          // C-1. 创建 FbeShipmentItem 明细行
          await tx.fbeShipmentItem.create({
            data: {
              shipmentId:       id,
              productId:        ra.productId,
              quantity:         ra.quantity,
              receivedQuantity: 0,
            },
          });

          // C-2. 只有 ALLOCATING 状态追加新行时才锁库
          if (current.status === 'ALLOCATING' && whId !== null) {
            try {
              const locked = await tx.warehouseStock.updateMany({
                where:  {
                  productId:     ra.productId,
                  warehouseId:   whId,
                  stockQuantity: { gte: ra.quantity },
                },
                data: {
                  stockQuantity:  { decrement: ra.quantity },
                  lockedQuantity: { increment: ra.quantity },
                },
              });
              if (locked.count !== 1) {
                throw new Error(`库存不足，无法追加：SKU [${ra.sku}] 库存已被并发占用，请刷新后重试`);
              }
              const allWs = await tx.warehouseStock.findMany({
                where:  { productId: ra.productId },
                select: { stockQuantity: true },
              });
              const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
              await tx.product.update({
                where: { id: ra.productId },
                data:  { stockActual: totalStock },
              });
            } catch (lockErr: any) {
              throw new Error(
                `SKU [${ra.sku}] 追加锁仓失败：${lockErr?.message ?? lockErr}`,
              );
            }
          }

          // C-3. 累计追加货值（purchasePrice 快照）
          addedProductValue += ra.quantity * ra.purchasePrice;

          console.log(
            `[FBE] 发货单 #${id}(${current.shipmentNumber}) 追加新行：` +
            `SKU=${ra.sku} qty=${ra.quantity} warehouseId=${whId ?? '(兼容模式)'}`,
          );
        }

        // C-4. 更新发货单货值快照（追加部分叠加，保持历史数据完整性）
        if (addedProductValue > 0) {
          await tx.fbeShipment.update({
            where: { id },
            data:  { totalProductValue: { increment: parseFloat(addedProductValue.toFixed(2)) } },
          });
        }
      }
    });

    // ── 返回更新后的完整数据 ─────────────────────────────────────────
    const updated = await prisma.fbeShipment.findUnique({
      where: { id },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true, pnk: true, sku: true, title: true, chineseName: true,
                imageUrl: true, stockActual: true, inTransitQuantity: true,
                warehouseStocks: {
                  select: {
                    warehouseId: true, stockQuantity: true,
                    lockedQuantity: true, inTransitQuantity: true,
                    warehouse: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
        shop:      { select: { id: true, shopName: true, region: true } },
        warehouse: { select: { id: true, name: true, type: true } },
        owner:     { select: { id: true, name: true } },
      },
    });

    const result = updated ? {
      ...updated,
      productCount:   updated.items.length,
      totalQuantity:  updated.items.reduce((sum, i) => sum + i.quantity, 0),
      appendedCount:  resolvedAppends.length,
      appendedSkus:   resolvedAppends.map((r) => r.sku),
    } : null;

    res.json({ code: 200, data: result, message: '发货单更新成功' });
  } catch (err: any) {
    const msg = err?.message ?? '服务器内部错误';
    if (
      msg.includes('quantity') ||
      msg.includes('库存不足') ||
      msg.includes('无法增加配货数量') ||
      msg.includes('发货明细') ||
      msg.includes('锁仓失败')
    ) {
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
      const whId = current.warehouseId;   // 出库仓库（null = 老数据兼容，走旧逻辑）
      const productIds = current.items.map((i) => i.productId);
      let shipment: any = current;

      if (newStatus === 'ALLOCATING') {
        // ① PENDING → ALLOCATING：延迟锁库核心节点
        // 必须在同一个事务中完成：查实时库存 → 扣 stockQuantity → 加 lockedQuantity → 改状态。
        if (whId === null) {
          throw new Error('发货单未指定出库仓库，无法进入配货中');
        }

        const prodSkuMap = new Map(
          (await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, sku: true } }))
            .map((p) => [p.id, p.sku]),
        );
        const whStocks = await tx.warehouseStock.findMany({
          where:  { warehouseId: whId, productId: { in: productIds } },
          select: { productId: true, stockQuantity: true },
        });
        const whStockMap = new Map(whStocks.map((s) => [s.productId, s]));

        const insufficient: string[] = [];
        for (const item of current.items) {
          const stock = whStockMap.get(item.productId)?.stockQuantity ?? 0;
          if (stock < item.quantity) {
            insufficient.push(
              `SKU [${prodSkuMap.get(item.productId) ?? `#${item.productId}`}] ` +
              `仓库可用库存 ${stock} < 需配货 ${item.quantity}`,
            );
          }
        }
        if (insufficient.length > 0) {
          throw new Error(`库存不足，无法进入配货中：\n${insufficient.join('\n')}`);
        }

        for (const item of current.items) {
          const locked = await tx.warehouseStock.updateMany({
            where: {
              productId:     item.productId,
              warehouseId:   whId,
              stockQuantity: { gte: item.quantity },
            },
            data: {
              stockQuantity:  { decrement: item.quantity },
              lockedQuantity: { increment: item.quantity },
            },
          });
          if (locked.count !== 1) {
            throw new Error(
              `库存不足，无法进入配货中：SKU [${prodSkuMap.get(item.productId) ?? `#${item.productId}`}] ` +
              `库存已被并发占用，请刷新后重试`,
            );
          }

          // stockActual 继续表示全仓可用库存合计，锁库后要同步减少。
          const allWs = await tx.warehouseStock.findMany({
            where:  { productId: item.productId },
            select: { stockQuantity: true },
          });
          const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
          await tx.product.update({
            where: { id: item.productId },
            data:  { stockActual: totalStock },
          });
        }

        shipment = await tx.fbeShipment.update({
          where: { id },
          data:  { status: newStatus },
        });
        console.log(`[FBE] #${id}(${current.shipmentNumber}) PENDING→ALLOCATING，已完成延迟锁库`);

      } else if (newStatus === 'SHIPPED') {
        // ② ALLOCATING → SHIPPED（★ 核心出库路径）

        if (whId !== null) {
          // ── 多仓模式：只释放 lockedQuantity + 推入 FBE 在途，禁止再次扣 stockQuantity ──
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

          // b. 释放本次锁定 + 推入 Product.inTransitQuantity + 写流水
          //
          // ★ 架构说明：多仓模式下不使用 applyStockChange()，因为该函数会在 product.update
          //   之后再次读取 stockActual（已被修改），导致 InventoryLog.beforeQuantity 记录的是
          //   中间态而非出库前的真实库存，产生审计账单污染。此处直接写 inventoryLog。
          //
          // 出库前快照：延迟锁库模型下 stockActual 已在 PENDING→ALLOCATING 时扣减。
          // 这里的流水按“物理库存离仓”表达：before = 当前可用 + 本次锁定，after = 当前可用。
          const beforeStockMap = new Map(
            (await tx.product.findMany({
              where:  { id: { in: productIds } },
              select: { id: true, stockActual: true },
            })).map((p) => [p.id, p.stockActual ?? 0]),
          );

          let totalQty = 0;
          for (const item of current.items) {
            const sku = prodSkuMap.get(item.productId) ?? `#${item.productId}`;
            try {
              const beforeStock = beforeStockMap.get(item.productId) ?? 0;

              // 仅释放锁定量，绝对禁止二次扣减 stockQuantity
              await tx.warehouseStock.update({
                where: { productId_warehouseId: { productId: item.productId, warehouseId: whId } },
                data: {
                  lockedQuantity: { decrement: item.quantity },
                },
              });

              // 重新汇总全仓可用库存，正常情况下与锁库后保持一致
              const allWs = await tx.warehouseStock.findMany({
                where:  { productId: item.productId },
                select: { stockQuantity: true },
              });
              const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
              await tx.product.update({
                where: { id: item.productId },
                data:  { stockActual: totalStock, inTransitQuantity: { increment: item.quantity } },
              });

              // 直接写 FBE_OUT 流水（beforeStock = 出库前快照，不受中间态污染）
              await tx.inventoryLog.create({
                data: {
                  productId:      item.productId,
                  warehouseId:    whId,
                  type:           'FBE_OUT',
                  changeQuantity: -item.quantity,
                  beforeQuantity: beforeStock + item.quantity,
                  afterQuantity:  totalStock,
                  referenceId:    String(id),
                  remark:         `FBE 发货单 ${current.shipmentNumber} 出库（仓库 #${whId}）`,
                  createdBy:      userId,
                },
              });

              totalQty += item.quantity;
            } catch (itemErr: any) {
              console.error(`[FBE] #${id} SHIPPED 出库失败 | SKU [${sku}]:`, itemErr?.message ?? itemErr);
              throw new Error(`发货单 ${current.shipmentNumber} 出库失败：SKU [${sku}] 处理异常 — ${itemErr?.message ?? itemErr}`);
            }
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
            const prod2 = stockMap.get(item.productId);
            const sku2  = prod2?.sku ?? `#${item.productId}`;
            try {
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
            } catch (itemErr: any) {
              console.error(`[FBE] #${id} SHIPPED 出库失败（兼容模式）| SKU [${sku2}]:`, itemErr?.message ?? itemErr);
              throw new Error(`发货单 ${current.shipmentNumber} 出库失败：SKU [${sku2}] 处理异常 — ${itemErr?.message ?? itemErr}`);
            }
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) ALLOCATING→SHIPPED（兼容模式），合计出库 ${totalQty}`);
        }

        shipment = await tx.fbeShipment.update({
          where: { id },
          data:  { status: newStatus },
        });

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
        shipment = await tx.fbeShipment.update({
          where: { id },
          data:  { status: newStatus },
        });

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

            let beforeQuantity = 0;
            let afterQuantity = 0;
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
              beforeQuantity = totalStock - item.quantity;
              afterQuantity = totalStock;
              await tx.product.update({
                where: { id: item.productId },
                data:  { stockActual: totalStock, inTransitQuantity: { decrement: safeDecrement } },
              });
            } else {
              const changed = await applyStockChange(tx, {
                productId:      item.productId,
                changeQuantity: +item.quantity,
                type:           'MANUAL_ADJUST',
                referenceId:    String(id),
                remark:         `FBE 发货单 ${current.shipmentNumber} 取消，退回本地库存`,
                createdBy:      userId,
              });
              beforeQuantity = changed.before;
              afterQuantity = changed.after;
              await tx.product.update({
                where: { id: item.productId },
                data:  { inTransitQuantity: { decrement: safeDecrement } },
              });
            }
            if (whId !== null) {
              // 多仓模式已手动归还 WarehouseStock 并同步 Product.stockActual；
              // 这里只写审计流水，避免 applyStockChange 二次增加 Product.stockActual。
              await tx.inventoryLog.create({
                data: {
                  productId:      item.productId,
                  warehouseId:    whId,
                  type:           'MANUAL_ADJUST',
                  changeQuantity: +item.quantity,
                  beforeQuantity,
                  afterQuantity,
                  referenceId:    String(id),
                  remark:         `FBE 发货单 ${current.shipmentNumber} 取消，退回本地库存`,
                  createdBy:      userId,
                },
              });
            }
            totalQty += item.quantity;
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) SHIPPED→CANCELLED，在途撤销 -${totalQty}，库存 +${totalQty}`);

        } else if (currentStatus === 'ALLOCATING') {
          // ④b ALLOCATING → CANCELLED：锁定库存退回可用库存
          if (whId !== null) {
            for (const item of current.items) {
              await tx.warehouseStock.updateMany({
                where: { productId: item.productId, warehouseId: whId },
                data:  {
                  stockQuantity:  { increment: item.quantity },
                  lockedQuantity: { decrement: item.quantity },
                },
              });

              const allWs = await tx.warehouseStock.findMany({
                where:  { productId: item.productId },
                select: { stockQuantity: true },
              });
              const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
              await tx.product.update({
                where: { id: item.productId },
                data:  { stockActual: totalStock },
              });
            }
          }
          console.log(`[FBE] #${id}(${current.shipmentNumber}) ALLOCATING→CANCELLED，锁定量已退回可用库存`);

        } else {
          // ④c PENDING → CANCELLED：PENDING 未锁库，无库存动作
          console.log(`[FBE] #${id}(${current.shipmentNumber}) PENDING→CANCELLED，无库存动作`);
        }

        shipment = await tx.fbeShipment.update({
          where: { id },
          data:  { status: newStatus },
        });
      }

      return shipment;
    });

    res.json({ code: 200, data: updated, message: `发货单 ${current.shipmentNumber} 状态已更新为 ${newStatus}` });
  } catch (err: any) {
    const msg: string = err?.message ?? '未知错误';
    console.error('[FBE] 更新发货单状态失败:', err);
    if (
      msg.startsWith('库存不足') ||
      msg.startsWith('库存锁定量不足') ||
      msg.startsWith('发货单未指定')
    ) {
      res.status(400).json({ code: 400, data: null, message: msg });
    } else {
      res.status(500).json({ code: 500, data: null, message: `发货单状态更新失败：${msg}` });
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
//   PENDING             → 未锁库，无库存动作
//   ALLOCATING          → lockedQuantity 退回 stockQuantity
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
        if (status === 'PENDING') {
          // 延迟锁库模型：PENDING 仅为业务草单，未占用库存
          console.log(`[FBE-DEL] #${id}(${shipmentNumber}) PENDING，未锁库，无库存回滚`);

        } else if (status === 'ALLOCATING') {
          // 配货中已锁库：删除时把 lockedQuantity 退回 stockQuantity
          for (const item of items) {
            await tx.warehouseStock.updateMany({
              where: { productId: item.productId, warehouseId },
              data:  {
                stockQuantity:  { increment: item.quantity },
                lockedQuantity: { decrement: item.quantity },
              },
            });

            const allWs = await tx.warehouseStock.findMany({
              where:  { productId: item.productId },
              select: { stockQuantity: true },
            });
            const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
            await tx.product.update({
              where: { id: item.productId },
              data:  { stockActual: totalStock },
            });
          }
          console.log(`[FBE-DEL] #${id}(${shipmentNumber}) ALLOCATING，锁定量已退回可用库存`);

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
            const beforeQuantity = totalStock - item.quantity;
            await tx.product.update({
              where: { id: item.productId },
              data: {
                stockActual:      totalStock,
                inTransitQuantity: { decrement: Math.min(item.quantity, prod?.inTransitQuantity ?? 0) },
              },
            });
            // 多仓模式已手动归还 WarehouseStock 并同步 Product.stockActual；
            // 这里只写审计流水，避免 applyStockChange 二次增加 Product.stockActual。
            await tx.inventoryLog.create({
              data: {
                productId:      item.productId,
                warehouseId,
                type:           'MANUAL_ADJUST',
                changeQuantity: +item.quantity,
                beforeQuantity,
                afterQuantity:  totalStock,
                referenceId:    String(id),
                remark:         `超管删除 FBE 发货单 ${shipmentNumber}，库存回滚`,
                createdBy:      req.user!.userId,
              },
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
