import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { getIsSyncing, tryAcquireSyncLock, releaseSyncLock } from '../lib/syncStatus';
import { syncPlatformOrdersForShop, syncAllPlatformOrders, upsertOrderPublic } from '../services/platformOrderSync';
import { statusMap, readOrdersForAllStatuses } from '../services/emagOrder';
import { syncAndUpdatePurchaseOrderItem, isFetch1688OrderError } from '../services/alibabaOrderSync';
import { getEmagCredentials } from '../services/emagClient';

function toStatusText(status: number): string {
  return statusMap[status] ?? `状态${status}`;
}

// ─── 统一 DTO 映射（列表 & 详情共用，保证格式绝对一致）────────────────
type PlatformOrderRow = {
  id: number;
  shopId: number;
  emagOrderId: bigint;          // Prisma BigInt，避免 INT4 溢出（eMAG ID 已超 21 亿）
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
  // BigInt 序列化为字符串（全局 BigInt.prototype.toJSON 已兜底，此处显式转换保证类型安全）
  const emagOrderIdStr = String(r.emagOrderId);
  return {
    emag_order_id: emagOrderIdStr,
    id: emagOrderIdStr,
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

// ── POST /api/orders/recover ──────────────────────────────────────
// 紧急回捞接口：强制拉取近 N 天所有状态的变动订单并全量 upsert，绕过哨兵窗口限制
// Body: { days?: number (默认 3), shopIds?: number[] (不传=全部店铺) }
router.post('/recover', async (req: Request, res: Response) => {
  try {
    const days = Math.min(31, Math.max(1, parseInt(String(req.body?.days ?? 3), 10) || 3));
    const rawIds = req.body?.shopIds;
    let shopIdFilter: number[] = [];
    if (Array.isArray(rawIds)) {
      shopIdFilter = rawIds.map(Number).filter((n) => !isNaN(n) && n > 0);
    } else if (rawIds != null) {
      const n = Number(rawIds);
      if (!isNaN(n) && n > 0) shopIdFilter = [n];
    }

    const shopWhere: any = { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' };
    if (shopIdFilter.length > 0) shopWhere.id = { in: shopIdFilter };
    const shops = await prisma.shopAuthorization.findMany({
      where: shopWhere,
      select: { id: true, shopName: true, region: true },
    });
    if (shops.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '没有活跃的 eMAG 店铺' });
      return;
    }

    // 回捞起点：N 天前的 00:00:00（本地时间）
    const start = new Date();
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
    const modifiedAfter = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} 00:00:00`;

    console.log(`[recover] 开始回捞 days=${days} modifiedAfter=${modifiedAfter} shops=${shops.map((s) => s.shopName).join(',')}`);

    const results: Array<{ shopId: number; shopName: string; fetched: number; upserted: number; errors: string[] }> = [];

    for (const shop of shops) {
      const shopResult = { shopId: shop.id, shopName: shop.shopName ?? String(shop.id), fetched: 0, upserted: 0, errors: [] as string[] };
      try {
        const creds = await getEmagCredentials(shop.id);
        const readRes = await readOrdersForAllStatuses(creds, {
          itemsPerPage: 100,
          modifiedAfter,
        });

        if (readRes.isError && readRes.messages?.length) {
          shopResult.errors.push(...readRes.messages);
        }

        const orders = Array.isArray(readRes.results) ? readRes.results : [];
        shopResult.fetched = orders.length;

        for (const o of orders) {
          if (!o?.id) continue;
          try {
            await upsertOrderPublic(shop.id, o, creds.region);
            shopResult.upserted++;
          } catch (e) {
            shopResult.errors.push(`order ${o.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        shopResult.errors.push(`获取凭证失败: ${e instanceof Error ? e.message : String(e)}`);
      }
      results.push(shopResult);
      console.log(`[recover] shop=${shop.shopName} fetched=${shopResult.fetched} upserted=${shopResult.upserted} errors=${shopResult.errors.length}`);

      // 店铺间强制 2 秒间隔，保护低带宽代理
      if (shops.indexOf(shop) < shops.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    const totalFetched  = results.reduce((s, r) => s + r.fetched, 0);
    const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);

    res.json({
      code: 200,
      data: {
        days,
        modifiedAfter,
        totalFetched,
        totalUpserted,
        shops: results,
      },
      message: `回捞完成：共拉取 ${totalFetched} 条，成功入库 ${totalUpserted} 条`,
    });
  } catch (err) {
    console.error('[POST /api/orders/recover]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
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

      // 下单时间范围（罗马尼亚 EET/EEST → UTC 偏移：冬令 -2h，夏令 -3h）
      // 向外各扩展 3 小时，确保跨天边缘不丢单；前端展示时仍按 eMAG 本地日期即可
      const orderTimeFilter: { gte?: Date; lte?: Date } = {};
      if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate.slice(0, 10))) {
        const base = new Date(`${startDate.slice(0, 10)}T00:00:00Z`);
        base.setUTCHours(base.getUTCHours() - 3);
        orderTimeFilter.gte = base;
      }
      if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate.slice(0, 10))) {
        const base = new Date(`${endDate.slice(0, 10)}T23:59:59Z`);
        base.setUTCHours(base.getUTCHours() + 3);
        orderTimeFilter.lte = base;
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
    // ★ 前端通过 /api/orders（无 shopId 参数）调用此分支
    const page     = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    // ── Tab 状态过滤（与 /api/purchases GET 逻辑完全一致）──────────
    // 兼容多种前端命名：tabStatus / tab_status / tab / status
    const rawTab = (
      req.query.tabStatus  ?? req.body?.tabStatus  ??
      req.query.tab_status ?? req.body?.tab_status ??
      req.query.tab        ?? req.body?.tab        ??
      req.query.status     ?? req.body?.status     ?? ''
    );
    const tabRaw = String(rawTab).toUpperCase().trim();

    let statusFilter: string | { in: string[] } | undefined;
    switch (tabRaw) {
      case 'PENDING':
        // 未下单：仅返回本地建单、尚未提交 1688 的单据
        statusFilter = 'PENDING';
        break;
      case 'PURCHASING':
        // 采购中：已向 1688 下单（PLACED）或运输中（IN_TRANSIT）
        // ★ 绝对不包含 PENDING 或 RECEIVED
        statusFilter = { in: ['PLACED', 'IN_TRANSIT'] };
        break;
      case 'COMPLETED':
        // 已完成：货物已入库
        statusFilter = { in: ['RECEIVED'] };
        break;
      case 'PLACED':     statusFilter = 'PLACED';     break;
      case 'IN_TRANSIT': statusFilter = 'IN_TRANSIT'; break;
      case 'RECEIVED':   statusFilter = 'RECEIVED';   break;
      // ALL / 空值 / 未知 → statusFilter = undefined（不过滤，返回全部）
    }

    // ── 关键词穿透搜索 ─────────────────────────────────────────────
    const kw = String(
      req.query.keyword ?? req.body?.keyword ??
      req.query.search  ?? req.body?.search  ?? '',
    ).trim();

    // ── 用显式 AND 隔离状态过滤与 OR 关键词条件，防止条件互相覆盖 ──
    const andClauses: any[] = [];
    if (statusFilter !== undefined) {
      andClauses.push({ status: statusFilter });
    }
    if (kw) {
      andClauses.push({
        OR: [
          { orderNo:  { contains: kw, mode: 'insensitive' as const } },
          { items:    { some: { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } } } },
          { products: { some: { sku:            { contains: kw, mode: 'insensitive' as const } } } },
        ],
      });
    }
    const poWhere: any = andClauses.length > 0 ? { AND: andClauses } : {};

    console.log(
      `[GET /api/orders → 采购单分支] tabRaw="${tabRaw}" → statusFilter=${JSON.stringify(statusFilter)}`,
      '| kw:', JSON.stringify(kw), '| poWhere:', JSON.stringify(poWhere),
    );

    const [total, orders] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where: poWhere }),
      prisma.purchaseOrder.findMany({
        where:   poWhere,
        orderBy: { createdAt: 'desc' },
        skip,
        take:    pageSize,
        include: {
          items: {
            select: {
              id: true, offerId: true, quantity: true,
              alibabaOrderId: true, alibabaOrderStatus: true,
            },
          },
          products: {
            select: {
              id: true, sku: true, chineseName: true,
              imageUrl: true, purchasePrice: true, purchaseQuantity: true,
            },
          },
          warehouse: { select: { id: true, name: true } },
        },
      }),
    ]);

    // Tab 计数（供前端渲染徽标，一次返回全部）
    const [cntPending, cntPurchasing, cntCompleted] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
      prisma.purchaseOrder.count({ where: { status: { in: ['PLACED', 'IN_TRANSIT'] } } }),
      prisma.purchaseOrder.count({ where: { status: 'RECEIVED' } }),
    ]);

    // ── 将 products 信息合并进 items，形成前端可直接渲染的子表行 ──
    // 背景：PurchaseOrderItem 无直接 FK 到 Product，两者分离查询后在此合并。
    // 一品一单模型下 items[i] ↔ products[i] 一一对应；多品时按下标顺序对齐。
    const purchaseList = orders.map((o) => {
      const rawItems    = (o as any).items    as any[] ?? [];
      const rawProducts = (o as any).products as any[] ?? [];

      // 构建产品 Map（id → product），方便精确匹配
      const prodById = new Map<number, any>(rawProducts.map((p: any) => [p.id, p]));

      // 合并：把每个 item 与对应 product 的信息融合，前端子表只需读 items[i].*
      const mergedItems = rawItems.map((item: any, idx: number) => {
        // 优先用 productIds JSON 字段精准关联，兜底用下标顺序对齐
        let prod: any = null;
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          if (pids.length > 0) prod = prodById.get(pids[0]);
        } catch { /* ignore */ }
        if (!prod) prod = rawProducts[idx] ?? null;

        return {
          // PurchaseOrderItem 字段
          id:                 item.id,
          offerId:            item.offerId     ?? null,
          quantity:           item.quantity,
          alibabaOrderId:     item.alibabaOrderId     ?? null,
          alibabaOrderStatus: item.alibabaOrderStatus ?? null,
          // Product 字段（合并进来，前端子表直接读）
          productId:          prod?.id          ?? null,
          sku:                prod?.sku          ?? null,
          chineseName:        prod?.chineseName  ?? null,
          imageUrl:           prod?.imageUrl     ?? null,
          purchasePrice:      prod?.purchasePrice != null ? Number(prod.purchasePrice) : null,
          purchaseQuantity:   prod?.purchaseQuantity ?? item.quantity,
          purchaseUrl:        prod?.purchaseUrl  ?? null,
        };
      });

      return {
        id:          o.id,
        orderNo:     o.orderNo,
        operator:    o.operator,
        totalAmount: Number(o.totalAmount),
        itemCount:   o.itemCount,
        status:      o.status,
        remark:      (o as any).remark    ?? null,
        createdAt:   o.createdAt,
        items:       mergedItems,                  // ← 已合并产品信息的子表行
        products:    rawProducts,                  // ← 原始产品数组保留（向后兼容）
        warehouse:   (o as any).warehouse ?? null,
      };
    });

    res.json({
      code: 200,
      data: {
        list:      purchaseList,
        total,
        page,
        pageSize,
        tabCounts: {
          ALL:        cntPending + cntPurchasing + cntCompleted,
          PENDING:    cntPending,
          PURCHASING: cntPurchasing,
          COMPLETED:  cntCompleted,
        },
      },
      message: 'success',
    });
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

    let orderId: bigint;
    try {
      const rawId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id);
      orderId = BigInt(rawId);
    } catch {
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
