import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { getIsSyncing, tryAcquireSyncLock, releaseSyncLock } from '../lib/syncStatus';
import { syncPlatformOrdersForShop, syncAllPlatformOrders } from '../services/platformOrderSync';
import { statusMap } from '../services/emagOrder';
import { syncAndUpdatePurchaseOrderItem, isFetch1688OrderError } from '../services/alibabaOrderSync';

function toStatusText(status: number): string {
  return statusMap[status] ?? `状态${status}`;
}

// ─── 统一 DTO 映射（列表 & 详情共用，保证格式绝对一致）────────────────
type PlatformOrderRow = {
  id: number;
  shopId: number;
  emagOrderId: number;
  status: number;
  orderType: number | null;
  orderTime: Date;
  paymentMode: string | null;
  total: { toNumber(): number } | number;
  currency: string | null;
  customerJson: string | null;
  productsJson: string | null;
  shop?: { region?: string | null } | null;
};

function mapOrderToDTO(r: PlatformOrderRow, productsOverride?: unknown[]) {
  const statusNum = r.status != null ? Number(r.status) : 0;
  const region = (r.shop?.region ?? 'RO') as string;
  const totalPrice = typeof r.total === 'object' ? r.total.toNumber() : Number(r.total ?? 0);
  const currency = r.currency ?? 'RON';
  return {
    emag_order_id: r.emagOrderId,
    id: r.emagOrderId,
    shop_id: r.shopId,
    region,
    status: statusNum,
    status_text: toStatusText(statusNum),
    total: totalPrice,
    total_price: totalPrice,
    currency,
    date: r.orderTime.toISOString().slice(0, 19).replace('T', ' '),
    orderTime: r.orderTime.toISOString().slice(0, 19).replace('T', ' '),
    payment_mode: r.paymentMode ?? null,
    payment_mode_id: null,
    type: r.orderType ?? null,
    customer: r.customerJson ? JSON.parse(r.customerJson) : {},
    products: productsOverride ?? (r.productsJson ? JSON.parse(r.productsJson) : []),
  };
}

const router = Router();
router.use(authenticate);

// ── GET /api/orders/sync-status ───────────────────────────────────
// 同步状态位，前端轮询可判断是否显示「正在同步」
router.get('/sync-status', (_req: Request, res: Response) => {
  res.json({ code: 200, data: { isSyncing: getIsSyncing() }, message: 'success' });
});

// ── POST /api/orders/sync ────────────────────────────────────────
// 平台订单同步（「强制重加载」入口，必须在 /:id 之前注册）
// Body: shopId | shopIds[] | 空=全部店铺
const syncPlatformHandler = async (req: Request, res: Response) => {
  if (!tryAcquireSyncLock()) {
    res.status(409).json({ code: 409, data: null, message: '同步进行中，请稍候' });
    return;
  }
  try {
    const incremental = !!(req.body?.incremental ?? (req.query?.incremental === '1' || req.query?.incremental === 'true'));
    const rawShopIds = req.body?.shopIds ?? req.query?.shopIds;
    let targetShopIds: number[] = [];

    if (rawShopIds != null) {
      const arr = Array.isArray(rawShopIds) ? rawShopIds : String(rawShopIds).split(',');
      targetShopIds = arr.map(Number).filter((n) => !isNaN(n) && n > 0);
    } else {
      const single = Number(req.body?.shopId ?? req.query?.shopId);
      if (!isNaN(single) && single > 0) targetShopIds = [single];
    }

    if (targetShopIds.length === 1) {
      const result = await syncPlatformOrdersForShop(targetShopIds[0], incremental);
      return res.json({
        code: 200,
        data: {
          totalUpserted: result.totalUpserted,
          totalFetched: result.totalFetched,
          pages: result.pages,
          orderIds: result.orderIds,
          errors: result.errors,
        },
        message: `同步完成，入库 ${result.totalUpserted} 条`,
      });
    }

    const results = await syncAllPlatformOrders(
      incremental,
      undefined,
      targetShopIds.length > 0 ? targetShopIds : undefined,
    );

    const allOrderIds   = results.flatMap((r) => r.orderIds);
    const totalUpserted = results.reduce((s, r) => s + r.totalUpserted, 0);
    const totalFetched  = results.reduce((s, r) => s + r.totalFetched, 0);

    return res.json({
      code: 200,
      data: {
        totalUpserted,
        totalFetched,
        results: results.map((r) => ({
          shopId:        r.shopId,
          totalFetched:  r.totalFetched,
          totalUpserted: r.totalUpserted,
          orderIds:      r.orderIds,
          errors:        r.errors,
        })),
        orderIds: allOrderIds,
      },
      message: `同步完成，共 ${results.length} 个店铺，入库 ${totalUpserted} 条`,
    });
  } catch (err: any) {
    console.error('[POST /api/orders/sync]', err);
    const msg = err?.message ?? String(err);
    const isAuthError = /401|403|未授权|禁止|API 账号或密码无效/.test(msg);
    const status = isAuthError ? 400 : 500;
    const responseMsg = isAuthError ? 'API 账号或密码无效，请检查凭证' : '服务器内部错误';
    res.status(status).json({ code: status, data: null, message: responseMsg });
  } finally {
    releaseSyncLock();
  }
};

router.post('/sync', syncPlatformHandler);

// ── POST /api/orders/sync-platform/:id ─────────────────────────
// 强制同步单笔订单（更具体路由需在前）
router.post('/sync-platform/:id', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.body?.shopId ?? req.query?.shopId);
    const orderId = Number(req.params.id);
    if (!shopId || isNaN(shopId)) {
      res.status(400).json({ code: 400, data: null, message: '请提供 shopId' });
      return;
    }
    if (isNaN(orderId)) {
      res.status(400).json({ code: 400, data: null, message: '订单 ID 无效' });
      return;
    }
    const { syncPlatformOrderById } = await import('../services/platformOrderSync');
    const result = await syncPlatformOrderById(shopId, orderId);
    if (!result.ok) {
      res.status(404).json({ code: 404, data: null, message: result.error ?? '同步失败' });
      return;
    }
    res.json({
      code: 200,
      data: { total: result.total, status_text: result.status_text },
      message: '同步成功',
    });
  } catch (err) {
    console.error('[POST /api/orders/sync-platform/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/orders/sync-platform ────────────────────────────
// 同上，兼容旧前端调用
router.post('/sync-platform', syncPlatformHandler);

// ── POST /api/orders ─────────────────────────────────────────
// 创建采购单：将选中的 PURCHASING 产品归集为一张采购单
router.post('/', async (req: Request, res: Response) => {
  try {
    const { productIds } = req.body ?? {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择至少一个产品' });
      return;
    }

    const ids = productIds.map(Number).filter((n) => !isNaN(n));
    const userId = req.user!.userId;
    const username = req.user!.username ?? 'unknown';

    const products = await prisma.product.findMany({
      where: { id: { in: ids }, status: 'PURCHASING', ownerId: userId },
    });

    if (products.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '未找到可下单的产品' });
      return;
    }

    const totalAmount = products.reduce(
      (sum, p) => sum + (Number(p.purchasePrice) || 0) * (p.purchaseQuantity || 0),
      0,
    );

    // 生成编号: operator-YYYYMMDD-seq
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix = `${username}-${dateStr}-`;

    const todayCount = await prisma.purchaseOrder.count({
      where: { orderNo: { startsWith: prefix } },
    });
    const seq = String(todayCount + 1).padStart(3, '0');
    const orderNo = `${prefix}${seq}`;

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.purchaseOrder.create({
        data: {
          orderNo,
          operator: username,
          totalAmount,
          itemCount: products.length,
          status: 'PLACED',
        },
      });

      await tx.product.updateMany({
        where: { id: { in: products.map((p) => p.id) } },
        data: { status: 'ORDERED', purchaseOrderId: created.id },
      });

      return created;
    });

    res.json({
      code: 200,
      data: { id: order.id, orderNo: order.orderNo, itemCount: order.itemCount, totalAmount: Number(order.totalAmount) },
      message: `采购单 ${order.orderNo} 创建成功`,
    });
  } catch (err) {
    console.error('[POST /api/orders]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

/** 解析 shopIds：支持 shopIds=1,2,3 或 shopId=1 或 shopId=1&shopId=2（向后兼容） */
function parseShopIds(req: Request): number[] {
  const shopIdsRaw = req.query.shopIds;
  const shopIdRaw = req.query.shopId;
  if (typeof shopIdsRaw === 'string') {
    const arr = shopIdsRaw.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
    return [...new Set(arr)];
  }
  if (Array.isArray(shopIdsRaw)) {
    const arr = shopIdsRaw.flatMap((s) => String(s).split(',')).map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
    return [...new Set(arr)];
  }
  if (shopIdRaw != null) {
    const single = Number(Array.isArray(shopIdRaw) ? shopIdRaw[0] : shopIdRaw);
    if (!isNaN(single) && single > 0) return [single];
    if (Array.isArray(shopIdRaw)) {
      const arr = shopIdRaw.map((s) => Number(s)).filter((n) => !isNaN(n) && n > 0);
      return [...new Set(arr)];
    }
  }
  return [];
}

// ── GET /api/orders ──────────────────────────────────────────
// shopId/shopIds 存在时：平台订单（支持多店铺聚合）；否则：采购单列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const shopIds = parseShopIds(req);
    if (shopIds.length > 0) {
      // 平台订单：从本地 PlatformOrder 表读取（支持多 shop_id 聚合）
      const currentPage = Math.max(1,
        parseInt(String(req.query.currentPage ?? req.query.page ?? 1), 10) || 1
      );
      const itemsPerPage = Math.min(1000, Math.max(1,
        parseInt(String(req.query.itemsPerPage ?? req.query.pageSize ?? req.query.limit ?? 100), 10) || 100
      ));
      const skip = (currentPage - 1) * itemsPerPage;

      const orderNumber = String(req.query.orderNumber ?? '').trim();
      const startDate = String(req.query.startDate ?? '').trim();
      const endDate = String(req.query.endDate ?? '').trim();
      const statusFilter = req.query.status !== undefined && req.query.status !== ''
        ? Number(req.query.status)
        : null;

      const where: Prisma.PlatformOrderWhereInput = { shopId: { in: shopIds } };

      // 订单号模糊查询（emagOrderId 转字符串匹配）
      if (orderNumber) {
        const ids = await prisma.$queryRaw<{ emag_order_id: number }[]>`
          SELECT emag_order_id FROM platform_orders
          WHERE shop_id IN (${Prisma.join(shopIds)})
          AND emag_order_id::text LIKE ${'%' + orderNumber + '%'}
        `;
        const orderIds = ids.map((r) => r.emag_order_id);
        if (orderIds.length === 0) {
          res.json({
            code: 200,
            data: { list: [], total: 0, currentPage, itemsPerPage },
            message: 'success',
          });
          return;
        }
        where.emagOrderId = { in: orderIds };
      }

      // 下单时间范围
      const orderTimeFilter: { gte?: Date; lte?: Date } = {};
      if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate.slice(0, 10))) {
        orderTimeFilter.gte = new Date(`${startDate.slice(0, 10)}T00:00:00`);
      }
      if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate.slice(0, 10))) {
        orderTimeFilter.lte = new Date(`${endDate.slice(0, 10)}T23:59:59`);
      }
      if (Object.keys(orderTimeFilter).length > 0) {
        where.orderTime = orderTimeFilter;
      }

      // 订单状态筛选
      if (statusFilter !== null && !isNaN(statusFilter)) {
        where.status = statusFilter;
      }

      const [total, rows] = await prisma.$transaction([
        prisma.platformOrder.count({ where }),
        prisma.platformOrder.findMany({
          where,
          orderBy: { orderTime: 'desc' },
          skip,
          take: itemsPerPage,
          include: { shop: { select: { region: true } } },
        }),
      ]);

      const list = rows.map((r) => mapOrderToDTO(r));

      if (list.length > 0) {
        console.log(`[平台订单] 查询样本(shopIds=${shopIds}):`, JSON.stringify(list[0], null, 2));
      }

      res.json({
        code: 200,
        data: { list, total, currentPage, itemsPerPage },
        message: 'success',
      });
      return;
    }

    // 采购单列表（分页）
    const page     = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    const [total, orders] = await prisma.$transaction([
      prisma.purchaseOrder.count(),
      prisma.purchaseOrder.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
    ]);

    const purchaseList = orders.map((o) => ({
      id:          o.id,
      orderNo:     o.orderNo,
      operator:    o.operator,
      totalAmount: Number(o.totalAmount),
      itemCount:   o.itemCount,
      status:      o.status,
      createdAt:   o.createdAt,
    }));

    res.json({ code: 200, data: { list: purchaseList, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/orders]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/orders/:id ──────────────────────────────────────
// shopId/shopIds 存在时：平台订单详情；否则 400
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const shopIds = parseShopIds(req);
    if (shopIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '平台订单详情需提供 shopId 或 shopIds' });
      return;
    }

    const orderId = Number(req.params.id);
    if (isNaN(orderId)) {
      res.status(400).json({ code: 400, data: null, message: '订单 ID 无效' });
      return;
    }

    const shopInclude = { shop: { select: { region: true } } } as const;
    const row = shopIds.length === 1
      ? await prisma.platformOrder.findUnique({
          where: { shopId_emagOrderId: { shopId: shopIds[0], emagOrderId: orderId } },
          include: shopInclude,
        })
      : await prisma.platformOrder.findFirst({
          where: { shopId: { in: shopIds }, emagOrderId: orderId },
          include: shopInclude,
        });

    if (!row) {
      res.status(404).json({ code: 404, data: null, message: '订单不存在' });
      return;
    }

    // 富化产品列表：补充图片状态（仅详情接口需要）
    const rawProducts: Array<{ sku?: string | null; [k: string]: unknown }> =
      row.productsJson ? JSON.parse(row.productsJson) : [];

    const orderSkus = [...new Set(rawProducts.map((p) => String(p.sku ?? '').trim()).filter(Boolean))];
    const storeProductMap = new Map<string, { display_image: string | null; image_status: string }>();

    if (orderSkus.length > 0) {
      const storeProducts = await prisma.storeProduct.findMany({
        where: {
          shopId: row.shopId,
          OR: [{ sku: { in: orderSkus } }, { vendorSku: { in: orderSkus } }],
        },
        select: { sku: true, vendorSku: true, mainImage: true, imageUrl: true },
      });

      for (const sp of storeProducts) {
        const platformImg = (sp.mainImage ?? sp.imageUrl ?? '').trim() || null;
        const info = { display_image: platformImg, image_status: platformImg ? '正常' : '待补全平台产品资料' };
        if (sp.sku) storeProductMap.set(sp.sku, info);
        if (sp.vendorSku) storeProductMap.set(sp.vendorSku, info);
      }
    }

    const enrichedProducts = rawProducts.map((p) => {
      const sku = String(p.sku ?? '').trim();
      const spData = sku ? storeProductMap.get(sku) : undefined;
      const { image_url, ...rest } = p as { image_url?: string; [k: string]: unknown };
      return {
        ...rest,
        display_image: spData?.display_image ?? null,
        image_status: spData?.image_status ?? (sku ? '待补全平台产品资料' : '正常'),
      };
    });

    res.json({
      code: 200,
      data: mapOrderToDTO(row, enrichedProducts),
      message: 'success',
    });
  } catch (err) {
    console.error('[GET /api/orders/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/orders/:id/products ─────────────────────────────
// 查询某个采购单下的所有产品，并联查 PurchaseOrderItem 补全 1688 金额/状态/物流字段
// 若金额为 null 则自动触发 1688 内联同步并返回 debug_raw_price
router.get('/:id/products', async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.id);
    if (isNaN(orderId)) {
      res.status(400).json({ code: 400, data: null, message: '订单 ID 无效' });
      return;
    }

    const products = await prisma.product.findMany({
      where: { purchaseOrderId: orderId },
      orderBy: { updatedAt: 'desc' },
    });

    // 联查 PurchaseOrderItem：以 alibabaOrderId = Product.externalOrderId 作为桥接
    const orderIds = [...new Set(products.map((p) => p.externalOrderId).filter(Boolean))] as string[];
    const itemsMap = new Map<string, {
      id: number;
      alibabaOrderId: string | null;
      alibabaOrderStatus: string | null;
      alibabaTotalAmount: number | null;
      shippingFee: number | null;
      logisticsCompany: string | null;
      logisticsNo: string | null;
      debug_raw_price: Record<string, unknown> | null;
    }>();
    if (orderIds.length > 0) {
      const items = await prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: orderId, alibabaOrderId: { in: orderIds } },
        select: {
          id: true,
          alibabaOrderId: true,
          alibabaOrderStatus: true,
          alibabaTotalAmount: true,
          shippingFee: true,
          logisticsCompany: true,
          logisticsNo: true,
        },
      });
      for (const item of items) {
        if (item.alibabaOrderId) {
          let totalAmount = item.alibabaTotalAmount != null ? Number(item.alibabaTotalAmount) : null;
          let shippingFee = item.shippingFee != null ? Number(item.shippingFee) : null;
          let status = item.alibabaOrderStatus ?? null;
          let debug_raw_price: Record<string, unknown> | null = null;

          // ★ 金额为 null 时自动触发 1688 内联同步（必须走 res.result.baseInfo）
          if ((totalAmount == null || shippingFee == null) && item.alibabaOrderId) {
            const synced = await syncAndUpdatePurchaseOrderItem(item.id, item.alibabaOrderId);
            if (synced && !isFetch1688OrderError(synced)) {
              totalAmount = synced.totalAmount;
              shippingFee = synced.shippingFee;
              status = synced.status;
              debug_raw_price = synced.debug_raw_price;
            }
          }

          itemsMap.set(item.alibabaOrderId, {
            id: item.id,
            alibabaOrderId: item.alibabaOrderId,
            alibabaOrderStatus: status,
            alibabaTotalAmount: totalAmount,
            shippingFee,
            logisticsCompany: item.logisticsCompany ?? null,
            logisticsNo: item.logisticsNo ?? null,
            debug_raw_price,
          });
        }
      }
    }

    const list = products.map((p) => {
      const orderItem = p.externalOrderId ? itemsMap.get(p.externalOrderId) : undefined;
      return {
        id:                  p.id,
        pnk:                 p.pnk,
        sku:                 p.sku ?? null,
        chineseName:         p.chineseName ?? null,
        imageUrl:            p.imageUrl,
        purchaseUrl:         p.purchaseUrl ?? null,
        purchasePrice:       p.purchasePrice ? Number(p.purchasePrice) : null,
        purchaseQuantity:    p.purchaseQuantity ?? null,
        price:               p.price ? Number(p.price) : null,
        // 1688 关联字段
        externalOrderId:     p.externalOrderId ?? null,
        purchaseOrderItemId: orderItem?.id ?? null,
        alibabaOrderStatus:  orderItem?.alibabaOrderStatus ?? null,
        alibabaTotalAmount:  orderItem?.alibabaTotalAmount ?? null,
        shippingFee:         orderItem?.shippingFee ?? null,
        logisticsCompany:    orderItem?.logisticsCompany ?? null,
        logisticsNo:         orderItem?.logisticsNo ?? null,
        debug_raw_price:     orderItem?.debug_raw_price ?? null,
      };
    });

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/orders/:id/products]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/orders/:id/items ─────────────────────────────────
// 查询采购单下的 1688 子单明细（含 alibabaOrderId、物流等，供展开子表与同步接口使用）
router.get('/:id/items', async (req: Request, res: Response) => {
  try {
    const orderId = Number(req.params.id);
    if (isNaN(orderId)) {
      res.status(400).json({ code: 400, data: null, message: '订单 ID 无效' });
      return;
    }

    const items = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: orderId },
      orderBy: { id: 'asc' },
    });

    const list = items.map((i) => ({
      id:                  i.id,
      offerId:             i.offerId ?? null,
      productIds:         i.productIds ?? null,
      quantity:           i.quantity,
      externalOrderId:     i.alibabaOrderId ?? null,
      alibabaOrderId:     i.alibabaOrderId ?? null,
      alibabaOrderStatus: i.alibabaOrderStatus ?? null,
      alibabaTotalAmount: i.alibabaTotalAmount != null ? Number(i.alibabaTotalAmount) : null,
      shippingFee:        i.shippingFee != null ? Number(i.shippingFee) : null,
      logisticsCompany:   i.logisticsCompany ?? null,
      logisticsNo:        i.logisticsNo ?? null,
      createdAt:          i.createdAt,
    }));

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/orders/:id/items]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
