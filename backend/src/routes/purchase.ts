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
  getLogisticsTrace,
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
    // PENDING   → 未下单（本地建单，尚未提交 1688）
    // PURCHASING → 采购中（PLACED=已下单 / IN_TRANSIT=运输中）
    // COMPLETED  → 已完成（RECEIVED=已入库）
    let statusFilter: string | { in: string[] } | undefined;
    switch (tabRaw) {
      case 'PENDING':
        statusFilter = 'PENDING';
        break;
      case 'PURCHASING':
        statusFilter = { in: ['PLACED', 'IN_TRANSIT'] };
        break;
      case 'COMPLETED':
        statusFilter = { in: ['RECEIVED'] };
        break;
      case 'PLACED':      statusFilter = 'PLACED';      break;
      case 'IN_TRANSIT':  statusFilter = 'IN_TRANSIT';  break;
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

    // ── ③ 用显式 AND 构建 where，彻底隔离状态过滤与关键词 OR 条件 ──
    //
    // 旧写法：Object.assign(where, { OR: [...] })
    //   → 产生 { status: X, OR: [...] }
    //   → Prisma 根级 OR 与根级 status 同级，OR 条件独立运算，
    //     可能返回不属于 status=X 的记录（BUG！）
    //
    // 新写法：显式 AND 数组，每个条件都是独立子句，互不影响
    //   → 产生 { AND: [{ status: X }, { OR: [...] }] }
    //   → 严格等价于 SQL: WHERE status=X AND (cond1 OR cond2 OR cond3)
    const andClauses: any[] = [];

    if (statusFilter !== undefined) {
      andClauses.push({ status: statusFilter });
    }

    if (kw) {
      andClauses.push({
        OR: [
          { orderNo:   { contains: kw, mode: 'insensitive' as const } },
          { items:     { some: { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } } } },
          { products:  { some: { sku:            { contains: kw, mode: 'insensitive' as const } } } },
        ],
      });
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
      prisma.purchaseOrder.count({ where: { status: { in: ['PLACED', 'IN_TRANSIT'] } } }),
      prisma.purchaseOrder.count({ where: { status: 'RECEIVED' } }),
    ]);

    // ── 合并 products 信息进 items，前端子表直接读 items[i].* ─────
    const list = rawList.map((o) => {
      const rawItems    = (o as any).items    as any[] ?? [];
      const rawProducts = (o as any).products as any[] ?? [];
      const prodById    = new Map<number, any>(rawProducts.map((p: any) => [p.id, p]));

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
        products:        rawProducts,    // ← 原始产品数组保留（向后兼容）
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
    const products = await prisma.product.findMany({
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

    // ④ 合并：每个 product 行追加对应的 1688 item 字段
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

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id/products]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单明细失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/sync-1688
//
// 一键同步 1688 订单状态、供应商名称、物流单号 → 回写 PurchaseOrder 主单。
// 前提：主单必须已有 alibabaOrderId（通过 place-1688-order 或 bind-1688-order 绑定）。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/sync-1688', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 取主单 alibabaOrderId
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

    // ── 调用 1688 buyerView ──────────────────────────────────────
    const detail = await syncOrderDetail(aliOrderId);

    if (isAliServiceError(detail)) {
      res.status(502).json({
        code: 502, data: null,
        message: detail.message,
        errorCode: detail.errorCode,
      });
      return;
    }

    // ── 物流订单取第一条写入主单（多包裹时取最新包裹） ────────────
    const firstLogistics = detail.logisticsOrders[0] ?? null;

    // ── 状态映射：1688 状态文本 → 人类可读中文 ───────────────────
    const STATUS_MAP: Record<string, string> = {
      waitbuyerpay:    '等待买家付款',
      waitallpay:      '等待拼单付款',
      waitsellersend:  '等待卖家发货',
      waitbuyerreceive:'等待买家收货',
      success:         '交易成功',
      closed:          '交易关闭',
      cancelled:       '已取消',
    };
    const humanStatus = STATUS_MAP[detail.alibabaStatus] ?? detail.alibabaStatus;

    // ── 回写数据库 ───────────────────────────────────────────────
    const updateData: Record<string, unknown> = {
      supplierName:    detail.supplierName    ?? detail.sellerLoginId ?? undefined,
      logisticsStatus: firstLogistics
        ? `[${firstLogistics.logisticsCompanyName}] ${firstLogistics.logisticsStatus || humanStatus}`
        : humanStatus,
    };
    if (firstLogistics?.logisticsCompanyName) updateData.logisticsCompany = firstLogistics.logisticsCompanyName;
    if (firstLogistics?.logisticsId)          updateData.trackingNumber   = firstLogistics.logisticsId;

    // 同步子单状态与金额
    if (order.items.length > 0) {
      await prisma.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data:  {
          alibabaOrderStatus: detail.alibabaStatus,
          alibabaTotalAmount: detail.totalAmount > 0 ? detail.totalAmount : undefined,
          shippingFee:        detail.shippingFee  > 0 ? detail.shippingFee  : undefined,
        },
      });
    }

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
      `[sync-1688] 采购单 #${id}(${order.orderNo}) 同步成功：` +
      `aliStatus=${detail.alibabaStatus}, logistics=${firstLogistics?.logisticsId ?? 'none'}`,
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
      message: `1688 订单状态已同步：${humanStatus}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/sync-1688]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '同步失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id/logistics-trace
//
// 查询物流轨迹流转节点。
// 优先使用主单已记录的 trackingNumber；若未记录则先调 buyerView 获取最新运单号。
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

    // syncOrderDetail / getLogisticsTrace / isAliServiceError 已在顶部静态导入

    // 若主单已记录运单号，直接查轨迹；否则先同步一次获取最新运单号
    let logisticsId   = order.trackingNumber;
    let companyName   = order.logisticsCompany ?? '';

    if (!logisticsId) {
      const detail = await syncOrderDetail(order.alibabaOrderId);
      if (isAliServiceError(detail)) {
        res.status(502).json({ code: 502, data: null, message: detail.message });
        return;
      }
      const first = detail.logisticsOrders[0] ?? null;
      if (!first?.logisticsId) {
        res.status(404).json({
          code: 404, data: null,
          message: '该 1688 订单暂无物流运单号（可能尚未发货）',
        });
        return;
      }
      logisticsId = first.logisticsId;
      companyName = first.logisticsCompanyName;
      // 顺便把运单号落库，避免下次重复请求 buyerView
      await prisma.purchaseOrder.update({
        where: { id },
        data: {
          trackingNumber:   logisticsId,
          logisticsCompany: companyName || undefined,
        },
      });
    }

    const trace = await getLogisticsTrace(logisticsId);
    if (isAliServiceError(trace)) {
      res.status(502).json({ code: 502, data: null, message: trace.message });
      return;
    }

    res.json({
      code: 200,
      data: {
        logisticsId,
        logisticsCompanyName: trace.logisticsCompanyName || companyName,
        nodes:                trace.nodes,
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
// 确认入库：采购到货，真实增加多仓库存
//
// Body: { warehouseId: number }（目标入库仓，必填）
//
// 事务逻辑：
//   ① 主单 status → RECEIVED
//   ② 遍历关联产品：WarehouseStock upsert（stockQuantity += purchaseQuantity）
//   ③ 重聚合 Product.stockActual
//   ④ 写 PURCHASE_IN 库存流水
//   ⑤ 关联产品 status → SELECTED（回归库存 SKU 正常态）
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/stock-in', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId } = req.body ?? {};
    const whId = parseInt(String(warehouseId), 10);
    if (isNaN(whId) || whId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId（目标仓库）为必填项' });
      return;
    }

    // 校验仓库
    const wh = await prisma.warehouse.findUnique({ where: { id: whId }, select: { id: true, name: true, status: true } });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用' });
      return;
    }

    // 查采购单 + 关联产品
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        products: {
          select: { id: true, sku: true, purchaseQuantity: true, purchasePrice: true },
        },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'RECEIVED') {
      res.status(400).json({ code: 400, data: null, message: '该采购单已入库，请勿重复操作' });
      return;
    }
    if (order.products.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '该采购单无关联产品，无法入库' });
      return;
    }

    const userId = req.user!.userId;

    // ── 事务：入库 + 加库存 + 写流水 ─────────────────────────────
    await prisma.$transaction(async (tx) => {
      // ① 主单 → RECEIVED
      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: 'RECEIVED', warehouseId: whId },
      });

      for (const prod of order.products) {
        const qty = Math.max(1, prod.purchaseQuantity ?? 1);

        // ② WarehouseStock upsert：增加物理库存
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
          create: { productId: prod.id, warehouseId: whId, stockQuantity: qty },
          update: { stockQuantity: { increment: qty } },
        });

        // ③ 重聚合 → 同步 Product.stockActual
        const allWs = await tx.warehouseStock.findMany({
          where:  { productId: prod.id },
          select: { stockQuantity: true },
        });
        const totalStock = allWs.reduce((s, w) => s + w.stockQuantity, 0);
        await tx.product.update({
          where: { id: prod.id },
          data:  { stockActual: totalStock },
        });

        // ④ 写 PURCHASE_IN 库存流水
        await applyStockChange(tx, {
          productId:      prod.id,
          warehouseId:    whId,
          changeQuantity: qty,
          type:           'PURCHASE_IN',
          referenceId:    String(order.id),
          remark:         `采购单 ${order.orderNo} 入库（仓库: ${wh.name}）`,
          createdBy:      userId,
        });
      }

      // ⑤ 产品状态回归正常
      await tx.product.updateMany({
        where: { id: { in: order.products.map((p) => p.id) } },
        data:  { status: 'SELECTED' },
      });
    });

    const totalQty = order.products.reduce((s, p) => s + Math.max(1, p.purchaseQuantity ?? 1), 0);
    console.log(
      `[stock-in] 采购单 #${id}(${order.orderNo}) 入库 → ${wh.name}，` +
      `${order.products.length} SKU 合计 ${totalQty} 件`,
    );

    res.json({
      code: 200,
      data: {
        orderId:    id,
        orderNo:    order.orderNo,
        status:     'RECEIVED',
        warehouse:  { id: wh.id, name: wh.name },
        stockedSkuCount: order.products.length,
        totalQuantity:   totalQty,
      },
      message: `${order.products.length} 个 SKU 已入库至【${wh.name}】`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/stock-in]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '入库失败，请稍后重试' });
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

export default router;
