import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { getIsSyncing, setIsSyncing } from '../lib/syncStatus';
import { syncPlatformOrdersForShop } from '../services/platformOrderSync';
import { statusMap } from '../services/emagOrder';

function toStatusText(status: number): string {
  return statusMap[status] ?? `状态${status}`;
}

/** 无图片占位图 URL */
const PLACEHOLDER_IMAGE = 'https://via.placeholder.com/150x150?text=No+Image';

const router = Router();
router.use(authenticate);

// ── GET /api/orders/sync-status ───────────────────────────────────
// 同步状态位，前端轮询可判断是否显示「正在同步」
router.get('/sync-status', (_req: Request, res: Response) => {
  res.json({ code: 200, data: { isSyncing: getIsSyncing() }, message: 'success' });
});

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
// 手动触发平台订单全量同步（按 shopId），完成后 isSyncing 置 false
router.post('/sync-platform', async (req: Request, res: Response) => {
  if (getIsSyncing()) {
    res.status(409).json({ code: 409, data: null, message: '同步进行中，请稍候' });
    return;
  }
  try {
    const shopId = Number(req.body?.shopId ?? req.query?.shopId);
    if (!shopId || isNaN(shopId)) {
      res.status(400).json({ code: 400, data: null, message: '请提供 shopId' });
      return;
    }
    setIsSyncing(true);
    const result = await syncPlatformOrdersForShop(shopId);
    setIsSyncing(false);
    res.json({
      code: 200,
      data: { totalUpserted: result.totalUpserted, totalFetched: result.totalFetched, pages: result.pages },
      message: `同步完成，入库 ${result.totalUpserted} 条`,
    });
  } catch (err) {
    setIsSyncing(false);
    console.error('[POST /api/orders/sync-platform]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

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

// ── GET /api/orders ──────────────────────────────────────────
// shopId 存在时：平台订单（eMAG order/read）；否则：采购单列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (shopId && !isNaN(shopId)) {
      // 平台订单：从本地 PlatformOrder 表读取
      // 兼容 currentPage/itemsPerPage 和 page/pageSize 两种参数命名
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

      // 动态构建 where 条件
      const where: Prisma.PlatformOrderWhereInput = { shopId };

      // 订单号模糊查询（emagOrderId 转字符串匹配）
      if (orderNumber) {
        const ids = await prisma.$queryRaw<{ emag_order_id: number }[]>`
          SELECT emag_order_id FROM platform_orders
          WHERE shop_id = ${shopId} AND emag_order_id::text LIKE ${'%' + orderNumber + '%'}
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
        }),
      ]);

      const list = rows.map((r) => {
        const statusText = toStatusText(r.status);
        // 验证打印：关注订单 480702441 及所有 status=4 的映射
        if (r.emagOrderId === 480702441 || r.status === 4) {
          console.log(`[StatusCheck] 订单 ${r.emagOrderId}: status=${r.status} -> "${statusText}"`);
        }
        return {
          id: r.emagOrderId,
          status: r.status,
          status_text: statusText,
          date: r.orderTime.toISOString().slice(0, 19).replace('T', ' '),
          orderTime: r.orderTime.toISOString().slice(0, 19).replace('T', ' '),
          payment_mode: r.paymentMode,
          payment_mode_id: null,
          type: r.orderType,
          customer: r.customerJson ? JSON.parse(r.customerJson) : {},
          products: r.productsJson ? JSON.parse(r.productsJson) : [],
          total: Number(r.total),
          currency: r.currency ?? 'RON',
        };
      });

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
// shopId 存在时：平台订单详情（从 PlatformOrder 读取）；否则：采购单详情或 400
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (!shopId || isNaN(shopId)) {
      res.status(400).json({ code: 400, data: null, message: '平台订单详情需提供 shopId' });
      return;
    }
    const orderId = Number(req.params.id);
    if (isNaN(orderId)) {
      res.status(400).json({ code: 400, data: null, message: '订单 ID 无效' });
      return;
    }

    const row = await prisma.platformOrder.findUnique({
      where: { shopId_emagOrderId: { shopId, emagOrderId: orderId } },
    });

    if (!row) {
      res.status(404).json({ code: 404, data: null, message: '订单不存在' });
      return;
    }

    const detailStatusText = toStatusText(row.status);
    console.log(`[StatusCheck] 详情 订单 ${row.emagOrderId}: status=${row.status} -> "${detailStatusText}"`);

    const rawProducts: Array<{ sku?: string | null; product_name?: string; pnk?: string; sale_price?: number; quantity?: number; vat_rate?: number; [k: string]: unknown }> =
      row.productsJson ? JSON.parse(row.productsJson) : [];

    const orderSkus = [...new Set(rawProducts.map((p) => String(p.sku ?? '').trim()).filter(Boolean))];
    const storeProductMap = new Map<string, { display_image: string | null; image_status: string }>();

    if (orderSkus.length > 0) {
      const storeProducts = await prisma.storeProduct.findMany({
        where: {
          shopId,
          OR: [{ sku: { in: orderSkus } }, { vendorSku: { in: orderSkus } }],
        },
        select: { sku: true, vendorSku: true, mainImage: true, imageUrl: true, mappedInventorySku: true },
      });

      for (const sp of storeProducts) {
        const platformImg = (sp.mainImage ?? sp.imageUrl ?? '').trim() || null;
        const image_status = platformImg ? '正常' : '待补全平台产品资料';
        const display_image = platformImg;
        if (sp.sku) storeProductMap.set(sp.sku, { display_image, image_status });
        if (sp.vendorSku) storeProductMap.set(sp.vendorSku, { display_image, image_status });
      }
    }

    const products = rawProducts.map((p) => {
      const sku = String(p.sku ?? '').trim();
      const spData = sku ? storeProductMap.get(sku) : undefined;
      const display_image = spData?.display_image ?? null;
      const image_status = spData?.image_status ?? (sku ? '待补全平台产品资料' : '正常');
      const { image_url, ...rest } = p as { image_url?: string; [k: string]: unknown };
      return { ...rest, display_image, image_status };
    });

    res.json({
      code: 200,
      data: {
        id: row.emagOrderId,
        status: row.status,
        type: row.orderType,
        status_text: detailStatusText,
        date: row.orderTime.toISOString().slice(0, 19).replace('T', ' '),
        orderTime: row.orderTime.toISOString().slice(0, 19).replace('T', ' '),
        payment_mode: row.paymentMode,
        payment_mode_id: null,
        customer: row.customerJson ? JSON.parse(row.customerJson) : {},
        products,
        total: Number(row.total),
        currency: row.currency ?? 'RON',
      },
      message: 'success',
    });
  } catch (err) {
    console.error('[GET /api/orders/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/orders/:id/products ─────────────────────────────
// 查询某个采购单下的所有产品
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

    const list = products.map((p) => ({
      id:               p.id,
      pnk:              p.pnk,
      sku:              p.sku ?? null,
      chineseName:      p.chineseName ?? null,
      imageUrl:         p.imageUrl,
      purchaseUrl:      p.purchaseUrl ?? null,
      purchasePrice:    p.purchasePrice ? Number(p.purchasePrice) : null,
      purchaseQuantity: p.purchaseQuantity ?? null,
      price:            p.price ? Number(p.price) : null,
    }));

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/orders/:id/products]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
