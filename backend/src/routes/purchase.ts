/**
 * 采购管理 API（重构版 —— 建单与 1688 下单彻底解耦）
 *
 * POST /api/purchases/create-local       采购计划 → 内部建单（一品一单，纯本地）
 * GET  /api/purchases                    采购单列表（分页，含子单 + 产品 + 仓库）
 * GET  /api/purchases/:id                采购单详情
 * POST /api/purchases/:id/place-1688-order  采购管理 → 真实调 1688 下单
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { createAlibabaOrder } from '../services/alibabaOrder';
import { applyStockChange } from './inventory';
import {
  syncOrderDetail,
  syncLogisticsInfos,
  getLogisticsTrace,
  getLogisticsTraceByOrder,
  isAliServiceError,
} from '../services/alibabaService';

const router = Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/create-local
//
// 采购计划确认建单（纯本地 DB，绝不调 1688）
// ★ 一品一单：每个产品独立生成一条 PurchaseOrder + PurchaseOrderItem
//
// Body: {
//   items: [{ productId: number, quantity: number }],
//   warehouseId?: number,   // 目标入库仓（可选）
//   remark?: string
// }
// ─────────────────────────────────────────────────────────────────────
router.post('/create-local', async (req: Request, res: Response) => {
  try {
    const userId   = req.user!.userId;
    const username = req.user!.username ?? 'unknown';
    const { items, warehouseId, remark } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供至少一个产品' });
      return;
    }

    // 校验 warehouseId（必传）
    if (warehouseId === undefined || warehouseId === null) {
      res.status(400).json({ code: 400, data: null, message: '请选择目标入库仓库（warehouseId 必填）' });
      return;
    }
    const wid = parseInt(String(warehouseId), 10);
    if (isNaN(wid) || wid <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId 无效' });
      return;
    }
    const wh = await prisma.warehouse.findUnique({ where: { id: wid }, select: { id: true, name: true, status: true } });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用' });
      return;
    }
    const validWarehouseId = wid;

    // 校验产品存在
    const productIds = items
      .map((i: any) => parseInt(String(i.productId), 10))
      .filter((id: number) => !isNaN(id) && id > 0);
    if (productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: 'productId 无效' });
      return;
    }

    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isDeleted: false },
      select: {
        id: true, sku: true, chineseName: true, title: true,
        purchasePrice: true, externalProductId: true, externalSkuId: true,
      },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // 生成单号前缀
    const now     = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix  = `PO-${dateStr}-`;
    const todayCount = await prisma.purchaseOrder.count({ where: { orderNo: { startsWith: prefix } } });

    // ── 一品一单：为每个产品生成独立的采购单 ──────────────────────
    const createdOrders: any[] = [];
    let seq = todayCount;

    for (const item of items) {
      const pid = parseInt(String(item.productId), 10);
      const qty = Math.max(1, parseInt(String(item.quantity), 10) || 1);
      const prod = productMap.get(pid);
      if (!prod) continue;

      seq++;
      const orderNo     = `${prefix}${String(seq).padStart(3, '0')}`;
      const unitPrice   = Number(prod.purchasePrice ?? 0);
      const totalAmount = parseFloat((qty * unitPrice).toFixed(2));

      const order = await prisma.$transaction(async (tx) => {
        const po = await tx.purchaseOrder.create({
          data: {
            orderNo,
            operator:    username,
            totalAmount,
            itemCount:   1,
            status:      'PENDING',
            warehouseId: validWarehouseId,
            remark:      remark ?? null,
            items: {
              create: {
                offerId:    prod.externalProductId ?? null,
                productIds: JSON.stringify([pid]),
                quantity:   qty,
              },
            },
          },
          include: {
            items: true,
            warehouse: { select: { id: true, name: true } },
          },
        });

        // 将产品关联到采购单，状态从 PURCHASING → ORDERED（进入采购管理，脱离采购计划列表）
        await tx.product.update({
          where: { id: pid },
          data:  { purchaseOrderId: po.id, status: 'ORDERED', purchaseQuantity: qty },
        });

        // ★ 增加在途库存：产品已进入正式采购流程，货物尚未到仓
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: pid, warehouseId: validWarehouseId } },
          create: { productId: pid, warehouseId: validWarehouseId, inTransitQuantity: qty },
          update: { inTransitQuantity: { increment: qty } },
        });

        return po;
      });

      createdOrders.push({
        id:          order.id,
        orderNo:     order.orderNo,
        totalAmount: Number(order.totalAmount),
        quantity:    qty,
        sku:         prod.sku,
        chineseName: prod.chineseName,
        warehouse:   order.warehouse,
        has1688:     !!(prod.externalProductId && prod.externalSkuId),
      });
    }

    if (createdOrders.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '所有产品均无效，未创建采购单' });
      return;
    }

    console.log(
      `[Purchase] ${username} 创建 ${createdOrders.length} 张采购单（一品一单），` +
      `单号: ${createdOrders.map((o) => o.orderNo).join(', ')}`,
    );

    res.json({
      code: 200,
      data: { orders: createdOrders, count: createdOrders.length },
      message: `成功创建 ${createdOrders.length} 张采购单`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/create-local]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '创建采购单失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/fix-in-transit
//
// 【一次性历史修复】重新计算所有活跃采购单（PENDING/PLACED/IN_TRANSIT）
// 的在途库存，并覆盖写入 WarehouseStock.inTransitQuantity。
//
// 算法：
//   1. 将所有受影响的 (productId, warehouseId) 的 inTransitQuantity 先清零
//   2. 遍历全部未完结采购单，按 (productId, warehouseId) 分组累加 purchaseQuantity
//   3. 批量 upsert 覆盖写入
//
// 幂等性：可重复调用，每次都以正确值覆盖。
// ─────────────────────────────────────────────────────────────────────
router.post('/fix-in-transit', async (req: Request, res: Response) => {
  try {
    // 查所有未完结的采购单（PENDING / PLACED / IN_TRANSIT）及其关联产品
    const activeOrders = await prisma.purchaseOrder.findMany({
      where: {
        status:      { in: ['PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL'] },
        warehouseId: { not: null },
      },
      select: {
        id:          true,
        orderNo:     true,
        warehouseId: true,
        products: {
          select: { id: true, sku: true, purchaseQuantity: true },
        },
      },
    });

    // 按 (productId, warehouseId) 分组累加在途数量
    const transitMap = new Map<string, { productId: number; warehouseId: number; qty: number }>();
    for (const order of activeOrders) {
      const wid = order.warehouseId!;
      for (const prod of order.products) {
        const qty = Math.max(1, prod.purchaseQuantity ?? 1);
        const key = `${prod.id}_${wid}`;
        if (transitMap.has(key)) {
          transitMap.get(key)!.qty += qty;
        } else {
          transitMap.set(key, { productId: prod.id, warehouseId: wid, qty });
        }
      }
    }

    // 先清零所有受影响记录，再批量写入正确值（事务保证原子性）
    const entries = Array.from(transitMap.values());
    let upsertCount = 0;

    await prisma.$transaction(async (tx) => {
      // 将所有涉及的 (productId, warehouseId) 的在途库存归零
      for (const e of entries) {
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: e.productId, warehouseId: e.warehouseId } },
          create: { productId: e.productId, warehouseId: e.warehouseId, inTransitQuantity: e.qty },
          update: { inTransitQuantity: e.qty },   // 覆盖（非增量），幂等安全
        });
        upsertCount++;
      }
    });

    const summary = entries.map((e) => ({
      productId:    e.productId,
      warehouseId:  e.warehouseId,
      inTransitQty: e.qty,
    }));

    console.log(
      `[fix-in-transit] 修复完成：扫描 ${activeOrders.length} 张活跃采购单，` +
      `更新 ${upsertCount} 条 (productId × warehouseId) 在途库存记录`,
    );

    res.json({
      code: 200,
      data: {
        scannedOrders: activeOrders.length,
        updatedRecords: upsertCount,
        detail: summary,
      },
      message: `在途库存修复完成：${activeOrders.length} 张活跃采购单，${upsertCount} 条库存记录已重算`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/fix-in-transit]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '在途库存修复失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases
// 采购单列表（分页，含子单 + 关联产品 + 仓库）
//
// Query:
//   page, pageSize  分页
//   tabStatus       看板状态栏（优先）：ALL | PENDING | PURCHASING | COMPLETED
//   status          精确状态（tabStatus 未传时兜底）：PENDING/PLACED/IN_TRANSIT/RECEIVED
//   keyword         深度穿透搜索：匹配主单号 OR 1688 订单号 OR 关联产品 SKU
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
    const skip     = (page - 1) * pageSize;

    // ── ① 状态过滤 ────────────────────────────────────────────────
    // 同时兼容 query 和 body（防止前端通过 POST body 传参）
    // 兼容多种命名：tabStatus / tab_status / tab / status
    const rawTab = (
      req.query.tabStatus  ?? req.body?.tabStatus  ??
      req.query.tab_status ?? req.body?.tab_status ??
      req.query.tab        ?? req.body?.tab        ??
      req.query.status     ?? req.body?.status     ?? ''
    );
    const tabRaw = String(rawTab).toUpperCase().trim();

    // ── 状态映射：PURCHASING 绝不包含 PENDING/RECEIVED ──────────────
    // PENDING    → 未下单（本地建单，尚未提交 1688）
    // PURCHASING → 采购中（PLACED=已下单 / IN_TRANSIT=运输中 / PARTIAL=部分入库待补）
    // COMPLETED  → 已完成（RECEIVED=已全部入库）
    let statusFilter: string | { in: string[] } | undefined;
    switch (tabRaw) {
      case 'PENDING':
        statusFilter = 'PENDING';
        break;
      case 'PURCHASING':
        statusFilter = { in: ['PLACED', 'IN_TRANSIT', 'PARTIAL'] };
        break;
      case 'COMPLETED':
        statusFilter = { in: ['RECEIVED'] };
        break;
      case 'PLACED':      statusFilter = 'PLACED';      break;
      case 'IN_TRANSIT':  statusFilter = 'IN_TRANSIT';  break;
      case 'PARTIAL':     statusFilter = 'PARTIAL';     break;
      case 'RECEIVED':    statusFilter = 'RECEIVED';    break;
      // ALL / 空值 / 未知值 → statusFilter = undefined（返回全部）
    }

    console.log(
      `[GET /api/purchases] tabRaw="${tabRaw}" → statusFilter=${JSON.stringify(statusFilter)}`,
      '| query:', JSON.stringify(req.query),
    );

    // ── ② 深度穿透搜索 ────────────────────────────────────────────
    const kw = String(
      req.query.keyword ?? req.body?.keyword ??
      req.query.search  ?? req.body?.search  ?? '',
    ).trim();

    // ── ② 预查：关键词可能是 SKU，先找到所有匹配的产品 ID ──────────
    //
    // ★ 背景：Product.purchaseOrderId 是单 FK，若同一产品被多次建单，
    //   后建的订单会覆盖 FK，导致先建订单的 products 关联断裂。
    //   直接用 { products: { some: { sku: ... } } } 会漏掉 FK 断裂的订单。
    //
    // ★ 修复策略：先查出 SKU 匹配的产品 ID 列表，再通过
    //   PurchaseOrderItem.productIds JSON 字段进行二次匹配，彻底绕过 FK 断裂问题。
    let skuMatchProductIds: string[] = [];
    if (kw) {
      const skuMatches = await prisma.product.findMany({
        where: { sku: { contains: kw, mode: 'insensitive' } },
        select: { id: true },
      });
      skuMatchProductIds = skuMatches.map((p) => String(p.id));
    }

    // ── ③ 用显式 AND 构建 where，彻底隔离状态过滤与关键词 OR 条件 ──
    //
    // 产生结构：{ AND: [{ status: X }, { OR: [cond1, cond2, ...] }] }
    // 等价 SQL：WHERE status=X AND (cond1 OR cond2 OR ...)
    const andClauses: any[] = [];

    if (statusFilter !== undefined) {
      andClauses.push({ status: statusFilter });
    }

    if (kw) {
      const kwOrClauses: any[] = [
        // 主单号
        { orderNo:        { contains: kw, mode: 'insensitive' as const } },
        // 主单 1688 订单号
        { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } },
        // ★ 主单物流运单号（仓库人员扫码反查采购单的核心入口）
        { trackingNumber: { contains: kw, mode: 'insensitive' as const } },
        // 子单 1688 订单号
        { items: { some: { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } } } },
        // ★ 子单物流单号（PurchaseOrderItem.logisticsNo）
        { items: { some: { logisticsNo:    { contains: kw, mode: 'insensitive' as const } } } },
        // SKU 路径①：Product.purchaseOrderId FK 正常时，通过 products 关联搜索
        { products: { some: { sku: { contains: kw, mode: 'insensitive' as const } } } },
      ];

      // SKU 路径②（兜底）：FK 断裂时，通过 PurchaseOrderItem.productIds JSON 字段搜索
      // productIds 存储格式为 "[93678]"，contains 子字符串匹配精确 ID 数字
      for (const pid of skuMatchProductIds) {
        kwOrClauses.push({
          items: { some: { productIds: { contains: pid } } },
        });
      }

      andClauses.push({ OR: kwOrClauses });
    }

    // 无条件时 where = {} → 返回全部（ALL Tab 行为）
    const where: any = andClauses.length > 0 ? { AND: andClauses } : {};

    const [total, rawList] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            select: {
              id: true, offerId: true, quantity: true,
              productIds: true,                          // ← 用于精准关联 product
              alibabaOrderId: true, alibabaOrderStatus: true,
              alibabaTotalAmount: true, shippingFee: true,
              logisticsCompany: true, logisticsNo: true,
            },
          },
          products: {
            select: {
              id: true, sku: true, chineseName: true, imageUrl: true,
              purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
              // ★ 1688 映射核心字段
              externalProductId: true,   // 1688 offerId（商品维度唯一标识）
              externalSkuId:     true,   // 1688 specId（32位 MD5，下单必填）
              externalSkuIdNum:  true,   // 1688 skuId（纯数字，兜底用）
              externalSynced:    true,   // 是否已确认 1688 映射
              externalOrderId:   true,   // 已下单时的 1688 订单号
            },
          },
          warehouse: { select: { id: true, name: true, type: true } },
        },
        // 新增字段直接从主单查（无需额外 join）
        // Prisma 默认已包含主表所有字段，此处仅记录用于文档自解释
      }),
    ]);

    // ── 各 Tab 计数（一次性返回，前端可直接渲染徽标）──────────────
    const [cntPending, cntPurchasing, cntCompleted] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
      prisma.purchaseOrder.count({ where: { status: { in: ['PLACED', 'IN_TRANSIT', 'PARTIAL'] } } }),
      prisma.purchaseOrder.count({ where: { status: 'RECEIVED' } }),
    ]);

    // ── 兜底补查：收集 items.productIds 中引用但 products 关联缺失的产品 ──
    //
    // 场景：Product.purchaseOrderId 是单 FK，若同一产品被多次建单，
    // 后建的订单会覆盖 FK，导致先建订单的 products 关联断裂。
    // 这里通过 productIds JSON 做二次查找，确保前端始终能拿到明细。
    const missingPidSet = new Set<number>();
    for (const o of rawList) {
      const relatedIds = new Set(((o as any).products as any[] ?? []).map((p: any) => p.id));
      for (const item of ((o as any).items as any[] ?? [])) {
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          for (const pid of pids) {
            if (!relatedIds.has(pid)) missingPidSet.add(pid);
          }
        } catch { /* ignore */ }
      }
    }
    let fallbackProdMap = new Map<number, any>();
    if (missingPidSet.size > 0) {
      const fallbackProds = await prisma.product.findMany({
        where: { id: { in: Array.from(missingPidSet) } },
        select: {
          id: true, sku: true, chineseName: true, imageUrl: true,
          purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
          externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
          externalSynced: true, externalOrderId: true,
        },
      });
      fallbackProdMap = new Map(fallbackProds.map((p) => [p.id, p]));
    }

    // ── 合并 products 信息进 items，前端子表直接读 items[i].* ─────
    const list = rawList.map((o) => {
      const rawItems    = (o as any).items    as any[] ?? [];
      const rawProducts = (o as any).products as any[] ?? [];
      const prodById    = new Map<number, any>(rawProducts.map((p: any) => [p.id, p]));
      // 将兜底查到的产品也合入此 map
      for (const [pid, prod] of fallbackProdMap) {
        if (!prodById.has(pid)) prodById.set(pid, prod);
      }

      const mergedItems = rawItems.map((item: any, idx: number) => {
        let prod: any = null;
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          if (pids.length > 0) prod = prodById.get(pids[0]);
        } catch { /* ignore */ }
        if (!prod) prod = rawProducts[idx] ?? null;

        return {
          id:                 item.id,
          offerId:            item.offerId            ?? null,
          quantity:           item.quantity,
          alibabaOrderId:     item.alibabaOrderId     ?? null,
          alibabaOrderStatus: item.alibabaOrderStatus ?? null,
          alibabaTotalAmount: item.alibabaTotalAmount != null ? Number(item.alibabaTotalAmount) : null,
          shippingFee:        item.shippingFee        != null ? Number(item.shippingFee)        : null,
          logisticsCompany:   item.logisticsCompany   ?? null,
          logisticsNo:        item.logisticsNo        ?? null,
          // ★ 合并进来的产品字段，前端直接读
          productId:          prod?.id                ?? null,
          sku:                prod?.sku               ?? null,
          chineseName:        prod?.chineseName       ?? null,
          imageUrl:           prod?.imageUrl          ?? null,
          purchasePrice:      prod?.purchasePrice != null ? Number(prod.purchasePrice) : null,
          purchaseQuantity:   prod?.purchaseQuantity  ?? item.quantity,
          purchaseUrl:        prod?.purchaseUrl       ?? null,
          // ★ 1688 映射字段：前端下单弹窗必需
          externalProductId:  prod?.externalProductId ?? null,  // 1688 offerId
          externalSkuId:      prod?.externalSkuId     ?? null,  // 1688 specId（32位MD5）
          externalSkuIdNum:   prod?.externalSkuIdNum  ?? null,  // 1688 skuId（纯数字兜底）
          externalSynced:     prod?.externalSynced    ?? false, // 是否已映射 1688
          externalOrderId:    prod?.externalOrderId   ?? null,  // 已下单的 1688 订单号
        };
      });

      return {
        id:              o.id,
        orderNo:         o.orderNo,
        operator:        o.operator,
        totalAmount:     Number(o.totalAmount),
        itemCount:       o.itemCount,
        status:          o.status,
        remark:          (o as any).remark           ?? null,
        // ★ 新字段：1688 订单号、供应商、物流
        alibabaOrderId:  (o as any).alibabaOrderId   ?? null,
        supplierName:    (o as any).supplierName      ?? null,
        logisticsCompany:(o as any).logisticsCompany  ?? null,
        trackingNumber:  (o as any).trackingNumber    ?? null,
        logisticsStatus: (o as any).logisticsStatus   ?? null,
        createdAt:       o.createdAt,
        items:           mergedItems,    // ← 已合并产品信息，前端子表直接用
        products:        Array.from(prodById.values()),  // ← 含兜底补查，向后兼容
        warehouse:       (o as any).warehouse ?? null,
      };
    });

    res.json({
      code: 200,
      data: {
        total, page, pageSize, list,
        tabCounts: {
          ALL:        cntPending + cntPurchasing + cntCompleted,
          PENDING:    cntPending,
          PURCHASING: cntPurchasing,
          COMPLETED:  cntCompleted,
        },
      },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/purchases]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单列表失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id/products
//
// 采购单子表明细（前端展开行时调用）
//
// 返回该采购单下所有关联产品，并融合 PurchaseOrderItem 的 1688 字段。
// 注意：PurchaseOrderItem 无直接 FK 到 Product，通过两条查询 + 内存合并实现：
//   ① prisma.product.findMany({ where: { purchaseOrderId: id } })
//   ② prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } })
//   ③ 以 productIds JSON 为桥，将 item 字段合并进每个 product 行
//
// ★ 必须注册在 /:id 之前，否则 Express 会把 "products" 当作 id 参数。
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/products', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // ① 查关联产品（通过 Product.purchaseOrderId 反向关联）
    let products = await prisma.product.findMany({
      where:   { purchaseOrderId: id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, pnk: true, sku: true, chineseName: true,
        imageUrl: true, purchaseUrl: true,
        purchasePrice: true, purchaseQuantity: true,
        // ★ 1688 映射核心字段
        externalProductId: true,   // 1688 offerId
        externalSkuId:     true,   // 1688 specId（32位MD5，下单必填）
        externalSkuIdNum:  true,   // 1688 skuId（纯数字，兜底）
        externalSynced:    true,   // 是否已映射确认
        externalOrderId:   true,   // 已下单时的 1688 订单号
        status: true,
      },
    });

    // ② 查子单明细（PurchaseOrderItem）
    const orderItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: id },
      select: {
        id: true, offerId: true, productIds: true, quantity: true,
        alibabaOrderId: true, alibabaOrderStatus: true,
        alibabaTotalAmount: true, shippingFee: true,
        logisticsCompany: true, logisticsNo: true,
      },
    });

    // ③ 建立 productId → item 的映射（通过 productIds JSON 解析）
    const itemByProductId = new Map<number, typeof orderItems[0]>();
    for (const item of orderItems) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          if (!itemByProductId.has(pid)) itemByProductId.set(pid, item);
        }
      } catch { /* ignore malformed JSON */ }
    }

    // ③.5 兜底补查：当 Product.purchaseOrderId FK 被后建订单覆盖导致 products 为空时，
    //       通过 items.productIds JSON 直接按 ID 查补，确保展开行永不空白。
    if (products.length === 0 && itemByProductId.size > 0) {
      const fallbackIds = Array.from(itemByProductId.keys());
      const fallbackProds = await prisma.product.findMany({
        where: { id: { in: fallbackIds } },
        select: {
          id: true, pnk: true, sku: true, chineseName: true,
          imageUrl: true, purchaseUrl: true,
          purchasePrice: true, purchaseQuantity: true,
          externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
          externalSynced: true, externalOrderId: true,
          status: true,
        },
      });
      products = fallbackProds as typeof products;
      console.log(
        `[GET /purchases/${id}/products] ⚠️ FK断裂兜底：products原为空，` +
        `通过 itemByProductId 补查到 ${products.length} 个产品 → ids: ${fallbackIds.join(',')}`,
      );
    }

    // ④ debug：打印关键采购单的数据结构，供验证
    console.log(
      `[GET /purchases/${id}/products] products=${products.length} items=${orderItems.length}` +
      (products.length > 0 ? ` | skus: ${products.map((p) => p.sku).join(',')}` : ' | ⚠️ products仍为空！'),
    );

    // ⑤ 合并：每个 product 行追加对应的 1688 item 字段
    const list = products.map((p) => {
      const item = itemByProductId.get(p.id);
      return {
        // 产品基础字段
        id:               p.id,
        pnk:              p.pnk,
        sku:              p.sku              ?? null,
        chineseName:      p.chineseName      ?? null,
        imageUrl:         p.imageUrl         ?? null,
        purchaseUrl:      p.purchaseUrl      ?? null,
        purchasePrice:    p.purchasePrice    != null ? Number(p.purchasePrice) : null,
        purchaseQuantity: p.purchaseQuantity ?? null,
        status:           p.status,
        // ★ 1688 映射字段
        externalProductId: p.externalProductId ?? null,  // 1688 offerId
        externalSkuId:     p.externalSkuId     ?? null,  // 1688 specId
        externalSkuIdNum:  p.externalSkuIdNum  ?? null,  // 1688 skuId 纯数字
        externalSynced:    p.externalSynced    ?? false,
        externalOrderId:   p.externalOrderId   ?? null,
        // 1688 子单字段（无子单时为 null）
        purchaseOrderItemId: item?.id                                          ?? null,
        offerId:             item?.offerId                                     ?? null,
        quantity:            item?.quantity                                    ?? p.purchaseQuantity ?? null,
        alibabaOrderId:      item?.alibabaOrderId                              ?? null,
        alibabaOrderStatus:  item?.alibabaOrderStatus                          ?? null,
        alibabaTotalAmount:  item?.alibabaTotalAmount != null
                               ? Number(item.alibabaTotalAmount)               : null,
        shippingFee:         item?.shippingFee        != null
                               ? Number(item.shippingFee)                      : null,
        logisticsCompany:    item?.logisticsCompany                            ?? null,
        logisticsNo:         item?.logisticsNo                                 ?? null,
      };
    });

    console.log(`[GET /purchases/${id}/products] ✅ 最终返回 list.length=${list.length}`);
    res.json({ code: 200, data: list, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id/products]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单明细失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/sync-1688
//
// 原子同步：订单状态 + 专项物流信息 一次请求全部落库。
//
// 内部串行调用两个 1688 接口：
//   ① alibaba.trade.get.buyerView          → 订单状态 / 供应商 / 基础物流
//   ② alibaba.trade.getLogisticsInfos.buyerView → 精确物流单号 / 公司 / logisticsId
//
// 合并规则（物流字段优先级）：
//   logisticsCompany : getLogisticsInfos 优先，buyerView 兜底
//   trackingNumber   : getLogisticsInfos.logisticsBillNo 优先，buyerView.logisticsId 兜底
//
// 前提：主单必须已有 alibabaOrderId。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/sync-1688', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 取主单
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true,
        items: { select: { id: true } },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该订单未关联 1688 单号，无法同步。请先通过 bind-1688-order 或 place-1688-order 绑定 1688 订单号',
      });
      return;
    }

    const aliOrderId = order.alibabaOrderId;

    // ── ① alibaba.trade.get.buyerView（订单状态 + 供应商 + 基础物流） ──
    const detail = await syncOrderDetail(aliOrderId);
    if (isAliServiceError(detail)) {
      res.status(502).json({
        code: 502, data: null,
        message: detail.message,
        errorCode: detail.errorCode,
      });
      return;
    }

    // ── buyerView 返回的物流数据（取第一条，多包裹取最新包裹） ───
    // 注意：alibaba.trade.getLogisticsInfos.buyerView 需要独立权限套餐，
    //       若应用未开通则返回 gw.APIUnsupported。
    //       buyerView 已在 logisticsOrders 中包含完整物流信息，直接使用，无需额外调用。
    const firstLogistics = detail.logisticsOrders[0] ?? null;

    // ── 状态映射：1688 状态文本 → 人类可读中文 ───────────────────
    const STATUS_MAP: Record<string, string> = {
      waitbuyerpay:     '等待买家付款',
      waitallpay:       '等待拼单付款',
      waitsellersend:   '等待卖家发货',
      waitbuyerreceive: '等待买家收货',
      success:          '交易成功',
      closed:           '交易关闭',
      cancelled:        '已取消',
    };
    const humanStatus = STATUS_MAP[detail.alibabaStatus] ?? detail.alibabaStatus;

    // ── 构建一次性落库数据对象 ───────────────────────────────────
    const updateData: Record<string, unknown> = {
      supplierName:    detail.supplierName ?? detail.sellerLoginId ?? undefined,
      logisticsStatus: firstLogistics
        ? `[${firstLogistics.logisticsCompanyName}] ${firstLogistics.logisticsStatus || humanStatus}`
        : humanStatus,
    };
    if (firstLogistics?.logisticsCompanyName) updateData.logisticsCompany = firstLogistics.logisticsCompanyName;
    if (firstLogistics?.logisticsId)          updateData.trackingNumber   = firstLogistics.logisticsId;

    // ── 同步子单状态与金额（PurchaseOrderItem） ──────────────────
    if (order.items.length > 0) {
      await prisma.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderStatus: detail.alibabaStatus,
          alibabaTotalAmount: detail.totalAmount > 0 ? detail.totalAmount : undefined,
          shippingFee:        detail.shippingFee  > 0 ? detail.shippingFee  : undefined,
        },
      });
    }

    // ── 原子落库至 PurchaseOrder 主单 ────────────────────────────
    const updated = await prisma.purchaseOrder.update({
      where:  { id },
      data:   updateData,
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true, supplierName: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
        warehouse: { select: { id: true, name: true } },
      },
    });

    console.log(
      `[sync-1688] 采购单 #${id}(${order.orderNo}) 同步完成：` +
      `aliStatus=${detail.alibabaStatus} | ` +
      `company=${firstLogistics?.logisticsCompanyName ?? 'none'} | ` +
      `trackingNo=${firstLogistics?.logisticsId ?? 'none'}`,
    );

    res.json({
      code: 200,
      data: {
        order: updated,
        alibabaStatus:    detail.alibabaStatus,
        alibabaStatusCN:  humanStatus,
        totalAmount:      detail.totalAmount,
        shippingFee:      detail.shippingFee,
        sellerLoginId:    detail.sellerLoginId,
        logisticsOrders:  detail.logisticsOrders,
      },
      message: `1688 订单状态与物流信息已同步：${humanStatus}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/sync-1688]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '同步失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/sync-logistics
//
// 专项物流信息同步：调用 alibaba.trade.getLogisticsInfos.buyerView，
// 提取物流公司名 + 运单号 + logisticsId，落库至 PurchaseOrder 主单。
//
// 前提：主单必须已有 alibabaOrderId。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/sync-logistics', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, alibabaOrderId: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该采购单未关联 1688 单号，请先绑定后再同步物流',
      });
      return;
    }

    // 调用 alibaba.trade.getLogisticsInfos.buyerView
    const infosResult = await syncLogisticsInfos(order.alibabaOrderId);
    if (isAliServiceError(infosResult)) {
      res.status(502).json({ code: 502, data: null, message: infosResult.message, errorCode: infosResult.errorCode });
      return;
    }

    if (infosResult.logisticsInfos.length === 0) {
      res.json({
        code: 200,
        data: { synced: false, reason: '1688 暂无物流记录（可能尚未发货）' },
        message: '暂无物流信息，可能尚未发货',
      });
      return;
    }

    // 取第一条物流单写入主单（多包裹场景下首包为主）
    const first = infosResult.logisticsInfos[0];

    const updateData: Record<string, string> = {};
    if (first.logisticsCompanyName) updateData.logisticsCompany = first.logisticsCompanyName;
    if (first.logisticsBillNo)      updateData.trackingNumber   = first.logisticsBillNo;
    // logisticsId 暂无专属字段，复用 trackingNumber 为主（若二者不同则以 logisticsBillNo 为准）

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, orderNo: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
      },
    });

    console.log(
      `[sync-logistics] 采购单 #${id}(${order.orderNo}) 物流落库 → ` +
      `公司=${first.logisticsCompanyName} 运单号=${first.logisticsBillNo} logisticsId=${first.logisticsId}`,
    );

    res.json({
      code: 200,
      data: {
        order: updated,
        logisticsInfos: infosResult.logisticsInfos,
      },
      message: `物流信息已同步：${first.logisticsCompanyName} ${first.logisticsBillNo}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/sync-logistics]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '物流信息同步失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id/logistics-trace
//
// 查询物流轨迹流转节点。
//
// 优先级策略（三级降级）：
//   ① alibaba.trade.getLogisticsTraceInfo.buyerView（按订单号直查，首选）
//   ② 已落库的 trackingNumber → alibaba.logistics.trace.info.get（兜底）
//   ③ 先调 buyerView 拿运单号 → 再查轨迹（兜底的兜底）
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/logistics-trace', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: {
        id: true, orderNo: true,
        alibabaOrderId: true,
        trackingNumber: true,
        logisticsCompany: true,
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该订单未关联 1688 单号，无法查询物流轨迹',
      });
      return;
    }

    // ── 统一节点格式转换（内部 eventTime/description → 前端 Timeline 所需 time/content） ──
    const toTimelineNodes = (nodes: Array<{ eventTime: string; description: string; location: string | null }>) =>
      nodes.map((n) => ({
        time:        n.eventTime,
        content:     n.description,
        location:    n.location ?? null,
        // 保留原始字段，向后兼容
        eventTime:   n.eventTime,
        description: n.description,
      })).sort((a, b) => {
        const ta = new Date(a.time).getTime();
        const tb = new Date(b.time).getTime();
        return isNaN(ta) || isNaN(tb) ? 0 : tb - ta;
      });

    // ── ① 优先：alibaba.trade.getLogisticsTraceInfo.buyerView ────────
    //   namespace 必须为 com.alibaba.logistics（已修正，旧写法 com.alibaba.trade → gw.APIUnsupported）
    const traceByOrder = await getLogisticsTraceByOrder(order.alibabaOrderId);
    if (!isAliServiceError(traceByOrder) && traceByOrder.nodes.length > 0) {
      // 顺手把运单号落库（防止下次再请求）
      if (traceByOrder.logisticsBillNo || traceByOrder.logisticsId) {
        const trackingNum = traceByOrder.logisticsBillNo || traceByOrder.logisticsId;
        await prisma.purchaseOrder.update({
          where: { id },
          data: {
            trackingNumber:   trackingNum || undefined,
            logisticsCompany: traceByOrder.logisticsCompanyName || undefined,
          },
        }).catch(() => { /* 落库失败不影响主流程 */ });
      }

      res.json({
        code: 200,
        data: {
          logisticsId:          traceByOrder.logisticsId || traceByOrder.logisticsBillNo,
          logisticsBillNo:      traceByOrder.logisticsBillNo,
          logisticsCompanyName: traceByOrder.logisticsCompanyName,
          nodes:                toTimelineNodes(traceByOrder.nodes),
          source:               'buyerView',
        },
        message: 'success',
      });
      return;
    }

    // ── ① 降级处理：getLogisticsTraceInfo 返回 gw.APIUnsupported 表示账号未开通此权限 ──
    //   不再抛 502，转走 ② 兜底链路
    if (isAliServiceError(traceByOrder)) {
      console.warn(
        `[logistics-trace] getLogisticsTraceInfo.buyerView 失败（${traceByOrder.errorCode}）` +
        `，降级走 alibaba.logistics.trace.info.get 或 sync-1688 链路`,
      );
    }

    // ── ② 兜底：按已落库运单号 → alibaba.logistics.trace.info.get ───
    let logisticsId = order.trackingNumber;
    let companyName = order.logisticsCompany ?? '';

    // ── ③ 兜底的兜底：先调 buyerView 拿运单号 ──────────────────────
    if (!logisticsId) {
      const detail = await syncOrderDetail(order.alibabaOrderId);
      if (isAliServiceError(detail)) {
        // 三级均失败；若 gw.APIUnsupported 则友好提示，否则 502
        const errMsg = isAliServiceError(traceByOrder) ? traceByOrder.message : detail.message;
        const isUnsupported = (traceByOrder as any)?.errorCode === 'gw.APIUnsupported'
          || detail.errorCode === 'gw.APIUnsupported';
        if (isUnsupported) {
          res.json({
            code: 200,
            data: { nodes: [], logisticsCompanyName: '', logisticsBillNo: '', unsupported: true },
            message: '当前 1688 应用未开通物流轨迹查询权限，请在 1688 开放平台申请开通',
          });
        } else {
          res.status(502).json({ code: 502, data: null, message: errMsg });
        }
        return;
      }
      const first = detail.logisticsOrders[0] ?? null;
      if (!first?.logisticsId) {
        res.json({
          code: 200,
          data: { nodes: [], logisticsCompanyName: companyName, logisticsBillNo: '', noShipment: true },
          message: '该 1688 订单暂无物流运单号（可能尚未发货）',
        });
        return;
      }
      logisticsId = first.logisticsId;
      companyName = first.logisticsCompanyName;
      await prisma.purchaseOrder.update({
        where: { id },
        data: { trackingNumber: logisticsId, logisticsCompany: companyName || undefined },
      }).catch(() => {});
    }

    const trace = await getLogisticsTrace(logisticsId);
    if (isAliServiceError(trace)) {
      // gw.APIUnsupported → 降级为友好提示
      if ((trace as any).errorCode === 'gw.APIUnsupported') {
        res.json({
          code: 200,
          data: {
            nodes: [], logisticsCompanyName: companyName,
            logisticsBillNo: logisticsId, unsupported: true,
          },
          message: '当前 1688 应用未开通物流轨迹查询权限，请在 1688 开放平台申请开通',
        });
      } else {
        res.status(502).json({ code: 502, data: null, message: trace.message });
      }
      return;
    }

    res.json({
      code: 200,
      data: {
        logisticsId,
        logisticsBillNo:      logisticsId,
        logisticsCompanyName: trace.logisticsCompanyName || companyName,
        nodes:                toTimelineNodes(trace.nodes),
        source:               'logisticsTrace',
      },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id/logistics-trace]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '查询物流轨迹失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/purchases/:id/logistics
//
// 手动回填 / 更新物流信息（支持线下采购场景）
//
// Body（均可选，至少传一个）:
//   logisticsCompany  String  物流公司（如：极兔、顺丰、中通）
//   trackingNumber    String  运单号
//   logisticsStatus   String  最新物流状态文本（可选）
//   supplierName      String  供应商名称（可选）
//   alibabaOrderId    String  1688 订单号（可选，补录）
// ─────────────────────────────────────────────────────────────────────
router.patch('/:id/logistics', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const {
      logisticsCompany,
      trackingNumber,
      logisticsStatus,
      supplierName,
      alibabaOrderId: aliId,
    } = req.body ?? {};

    // 至少需要提供一个有效字段
    const updateData: Record<string, string> = {};
    if (logisticsCompany && String(logisticsCompany).trim())
      updateData.logisticsCompany = String(logisticsCompany).trim();
    if (trackingNumber && String(trackingNumber).trim())
      updateData.trackingNumber   = String(trackingNumber).trim();
    if (logisticsStatus && String(logisticsStatus).trim())
      updateData.logisticsStatus  = String(logisticsStatus).trim();
    if (supplierName && String(supplierName).trim())
      updateData.supplierName     = String(supplierName).trim();
    if (aliId && String(aliId).trim())
      updateData.alibabaOrderId   = String(aliId).trim();

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({
        code: 400, data: null,
        message: '请至少提供一个字段（logisticsCompany / trackingNumber / logisticsStatus / supplierName / alibabaOrderId）',
      });
      return;
    }

    // 校验采购单存在
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, status: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true, supplierName: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
        warehouse: { select: { id: true, name: true } },
      },
    });

    console.log(
      `[logistics] 采购单 #${id}(${order.orderNo}) 物流信息更新：`,
      JSON.stringify(updateData),
    );

    res.json({
      code: 200,
      data: updated,
      message: '物流信息已更新',
    });
  } catch (err: any) {
    console.error('[PATCH /api/purchases/:id/logistics]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新物流信息失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/purchases/:id/warehouse
//
// 前置绑定目标入库仓库（任意状态均可更新，RECEIVED 除外）
// Body: { warehouseId: number }
// ─────────────────────────────────────────────────────────────────────
router.patch('/:id/warehouse', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId } = req.body ?? {};
    const whId = parseInt(String(warehouseId), 10);
    if (isNaN(whId) || whId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId 为必填项且必须是有效数字' });
      return;
    }

    // 校验仓库存在且启用
    const wh = await prisma.warehouse.findUnique({
      where:  { id: whId },
      select: { id: true, name: true, status: true },
    });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用，请重新选择' });
      return;
    }

    // 校验采购单存在
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, status: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'RECEIVED') {
      res.status(400).json({ code: 400, data: null, message: '已入库的采购单不允许修改目标仓库' });
      return;
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  { warehouseId: whId },
      select: {
        id: true, orderNo: true, status: true,
        warehouseId: true,
        warehouse: { select: { id: true, name: true, type: true } },
      },
    });

    console.log(`[warehouse] 采购单 #${id}(${order.orderNo}) 绑定仓库 → ${wh.name}(id=${whId})`);
    res.json({
      code: 200,
      data: updated,
      message: `目标仓库已更新为【${wh.name}】`,
    });
  } catch (err: any) {
    console.error('[PATCH /api/purchases/:id/warehouse]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新仓库失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id
// 采购单详情
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: true,
        products: {
          select: {
            id: true, sku: true, chineseName: true, title: true, imageUrl: true,
            purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
            externalProductId: true, externalSkuId: true, externalOrderId: true,
          },
        },
        warehouse: { select: { id: true, name: true, type: true, status: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    res.json({ code: 200, data: order, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单详情失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/place-1688-order
//
// 在采购管理页手动触发真实 1688 下单（解耦后的第二步）
//
// 前置条件：采购单 status 必须是 PENDING；关联产品必须已绑定 1688 offerId + specId
// Body: { addressId?: string }（可选收货地址，不传则用环境变量默认地址）
//
// 流程：
//   ① 查本地采购单 + 关联产品
//   ② 组装 cargo → 调用 alibaba.trade.fastCreateOrder
//   ③ 回填 PurchaseOrderItem.alibabaOrderId + Product.externalOrderId
//   ④ PurchaseOrder.status → PLACED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/place-1688-order', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { addressId } = req.body ?? {};

    // ── 查采购单 + 关联产品 ────────────────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items:    { select: { id: true, offerId: true, quantity: true, alibabaOrderId: true } },
        products: {
          select: {
            id: true, sku: true, chineseName: true,
            externalProductId: true, externalSkuId: true, purchaseQuantity: true,
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ★ 防呆：下单前必须已绑定目标仓库
    if (!order.warehouseId) {
      res.status(400).json({
        code: 400, data: null,
        message: '请先指定入库目标仓库后再进行下单操作！（PATCH /api/purchases/:id/warehouse）',
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({
        code: 400, data: null,
        message: `当前状态为 ${order.status}，仅 PENDING（待下单）状态可以执行 1688 下单`,
      });
      return;
    }

    // 已经有 1688 订单号的子单不允许重复下单
    const alreadyPlaced = order.items.find((i) => !!i.alibabaOrderId);
    if (alreadyPlaced) {
      res.status(400).json({
        code: 400, data: null,
        message: `该采购单已有 1688 订单号 ${alreadyPlaced.alibabaOrderId}，请勿重复下单`,
      });
      return;
    }

    // ── 组装 1688 下单参数 ─────────────────────────────────────────
    const SPEC_ID_REGEX = /^[a-fA-F0-9]{32}$/;
    const validProducts = order.products.filter(
      (p) => p.externalProductId && p.externalSkuId && SPEC_ID_REGEX.test(p.externalSkuId),
    );

    if (validProducts.length === 0) {
      res.status(400).json({
        code: 400, data: null,
        message: '该采购单关联的产品未绑定有效的 1688 规格（需 offerId + 32位 MD5 specId），请先在采购计划页绑定 1688 规格',
      });
      return;
    }

    const cargoItems = validProducts.map((p) => ({
      offerId:  String(p.externalProductId!).trim(),
      specId:   String(p.externalSkuId!).trim(),
      quantity: Math.max(1, Number(p.purchaseQuantity) || order.items[0]?.quantity || 1),
    }));

    // ── 调用 1688 阿里巴巴开放平台 API ────────────────────────────
    const addressIdStr = addressId ? String(addressId) : undefined;
    const result = await createAlibabaOrder(cargoItems, addressIdStr);

    if (!result.success) {
      console.error(`[place-1688-order] 1688 下单失败 PO#${id}:`, result.errorMessage);
      res.json({
        code: 200,
        data: {
          success: false,
          errorCode:    result.errorCode,
          errorMessage: result.errorMessage,
          raw:          result.raw,
        },
        message: `1688 下单失败: ${result.errorMessage}`,
      });
      return;
    }

    const aliOrderId     = result.data!.orderId;
    const aliTotalAmount = result.data!.totalAmount;

    // 尝试从 1688 返回数据中提取供应商名称（字段因接口版本而异，做容错读取）
    const supplierName: string | null =
      (result.data as any)?.supplierLoginId ??
      (result.data as any)?.sellerLoginId   ??
      (result.data as any)?.supplierName    ?? null;

    // ── 回填数据库 ────────────────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      // 更新子单
      for (const item of order.items) {
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            alibabaOrderId:     aliOrderId,
            alibabaOrderStatus: 'waitbuyerpay',
            alibabaTotalAmount: aliTotalAmount > 0 ? aliTotalAmount : undefined,
          },
        });
      }

      // 更新主单：状态 + ★ 1688 订单号 + 供应商名称上移至主单
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:          'PLACED',
          totalAmount:     aliTotalAmount > 0 ? aliTotalAmount : order.totalAmount,
          alibabaOrderId:  aliOrderId,
          supplierName:    supplierName ?? undefined,
        },
      });

      // 更新关联产品
      await tx.product.updateMany({
        where: { id: { in: validProducts.map((p) => p.id) } },
        data:  { externalOrderId: aliOrderId, externalSynced: true, status: 'ORDERED' },
      });
    });

    console.log(
      `[place-1688-order] 采购单 PO#${id}(${order.orderNo}) → 1688 下单成功！` +
      `aliOrderId=${aliOrderId} amount=${aliTotalAmount}`,
    );

    res.json({
      code: 200,
      data: {
        success:     true,
        orderId:     id,
        orderNo:     order.orderNo,
        aliOrderId,
        aliTotalAmount,
      },
      message: `1688 下单成功！订单号: ${aliOrderId}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/place-1688-order]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '1688 下单接口异常' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/bind-1688-order
//
// 手动回填绑定：业务员线下已在 1688 下单，将订单号手动关联到内部采购单
//
// Body: { alibabaOrderId: string }
//
// 逻辑：
//   ① 校验采购单存在且状态为 PENDING（防止重复绑定）
//   ② 事务内：更新所有子单 PurchaseOrderItem.alibabaOrderId + 主单 status → PLACED
//   ③ 同步更新关联产品 externalOrderId、状态 → ORDERED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/bind-1688-order', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { alibabaOrderId, supplierName } = req.body ?? {};

    // 参数校验
    if (!alibabaOrderId || typeof alibabaOrderId !== 'string' || !alibabaOrderId.trim()) {
      res.status(400).json({ code: 400, data: null, message: 'alibabaOrderId（1688 官方订单号）为必填项' });
      return;
    }
    const cleanAliOrderId  = alibabaOrderId.trim();
    const cleanSupplierName = supplierName ? String(supplierName).trim() : null;

    // 查采购单（含子单 + 关联产品）
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items:    { select: { id: true, alibabaOrderId: true } },
        products: { select: { id: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // 防止重复绑定：已有 1688 订单号则拒绝
    const alreadyBound = order.items.find((i) => !!i.alibabaOrderId);
    if (alreadyBound) {
      res.status(400).json({
        code: 400, data: null,
        message: `该采购单已绑定 1688 订单号 ${alreadyBound.alibabaOrderId}，如需修改请联系管理员`,
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({
        code: 400, data: null,
        message: `当前状态为 ${order.status}，仅 PENDING（待下单）状态允许手动绑定 1688 订单号`,
      });
      return;
    }

    // ── 事务：回填订单号 + 更新状态 ──────────────────────────────
    await prisma.$transaction(async (tx) => {
      // 1. 所有子单回填 alibabaOrderId + 状态标记
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderId:     cleanAliOrderId,
          alibabaOrderStatus: 'waitbuyerpay',   // 线下下单默认为待付款
        },
      });

      // 2. 主单状态 → PLACED，同步回填 1688 订单号 + 供应商至主单
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:         'PLACED',
          alibabaOrderId: cleanAliOrderId,
          supplierName:   cleanSupplierName ?? undefined,
        },
      });

      // 3. 关联产品：回填 externalOrderId、标记已同步
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            externalOrderId: cleanAliOrderId,
            externalSynced:  true,
            status:          'ORDERED',
          },
        });
      }
    });

    console.log(
      `[bind-1688-order] 采购单 #${id}(${order.orderNo}) 手动绑定 1688 订单号 ${cleanAliOrderId}，` +
      `状态 PENDING → PLACED`,
    );

    res.json({
      code: 200,
      data: {
        orderId:       id,
        orderNo:       order.orderNo,
        alibabaOrderId: cleanAliOrderId,
        status:        'PLACED',
      },
      message: `1688 订单号 ${cleanAliOrderId} 已成功绑定到采购单 ${order.orderNo}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/bind-1688-order]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '绑定失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/mark-purchasing
//
// 线下采购标记：不走 1688 API，直接将本地采购单状态更新为"采购中"
// 适用场景：业务员线下打款 / 微信下单 / 非 1688 渠道采购
//
// 可选 Body: { alibabaOrderId?: string }（如有线下单号可一并回填）
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/mark-purchasing', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: { select: { id: true } }, products: { select: { id: true } } },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ★ 防呆：线下采购标记前也必须先绑定目标仓库
    if (!order.warehouseId) {
      res.status(400).json({
        code: 400, data: null,
        message: '请先指定入库目标仓库后再进行下单操作！（PATCH /api/purchases/:id/warehouse）',
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({ code: 400, data: null, message: `当前状态 ${order.status}，仅 PENDING 可标记为采购中` });
      return;
    }

    const { alibabaOrderId } = req.body ?? {};
    const cleanAliId = alibabaOrderId ? String(alibabaOrderId).trim() : null;

    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: 'PLACED' },
      });

      if (cleanAliId) {
        await tx.purchaseOrderItem.updateMany({
          where: { purchaseOrderId: id },
          data: { alibabaOrderId: cleanAliId, alibabaOrderStatus: 'waitbuyerpay' },
        });
      }

      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data:  { status: 'ORDERED', ...(cleanAliId ? { externalOrderId: cleanAliId, externalSynced: true } : {}) },
        });
      }
    });

    console.log(`[mark-purchasing] 采购单 #${id}(${order.orderNo}) PENDING → PLACED（线下采购）`);
    res.json({
      code: 200,
      data: { orderId: id, orderNo: order.orderNo, status: 'PLACED' },
      message: '已标记为采购中',
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/mark-purchasing]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '操作失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/stock-in
//
// 精准入库（支持分批到货）：仓库人员清点实物后，按实盘量累加入库。
//
// Body:
//   warehouseId  number    目标入库仓（必填）
//   items        Array?    实盘明细（可选）
//     └ productId       number  产品 ID
//     └ receivedQuantity number  本次实际到货数量（必须 > 0）
//
// 若不传 items，则兜底使用 purchaseQuantity（向后兼容旧版一键入库）。
//
// 状态流转：
//   (PLACED | IN_TRANSIT | PARTIAL) + 本次入库后：
//     → 累计已收 >= 计划数量：status = RECEIVED（全部到货，闭环）
//     → 累计已收 <  计划数量：status = PARTIAL（部分到货，等待剩余）
//
// 事务逻辑：
//   ① 累加 PurchaseOrderItem.receivedQuantity（按 productIds JSON 映射）
//   ② WarehouseStock upsert（stockQuantity += 本次实盘量）
//   ③ 扣减在途库存（GREATEST 防负数）
//   ④ 重聚合 Product.stockActual（汇总全仓库存）
//   ⑤ 写 PURCHASE_IN 库存流水（含计划/实收差异备注）
//   ⑥ 全部到货时：产品 status → SELECTED（回归正常在售态）
//   ⑦ 主单 status → PARTIAL 或 RECEIVED
//
// ★ FK 断裂兜底：通过 PurchaseOrderItem.productIds JSON 补查产品，确保不漏 SKU。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/stock-in', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId, items: receivedItems } = req.body ?? {};

    // ── 校验 warehouseId ──────────────────────────────────────────
    const whId = parseInt(String(warehouseId), 10);
    if (isNaN(whId) || whId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId（目标仓库）为必填项' });
      return;
    }
    const wh = await prisma.warehouse.findUnique({ where: { id: whId }, select: { id: true, name: true, status: true } });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用' });
      return;
    }

    // ── 校验 items 实盘数据（若传入） ────────────────────────────
    let receivedMap = new Map<number, number>(); // productId → receivedQuantity
    if (Array.isArray(receivedItems) && receivedItems.length > 0) {
      for (const item of receivedItems) {
        const pid = parseInt(String(item.productId), 10);
        const qty = Number(item.receivedQuantity);
        if (isNaN(pid) || pid <= 0) {
          res.status(400).json({ code: 400, data: null, message: `items 中存在无效的 productId: ${item.productId}` });
          return;
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          res.status(400).json({ code: 400, data: null, message: `productId=${pid} 的 receivedQuantity 必须大于 0` });
          return;
        }
        receivedMap.set(pid, Math.floor(qty)); // 取整，防止小数库存
      }
    }

    // ── 查采购单 + 关联产品 + 子单 ───────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        products: {
          select: { id: true, sku: true, purchaseQuantity: true, purchasePrice: true },
        },
        items: {
          select: { id: true, productIds: true, quantity: true },
        },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 状态拦截：只允许 PLACED / IN_TRANSIT / PARTIAL 执行入库 ──
    const STOCKIN_ALLOWED = ['PLACED', 'IN_TRANSIT', 'PARTIAL'];
    if (!STOCKIN_ALLOWED.includes(order.status)) {
      const hint = order.status === 'RECEIVED'
        ? '该采购单已全部入库，请勿重复操作'
        : `当前状态 ${order.status} 不支持入库，请先完成下单`;
      res.status(400).json({ code: 400, data: null, message: hint });
      return;
    }

    // ── 构建产品全集（FK 正常路径 + FK 断裂兜底路径） ────────────
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

    // 补查 FK 断裂产品
    const knownProdMap = new Map(order.products.map((p) => [p.id, p]));
    const missingIds   = Array.from(productIdSet).filter((pid) => !knownProdMap.has(pid));
    if (missingIds.length > 0) {
      const fallback = await prisma.product.findMany({
        where:  { id: { in: missingIds } },
        select: { id: true, sku: true, purchaseQuantity: true, purchasePrice: true },
      });
      for (const p of fallback) knownProdMap.set(p.id, p);
    }
    const allProducts = Array.from(knownProdMap.values());

    // ── 若前端未传实盘量，兜底使用 purchaseQuantity ──────────────
    if (receivedMap.size === 0) {
      for (const prod of allProducts) {
        receivedMap.set(prod.id, Math.max(1, prod.purchaseQuantity ?? 1));
      }
    }

    // ── 建立 productId → PurchaseOrderItem 映射（用于累加 receivedQuantity） ──
    const productToItemMap = new Map<number, number>(); // productId → itemId
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          if (!productToItemMap.has(pid)) productToItemMap.set(pid, item.id);
        }
      } catch { /* ignore */ }
    }

    const userId = req.user!.userId;
    const stockDetails: Array<{ productId: number; sku: string; receivedQty: number; newStockActual: number }> = [];

    await prisma.$transaction(async (tx) => {
      for (const prod of allProducts) {
        const receivedQty = receivedMap.get(prod.id) ?? 0;
        if (receivedQty <= 0) continue;

        // ① 累加 PurchaseOrderItem.receivedQuantity（追踪历次到货总量）
        const itemId = productToItemMap.get(prod.id);
        if (itemId) {
          await tx.purchaseOrderItem.update({
            where: { id: itemId },
            data:  { receivedQuantity: { increment: receivedQty } },
          });
        }

        // ② WarehouseStock upsert：按实盘量累加物理库存
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
          create: { productId: prod.id, warehouseId: whId, stockQuantity: receivedQty, inTransitQuantity: 0 },
          update: { stockQuantity: { increment: receivedQty } },
        });

        // ③ 扣减在途量（GREATEST 防负数）
        await tx.$executeRaw`
          UPDATE warehouse_stocks
          SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${receivedQty})
          WHERE  product_id = ${prod.id}
          AND    warehouse_id = ${whId}
        `;

        // ④ 重聚合 Product.stockActual
        const allWs = await tx.warehouseStock.findMany({
          where:  { productId: prod.id },
          select: { stockQuantity: true },
        });
        const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
        await tx.product.update({
          where: { id: prod.id },
          data:  { stockActual: newStockActual },
        });

        // ⑤ 写 PURCHASE_IN 流水（含计划/实收备注）
        const planQty  = prod.purchaseQuantity ?? 1;
        const diffNote = receivedQty !== planQty
          ? `（计划 ${planQty} 件，本次实收 ${receivedQty} 件）`
          : '';
        await applyStockChange(tx, {
          productId:      prod.id,
          warehouseId:    whId,
          changeQuantity: receivedQty,
          type:           'PURCHASE_IN',
          referenceId:    String(order.id),
          remark:         `采购单 ${order.orderNo} 精准入库${diffNote}（仓库: ${wh.name}）`,
          createdBy:      userId,
        });

        stockDetails.push({ productId: prod.id, sku: prod.sku ?? `#${prod.id}`, receivedQty, newStockActual });
      }

      // ⑥ 读取所有子单最新累计量，判断状态
      const updatedItems = await tx.purchaseOrderItem.findMany({
        where:  { purchaseOrderId: id },
        select: { quantity: true, receivedQuantity: true },
      });
      const totalPlan     = updatedItems.reduce((s, i) => s + i.quantity,         0);
      const totalReceived = updatedItems.reduce((s, i) => s + i.receivedQuantity, 0);
      const newStatus     = totalReceived >= totalPlan ? 'RECEIVED' : 'PARTIAL';

      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: newStatus as any, warehouseId: whId },
      });

      // ⑦ 全部到货时，产品回归正常在售态
      if (newStatus === 'RECEIVED') {
        await tx.product.updateMany({
          where: { id: { in: allProducts.map((p) => p.id) } },
          data:  { status: 'SELECTED' },
        });
      }
    });

    // 重新读取状态（事务内修改后 order 对象未刷新）
    const finalOrder  = await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } });
    const finalStatus = finalOrder?.status ?? 'PARTIAL';
    const totalReceivedQty = stockDetails.reduce((s, d) => s + d.receivedQty, 0);

    console.log(
      `[stock-in] 采购单 #${id}(${order.orderNo}) 入库 → ${wh.name}，` +
      `${stockDetails.length} SKU 合计实收 ${totalReceivedQty} 件，状态 → ${finalStatus}`,
    );

    res.json({
      code: 200,
      data: {
        orderId:         id,
        orderNo:         order.orderNo,
        status:          finalStatus,
        warehouse:       { id: wh.id, name: wh.name },
        stockedSkuCount: stockDetails.length,
        totalQuantity:   totalReceivedQty,
        details:         stockDetails,
        isPartial:       finalStatus === 'PARTIAL',
      },
      message: finalStatus === 'RECEIVED'
        ? `${stockDetails.length} 个 SKU 共 ${totalReceivedQty} 件已全部入库至【${wh.name}】`
        : `本次入库 ${totalReceivedQty} 件，采购单部分到货（PARTIAL），可继续入库或强制结单`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/stock-in]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '入库失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/force-complete
//
// 强制结单：针对 PARTIAL / PLACED / IN_TRANSIT 状态的采购单，
// 人工宣告放弃等待剩余货物，强制将订单状态更新为 RECEIVED（已结单）。
//
// ★ 核心库存清理：遍历所有子单，计算"永远不会到货"的欠量：
//   undeliveredQty = item.quantity - item.receivedQuantity
// 从 WarehouseStock.inTransitQuantity 中扣除欠量（GREATEST 防负数），
// 防止在途库存长期虚高影响补货决策。
//
// 事务逻辑：
//   ① 主单 status → RECEIVED
//   ② 遍历产品：计算欠量，扣减 inTransitQuantity（永不到货部分归零）
//   ③ 重聚合 Product.stockActual
//   ④ 产品 status → SELECTED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/force-complete', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 查主单 + 子单 + 关联产品
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: { id: true, productIds: true, quantity: true, receivedQuantity: true },
        },
        products: {
          select: { id: true, sku: true, purchaseQuantity: true },
        },
        warehouse: { select: { id: true, name: true } },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 状态拦截：只允许未完结的单强制结单 ──────────────────────
    const FORCE_ALLOWED = ['PLACED', 'IN_TRANSIT', 'PARTIAL'];
    if (!FORCE_ALLOWED.includes(order.status)) {
      const hint = order.status === 'RECEIVED'
        ? '该采购单已完成入库，无需强制结单'
        : `当前状态 ${order.status} 不支持强制结单`;
      res.status(400).json({ code: 400, data: null, message: hint });
      return;
    }

    // ── 构建产品全集（FK 正常 + FK 断裂兜底） ────────────────────
    const productIdSet = new Set<number>(order.products.map((p) => p.id));
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) productIdSet.add(pid);
      } catch { /* ignore */ }
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

    // ── 建立 productId → 欠量 映射 ───────────────────────────────
    // 欠量 = item.quantity(计划) - item.receivedQuantity(已收)
    const productToUndelivered = new Map<number, number>(); // productId → undeliveredQty
    for (const item of order.items) {
      const undelivered = Math.max(0, item.quantity - item.receivedQuantity);
      if (undelivered <= 0) continue;
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          productToUndelivered.set(pid, (productToUndelivered.get(pid) ?? 0) + undelivered);
        }
      } catch { /* ignore */ }
    }

    const whId = order.warehouseId;
    const cleanupSummary: Array<{ productId: number; sku: string; undeliveredQty: number }> = [];

    await prisma.$transaction(async (tx) => {
      // ① 主单 → RECEIVED（强制结单）
      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: 'RECEIVED' as any },
      });

      // ② 清理残留在途库存（永不到货的欠量）
      for (const prod of allProducts) {
        const undeliveredQty = productToUndelivered.get(prod.id) ?? 0;

        if (undeliveredQty > 0 && whId) {
          // ★ 核心：从 inTransitQuantity 中扣除欠量，防止在途库存长期虚高
          await tx.$executeRaw`
            UPDATE warehouse_stocks
            SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${undeliveredQty})
            WHERE  product_id = ${prod.id}
            AND    warehouse_id = ${whId}
          `;
          cleanupSummary.push({ productId: prod.id, sku: prod.sku ?? `#${prod.id}`, undeliveredQty });
        }

        // ③ 重聚合 Product.stockActual（在途减少后重算）
        const allWs = await tx.warehouseStock.findMany({
          where:  { productId: prod.id },
          select: { stockQuantity: true },
        });
        const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
        await tx.product.update({
          where: { id: prod.id },
          data:  { stockActual: newStockActual },
        });
      }

      // ④ 产品 status → SELECTED（正式回归库存在售态）
      if (allProducts.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: allProducts.map((p) => p.id) } },
          data:  { status: 'SELECTED' },
        });
      }
    });

    const totalCleanedQty = cleanupSummary.reduce((s, c) => s + c.undeliveredQty, 0);
    console.log(
      `[force-complete] 采购单 #${id}(${order.orderNo}) 强制结单：` +
      `清理 ${cleanupSummary.length} 个产品共 ${totalCleanedQty} 件在途残量`,
    );

    res.json({
      code: 200,
      data: {
        orderId:            id,
        orderNo:            order.orderNo,
        prevStatus:         order.status,
        currentStatus:      'RECEIVED',
        cleanedProductCount: cleanupSummary.length,
        totalCleanedQty,
        cleanupSummary,     // 各 SKU 清理详情（前端可展示）
      },
      message: cleanupSummary.length > 0
        ? `强制结单成功，已清理 ${cleanupSummary.length} 个 SKU 共 ${totalCleanedQty} 件在途残量`
        : '强制结单成功（所有货物已全部到货，无需清理在途库存）',
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/force-complete]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '强制结单失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/rollback
//
// 高危撤销：将采购单从任意状态强制回退至 PENDING（未下单）
//
// 核心逆向逻辑（事务内串行执行）：
//   ① 查主单 + 关联 items + products + warehouseId
//   ② 若状态为 RECEIVED（已入库）→ 逐 SKU 扣减 WarehouseStock.stockQuantity
//      + 重聚合 Product.stockActual + 写 MANUAL_ADJUST 流水（负数变动）
//   ③ 抹除 PurchaseOrderItem 的 1688 关联信息（alibabaOrderId / status）
//   ④ 主单重置：status → PENDING，warehouseId → null
//   ⑤ 关联产品重置：status → PURCHASING，externalOrderId → null，
//      purchaseOrderId 保留（产品仍绑在此采购单）
//
// 注意：已是 PENDING 的单直接返回 400，防止幂等误操作。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/rollback', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // ── 查主单及所有关联数据 ─────────────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: {
            id: true,
            alibabaOrderId: true,
            alibabaOrderStatus: true,
            quantity: true,
          },
        },
        products: {
          select: {
            id: true,
            sku: true,
            purchaseQuantity: true,
            stockActual: true,
          },
        },
        warehouse: { select: { id: true, name: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'PENDING') {
      res.status(400).json({ code: 400, data: null, message: '该采购单已是"未下单"状态，无需回退' });
      return;
    }

    const userId     = req.user!.userId;
    const wasReceived = order.status === 'RECEIVED';
    const whId        = order.warehouseId ?? null;

    // ── 事务：逆向操作全部在一个原子操作内完成 ─────────────────
    const rollbackSummary = await prisma.$transaction(async (tx) => {
      const stockChanges: Array<{ sku: string; before: number; after: number; delta: number }> = [];

      // ── Step ②：已入库 → 扣减多仓库存 ───────────────────────
      if (wasReceived && whId) {
        for (const prod of order.products) {
          const qty = Math.max(1, prod.purchaseQuantity ?? 1);

          // 扣减 WarehouseStock（防止负数：最多扣到 0）
          const ws = await tx.warehouseStock.findUnique({
            where: { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
            select: { stockQuantity: true },
          });
          const currentWsQty = ws?.stockQuantity ?? 0;
          const newWsQty     = Math.max(0, currentWsQty - qty);

          if (ws) {
            await tx.warehouseStock.update({
              where: { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
              data:  { stockQuantity: newWsQty },
            });
          }

          // 重聚合 Product.stockActual（所有仓库汇总）
          const allWs = await tx.warehouseStock.findMany({
            where:  { productId: prod.id },
            select: { stockQuantity: true },
          });
          const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
          await tx.product.update({
            where: { id: prod.id },
            data:  { stockActual: newStockActual },
          });

          // 写 MANUAL_ADJUST 流水（changeQuantity 为负数，记录为回退扣减）
          await applyStockChange(tx, {
            productId:      prod.id,
            warehouseId:    whId,
            changeQuantity: -(qty),
            type:           'MANUAL_ADJUST',
            referenceId:    String(order.id),
            remark:         `采购单回退 ${order.orderNo}：撤销入库，扣减库存`,
            createdBy:      userId,
          });

          stockChanges.push({
            sku:    prod.sku ?? String(prod.id),
            before: currentWsQty,
            after:  newWsQty,
            delta:  -(qty),
          });

          // ★ 重建在途库存：入库被撤销，货物逻辑上重回"在途"状态
          await tx.warehouseStock.upsert({
            where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
            create: { productId: prod.id, warehouseId: whId, inTransitQuantity: qty },
            update: { inTransitQuantity: { increment: qty } },
          });
        }
      }

      // ── Step ③：抹除 PurchaseOrderItem 的 1688 关联信息 ──────
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderId:     null,
          alibabaOrderStatus: null,
        },
      });

      // ── Step ④：主单重置 PENDING，清空 warehouseId ───────────
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:      'PENDING',
          warehouseId: null,
        },
      });

      // ── Step ⑤：关联产品状态回退 ─────────────────────────────
      // ORDERED → PURCHASING（回到采购计划待建单状态）
      // ★ 必须清空 purchaseOrderId：让产品重新出现在 GET /api/products/purchasing 列表
      // ★ 同时清空 externalOrderId / externalSynced（1688 订单信息作废）
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            status:          'PURCHASING',
            purchaseOrderId: null,    // 解除与采购单的绑定，让产品重回采购计划
            externalOrderId: null,
            externalSynced:  false,
          },
        });
      }

      return stockChanges;
    });

    const totalRolledBackQty = rollbackSummary.reduce((s, c) => s + Math.abs(c.delta), 0);

    console.log(
      `[rollback] 采购单 #${id}(${order.orderNo}) ${order.status} → PENDING，` +
      `库存回滚: ${wasReceived ? `${rollbackSummary.length} SKU 共 ${totalRolledBackQty} 件` : '无（非已入库状态）'}`,
    );

    res.json({
      code: 200,
      data: {
        orderId:      id,
        orderNo:      order.orderNo,
        prevStatus:   order.status,
        currentStatus: 'PENDING',
        stockRolledBack: wasReceived,
        warehouse:    order.warehouse ?? null,
        stockChanges: rollbackSummary,
      },
      message: wasReceived
        ? `采购单已回退至未下单，并已从【${order.warehouse?.name ?? '入库仓'}】扣减 ${totalRolledBackQty} 件库存`
        : `采购单已回退至未下单（原状态 ${order.status}，无库存变动）`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/rollback]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '回退失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/purchases/:id
//
// 作废并物理删除采购单（仅允许 PENDING 状态）
//
// 事务逻辑：
//   ① 状态拦截：非 PENDING 拒绝操作
//   ② 释放关联产品：purchaseOrderId → null，status → PURCHASING（回到采购计划）
//   ③ 删除 PurchaseOrderItem 子记录（FK 约束，必须先删）
//   ④ 物理删除 PurchaseOrder 主单
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 查主单（含关联产品 + 子单，以及仓库和采购数量，用于扣减在途库存）
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        products: { select: { id: true, sku: true, purchaseQuantity: true } },
        items:    { select: { id: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ① 状态拦截：只允许删除 PENDING（未下单）状态的采购单
    if (order.status !== 'PENDING') {
      const statusLabel: Record<string, string> = {
        PLACED:     '已下单',
        IN_TRANSIT: '运输中',
        RECEIVED:   '已入库',
      };
      const label = statusLabel[order.status] ?? order.status;
      res.status(400).json({
        code: 400,
        data: null,
        message: `该采购单当前状态为「${label}」，仅"待下单（PENDING）"状态的采购单可作废删除`,
      });
      return;
    }

    const username = req.user!.username ?? 'unknown';

    await prisma.$transaction(async (tx) => {
      // ② 释放关联产品：解除采购单绑定，状态退回采购计划（PURCHASING）
      //    purchaseOrderId: null → 产品重新出现在 GET /api/products/purchasing 列表
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            purchaseOrderId: null,
            status:          'PURCHASING',
          },
        });

        // ★ 扣减在途库存：采购单作废，货物不再在途（防负：用 GREATEST 钳制到 0）
        if (order.warehouseId) {
          for (const prod of order.products) {
            const qty = Math.max(1, prod.purchaseQuantity ?? 1);
            await tx.$executeRaw`
              UPDATE warehouse_stocks
              SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${qty})
              WHERE  product_id = ${prod.id}
              AND    warehouse_id = ${order.warehouseId}
            `;
          }
        }
      }

      // ③ 删除子单（FK 约束：必须先于主单删除）
      await tx.purchaseOrderItem.deleteMany({
        where: { purchaseOrderId: id },
      });

      // ④ 物理删除主单
      await tx.purchaseOrder.delete({ where: { id } });
    });

    console.log(
      `[DELETE /api/purchases/${id}] ${username} 作废采购单 ${order.orderNo}，` +
      `释放 ${order.products.length} 个产品回采购计划`,
    );

    res.json({
      code: 200,
      data: {
        deletedId:      id,
        orderNo:        order.orderNo,
        releasedCount:  order.products.length,
        releasedSkus:   order.products.map((p) => p.sku ?? `#${p.id}`),
      },
      message: `采购单 ${order.orderNo} 已作废，${order.products.length} 个产品已退回采购计划`,
    });
  } catch (err: any) {
    console.error('[DELETE /api/purchases/:id]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '作废采购单失败，请稍后重试' });
  }
});

export default router;
