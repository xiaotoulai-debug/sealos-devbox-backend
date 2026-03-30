/**
 * 店铺在售产品 API — StoreProduct + Inventory SKU 碰头
 *
 * 数据源: StoreProduct（eMAG 同步），通过 mapped_inventory_sku 联表 Inventory
 * 图片优先级: 平台 main_image/imageUrl > 本地 Inventory.local_image（本地关联 SKU 兜底）
 * 毛利预估: sale_price - (purchase_cost + 预估物流费)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { getEmagCredentials, resolveRegion, REGION_CURRENCY, REGION_DOMAIN } from '../services/emagClient';
import { getSalesStatsByShop, getSalesForProduct, logZeroSalesDiagnostic } from '../services/salesStats';
import { tryAcquireLock, releaseLock } from '../lib/syncStatus';
import { backfillProductUrls, backfillProductImages, syncStoreProducts, backfillComprehensiveSales } from '../services/storeProductSync';

const router = Router();
router.use(authenticate);

/**
 * POST /api/store-products/sync
 * 逻辑流: 接收请求 -> 解析 shopId/shopIds -> 查库获取 shop(s) -> 初始化 Adapter -> 拉取原生数据 -> Normalizer 管线 -> upsert(shopId+sku)
 * Body: { shopId: number } | { shopIds: number[] }  或 Query: ?shopId=1 或 ?shopIds=1,2,3
 */
router.post('/sync', async (req: Request, res: Response) => {
  if (!tryAcquireLock('product')) {
    res.status(409).json({ code: 409, data: null, message: '同步进行中，请稍候' });
    return;
  }
  try {
    const rawShopIds = req.body?.shopIds ?? req.query?.shopIds;
    const rawShopId = req.body?.shopId ?? req.query?.shopId;

    let shopIds: number[] = [];
    if (rawShopIds != null) {
      const arr = Array.isArray(rawShopIds) ? rawShopIds : String(rawShopIds).split(',');
      shopIds = arr.map(Number).filter((n) => !isNaN(n) && n > 0);
    } else if (rawShopId != null) {
      const single = Number(Array.isArray(rawShopId) ? rawShopId[0] : rawShopId);
      if (!isNaN(single) && single > 0) shopIds = [single];
    }

    if (shopIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供 shopId 或 shopIds' });
      return;
    }

    // 查库获取 shop(s)，确保存在且为 eMAG
    const shops = await prisma.shopAuthorization.findMany({
      where: { id: { in: shopIds }, platform: { equals: 'emag', mode: 'insensitive' } },
      select: { id: true },
    });
    const validIds = shops.map((s) => s.id);
    if (validIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '未找到有效的 eMAG 店铺' });
      return;
    }

    const results: Array<{ shopId: number; totalFetched: number; upserted: number; rejectedCount: number; errors: string[]; eanImagesRecovered?: number; deepSyncImagesUpdated?: number }> = [];
    for (const shopId of validIds) {
      const creds = await getEmagCredentials(shopId);
      console.log(`[POST /api/store-products/sync] shopId=${shopId} region=${creds.region} baseUrl=${creds.baseUrl}`);
      const result = await syncStoreProducts(creds);
      results.push({
        shopId: result.shopId,
        totalFetched: result.totalFetched,
        upserted: result.upserted,
        rejectedCount: result.rejectedCount,
        errors: result.errors,
        eanImagesRecovered: result.eanImagesRecovered,
        deepSyncImagesUpdated: result.deepSyncImagesUpdated,
      });
    }

    const totalUpserted = results.reduce((s, r) => s + r.upserted, 0);
    res.json({
      code: 200,
      data: {
        results,
        totalUpserted,
      },
      message: `同步完成，共 ${validIds.length} 个店铺，入库 ${totalUpserted} 个产品`,
    });
  } catch (err: any) {
    console.error('[POST /api/store-products/sync]', err);
    const msg = err?.message ?? String(err);
    const isAuthError = /401|403|未授权|禁止|API 账号或密码无效/.test(msg);
    const status = isAuthError ? 400 : 500;
    const responseMsg = isAuthError ? 'API 账号或密码无效，请检查凭证' : msg.slice(0, 500);
    res.status(status).json({ code: status, data: null, message: responseMsg });
  } finally {
    releaseLock('product');
  }
});

/**
 * POST /api/store-products/sync-urls
 * 全量补齐 product_url（遍历 product_url 为 null 的产品，从 API 或构造链接）
 */
const syncUrlsHandler = async (req: Request, res: Response) => {
  console.log('[POST /api/store-products/sync-urls] 收到请求，触发 backfillProductUrls');
  try {
    const result = await backfillProductUrls();
    const nullCount = await prisma.storeProduct.count({ where: { productUrl: null } });
    const total = await prisma.storeProduct.count();
    res.json({
      code: 200,
      data: {
        updated: result.updated,
        total: result.total,
        product_url_null_remaining: nullCount,
        product_url_filled: total - nullCount,
        total_products: total,
        errors: result.errors,
      },
      message: `已补齐 ${result.updated} 个 product_url，当前 null 剩余: ${nullCount}/${total}`,
    });
  } catch (err: any) {
    console.error('[POST /api/store-products/sync-urls]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '服务器内部错误' });
  }
};
router.post('/sync-urls', syncUrlsHandler);
router.post('/sync-urls/', syncUrlsHandler); // 兼容带尾斜杠的请求

/**
 * POST /api/store-products/sync-images
 * 全局图片回补：针对 main_image 为空或 eMAG Logo/占位图的产品（无论店铺/站点），
 * 重新调用融合了提纯算法的 product_offer/read + normalizeEmagProduct 进行回补
 */
const syncImagesHandler = async (req: Request, res: Response) => {
  console.log('[POST /api/store-products/sync-images] 全局图片回补，触发 backfillProductImages');
  try {
    const result = await backfillProductImages();
    const withImage = await prisma.storeProduct.count({
      where: { AND: [{ mainImage: { not: null } }, { mainImage: { not: '' } }] },
    });
    const total = await prisma.storeProduct.count();
    res.json({
      code: 200,
      data: {
        updated: result.updated,
        total: result.total,
        with_image: withImage,
        total_products: total,
        errors: result.errors,
      },
      message: `已补齐 ${result.updated} 个 main_image，当前有图: ${withImage}/${total}`,
    });
  } catch (err: any) {
    console.error('[POST /api/store-products/sync-images]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '服务器内部错误' });
  }
};
router.post('/sync-images', syncImagesHandler);
router.post('/sync-images/', syncImagesHandler);
router.post('/backfill-images', syncImagesHandler); // 全局图片回补（与 sync-images 相同）

/**
 * POST /api/store-products/backfill-comprehensive-sales
 * 全量回填 comprehensive_sales（从 platform_orders 聚合销量后计算并写入）
 * Query: ?shopId=1（可选，不传则全店铺回填）
 */
router.post('/backfill-comprehensive-sales', async (req: Request, res: Response) => {
  const rawShopId = req.body?.shopId ?? req.query?.shopId;
  const shopId = rawShopId != null ? Number(rawShopId) : undefined;
  try {
    const result = await backfillComprehensiveSales(shopId);
    res.json({
      code: 200,
      data: { updated: result.updated, errors: result.errors },
      message: `综合日销回填完成，共更新 ${result.updated} 条`,
    });
  } catch (err: any) {
    console.error('[POST /api/store-products/backfill-comprehensive-sales]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '服务器内部错误' });
  }
});

/**
 * POST /api/store-products/map
 * 手动绑定平台产品与库存 SKU
 *
 * "库存 SKU" 在本系统中指 Product 表里 sku 字段非空的记录（非 Inventory 表）。
 * Body 支持两种方式（向前兼容）：
 *   方式 A（推荐）: { pnk, shopId, inventorySkuId }   ← inventorySkuId = Product.id
 *   方式 B（兼容）: { storeProductId, inventorySku }   ← 直接传内部 ID + SKU 字符串
 *
 * 后端会优先用 pnk+shopId 查出 storeProductId，用 inventorySkuId 查出真实 sku 字符串，再执行绑定。
 */
router.post('/map', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};

    // ── Step 1：解析目标平台产品 ID（storeProductId）──────────────
    let storeProductId: number | undefined;

    if (body.storeProductId) {
      storeProductId = Number(body.storeProductId);
      if (isNaN(storeProductId) || storeProductId <= 0) {
        res.status(400).json({ code: 400, data: null, message: 'storeProductId 格式无效' });
        return;
      }
    } else if (body.pnk && body.shopId) {
      const pnk    = String(body.pnk).trim();
      const shopId = Number(body.shopId);
      if (!pnk || isNaN(shopId) || shopId <= 0) {
        res.status(400).json({ code: 400, data: null, message: 'pnk 或 shopId 格式无效' });
        return;
      }
      const found = await prisma.storeProduct.findUnique({
        where:  { shopId_pnk: { shopId, pnk } },
        select: { id: true },
      });
      if (!found) {
        res.status(404).json({
          code: 404,
          data: null,
          message: `在店铺 ${shopId} 中找不到 PNK 为 "${pnk}" 的平台产品，请先同步产品数据`,
        });
        return;
      }
      storeProductId = found.id;
    } else {
      res.status(400).json({
        code: 400,
        data: null,
        message: '请提供 storeProductId，或同时提供 pnk 和 shopId',
      });
      return;
    }

    // ── Step 2：解析并校验库存 SKU ────────────────────────────────
    // "库存 SKU" = Product 表中 sku 非空的记录。
    // ★ 优先用 inventorySku 字符串（SKU 编号是唯一业务键，最可靠）。
    //   inventorySkuId（Product.id）仅在字符串未提供时作为兜底。
    //   前端可能同时传 inventorySkuId 和 inventorySku，但两者 ID 不一定一致（前端列表的 id
    //   可能来自搜索时的分页偏移，不保证等于 Product.id），所以字符串匹配最稳。
    const rawSkuStr = String(body.inventorySku ?? '').trim();
    const rawSkuId  = body.inventorySkuId ? Number(body.inventorySkuId) : NaN;

    if (!rawSkuStr && isNaN(rawSkuId)) {
      res.status(400).json({
        code: 400,
        data: null,
        message: '请提供 inventorySku（SKU 编号）或 inventorySkuId（库存记录 ID）',
      });
      return;
    }

    let resolvedSku: string | null = null;

    // 路径 A（优先）：按 SKU 字符串精确查 Product.sku
    if (rawSkuStr) {
      const product = await prisma.product.findUnique({
        where:  { sku: rawSkuStr },
        select: { id: true, sku: true },
      });
      if (product?.sku) {
        resolvedSku = product.sku;
      }
    }

    // 路径 B（兜底）：字符串没找到时按 inventorySkuId 查 Product.id
    if (!resolvedSku && !isNaN(rawSkuId) && rawSkuId > 0) {
      const product = await prisma.product.findUnique({
        where:  { id: rawSkuId },
        select: { id: true, sku: true },
      });
      if (product?.sku) {
        resolvedSku = product.sku;
      }
    }

    // 两条路径都没命中 → 报错
    if (!resolvedSku) {
      const hint = rawSkuStr ? `SKU "${rawSkuStr}"` : `ID ${rawSkuId}`;
      res.status(404).json({
        code: 404,
        data: null,
        message: `找不到 ${hint} 对应的库存 SKU 记录，请确认 SKU 是否已在库存管理中创建`,
      });
      return;
    }

    // ── Step 3：校验平台产品存在 ──────────────────────────────────
    const sp = await prisma.storeProduct.findUnique({
      where:  { id: storeProductId },
      select: { id: true, pnk: true, shopId: true },
    });
    if (!sp) {
      res.status(404).json({ code: 404, data: null, message: '平台产品不存在' });
      return;
    }

    // ── Step 4：执行绑定 ──────────────────────────────────────────
    await prisma.storeProduct.update({
      where: { id: storeProductId },
      data:  { mappedInventorySku: resolvedSku },
    });

    res.json({
      code: 200,
      data: { storeProductId, pnk: sp.pnk, shopId: sp.shopId, inventorySku: resolvedSku },
      message: '绑定成功',
    });
  } catch (err) {
    console.error('[POST /api/store-products/map]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

/** 预估物流费：无重量时默认 5，有重量时按 2/kg 粗略估算 (单位与 sale_price 一致) */
const DEFAULT_SHIPPING = 5;
const SHIPPING_PER_KG = 2;

/**
 * GET /api/store-products
 * 查询店铺在售产品，通过 sku 与 Inventory 碰头反哺本地资料
 *
 * Query: shopId (必填), search (可选搜索), page, limit (可选分页)
 * 搜索: search 对 sku / ean / pnk 做模糊匹配 (OR, 大小写不敏感)
 * 返回: pnk, sku, ean, image, main_image, name, purchase_cost, estimated_profit, ...
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (!shopId || isNaN(shopId)) {
      res.status(400).json({ code: 400, data: null, message: '缺少 shopId 参数' });
      return;
    }

    const search = String(req.query.search ?? req.query.query ?? '').trim();
    const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? req.query.pageSize ?? 500), 10) || 500));
    const skip = (page - 1) * limit;

    // 动态排序：前端 Ant Design 传 sortBy(camelCase 或 snake_case) + sortOrder(ascend/descend/asc/desc)
    // snake_case → camelCase 映射，兼容前端两种写法
    const FIELD_MAP: Record<string, string> = {
      comprehensive_sales: 'comprehensiveSales',
      comprehensiveSales: 'comprehensiveSales',
      sale_price: 'salePrice',
      salePrice: 'salePrice',
      stock: 'stock',
      synced_at: 'syncedAt',
      syncedAt: 'syncedAt',
      name: 'name',
    };
    const rawSortBy = String(req.query.sortBy ?? req.query.sort ?? '').trim();
    const rawSortOrder = String(req.query.sortOrder ?? req.query.order ?? '').trim().toLowerCase();
    const sortByField = FIELD_MAP[rawSortBy] ?? '';
    // Ant Design 取消排序时传 'null' 字符串，需过滤
    const sortOrderPrisma: 'asc' | 'desc' =
      rawSortOrder === 'ascend' || rawSortOrder === 'asc' ? 'asc' : 'desc';
    const hasValidSort = sortByField !== '' && rawSortOrder !== '' && rawSortOrder !== 'null' && rawSortOrder !== 'undefined';
    const orderBy: Record<string, 'asc' | 'desc'> = hasValidSort
      ? { [sortByField]: sortOrderPrisma }
      : { syncedAt: 'desc' };

    console.log('=== BACKEND Prisma OrderBy ===', orderBy, { rawSortBy, rawSortOrder, hasValidSort });

    // mappingStatus 筛选：'mapped' | 'unmapped' | 'all'（默认 all）
    const mappingStatus = String(req.query.mappingStatus ?? 'all').trim().toLowerCase();

    // Prisma 无法在一条 where 里同时表达「IS NULL OR = ''」，使用 OR 组合处理空字符串边界
    type WhereClause = {
      shopId: number;
      OR?: Array<Record<string, unknown>>;
      AND?: Array<Record<string, unknown>>;
    };
    const where: WhereClause = { shopId };

    if (mappingStatus === 'mapped') {
      // 已关联：mappedInventorySku 不为 null 且不为空字符串
      where.AND = [
        { mappedInventorySku: { not: null } },
        { mappedInventorySku: { not: '' } },
      ];
    } else if (mappingStatus === 'unmapped') {
      // 未关联：mappedInventorySku 为 null 或为空字符串
      where.OR = [
        { mappedInventorySku: null },
        { mappedInventorySku: '' },
      ];
    }

    if (search) {
      const q = { contains: search, mode: 'insensitive' as const };
      // 四维混合搜索：sku / ean / pnk / name / vendorSku
      // 支持仓库扫码枪输入 EAN 条码、PNK 码、供应商 SKU 等任意标识符
      const searchOr = [
        { sku:       q },   // 本地 SKU
        { ean:       q },   // EAN 条码（精准/模糊均可）
        { pnk:       q },   // eMAG part_number_key（PNK 码）
        { name:      q },   // 平台产品名称（支持关键词搜索）
        { vendorSku: q },   // 供应商 SKU / part_number（仓库备用扫码标识）
      ];
      // 若已有 OR（unmapped 场景），需将搜索条件与现有 OR 通过 AND 组合
      if (mappingStatus === 'unmapped') {
        const existingOr = where.OR;
        delete where.OR;
        where.AND = [
          { OR: existingOr }  as Record<string, unknown>,
          { OR: searchOr }    as Record<string, unknown>,
        ];
      } else {
        // mapped / all 场景：直接追加搜索 OR
        if (where.AND) {
          where.AND.push({ OR: searchOr } as Record<string, unknown>);
        } else {
          where.OR = searchOr as WhereClause['OR'];
        }
      }
    }

    // 分页必须分离查数据与查总数；mappedInventorySku 已改为纯字符串，不再 include Inventory
    const [list, total] = await Promise.all([
      prisma.storeProduct.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          shop: { select: { shopName: true, region: true } },
        },
      }),
      prisma.storeProduct.count({ where }), // 仅 where，无 skip/take，返回符合条件的绝对总条数
    ]);

    console.log(`[StoreProducts] DB actual count: ${total}, page size: ${list.length}`);

    if (search) {
      console.log(`[Search Debug] Keyword: ${search}, Found Records: ${total}`);
    }

    const forceRefresh = String(req.query.refreshSales ?? '').toLowerCase() === '1' || String(req.query.refreshSales ?? '').toLowerCase() === 'true';
    if (forceRefresh) {
      const rawTest = await prisma.$queryRawUnsafe<Array<{ sku: string; total: string | number }>>(
        `SELECT LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\\\r', ''), E'\\\\n', ''))) as sku, SUM(COALESCE((elem->>'quantity')::int, 0)) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE shop_id = ${shopId} AND status IN (1,2,3,4) AND order_time >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY total DESC LIMIT 5`
      );
      console.log('[Sales Raw SQL] SELECT sku, SUM(quantity) FROM platform_orders (parsed):', rawTest.map((r) => `${r.sku}=${r.total}`).join(', '));
    }
    const { map: salesMap, skusWithSales } = await getSalesStatsByShop(shopId, forceRefresh);

    // 收集所有需要查询成本/图片的 SKU 字符串
    const skusToFetch = new Set<string>();
    for (const p of list) {
      const mapped = (p.mappedInventorySku ?? '').trim();
      if (mapped) {
        skusToFetch.add(mapped);
      } else {
        const fallback = (p.sku ?? p.vendorSku ?? '').trim();
        if (fallback) skusToFetch.add(fallback);
      }
    }

    // inventoryMap：三路查询保障图片兜底
    //   路径①  按 mappedInventorySku / sku / vendorSku 查 Product 表（主路径，key = Product.sku）
    //   路径②  按同一 SKU 列表查旧 Inventory 表（历史数据兜底，key = Inventory.sku）
    //   路径③  按 pnk 查 Product 表（防 mappedInventorySku 为空或 SKU 对不上时的最终兜底，key = Product.pnk）
    type InvEntry = {
      localImage:         string | null;
      purchaseCost:       number;
      weight:             number | null;
      localProductId:     number | null;
      localChineseName:   string | null;
      inTransitQuantity:  number;
    };
    const inventoryMap = new Map<string, InvEntry>();
    // 路径③ 的 pnk → InvEntry 索引（在下方单独查询后填充）
    const pnkMap = new Map<string, InvEntry>();

    if (skusToFetch.size > 0) {
      const skuArr = [...skusToFetch];

      // ── 路径①：从 Product 表按 SKU 查（主路径）────────────────────
      // 字段说明：Product.imageUrl (image_url) = 本地库存 SKU 图片
      const productList = await prisma.product.findMany({
        where: { sku: { in: skuArr } },
        select: { id: true, sku: true, pnk: true, imageUrl: true, purchasePrice: true, actualWeight: true, chineseName: true, inTransitQuantity: true },
      });
      // 记录 Product 已命中但 imageUrl 为空的 SKU，需要再去 Inventory 补图
      const noImageProductSkus: string[] = [];
      for (const prod of productList) {
        const entry: InvEntry = {
          localImage:         prod.imageUrl ?? null,   // Product.imageUrl → local_image
          purchaseCost:       Number(prod.purchasePrice ?? 0),
          weight:             prod.actualWeight != null ? Number(prod.actualWeight) : null,
          localProductId:     prod.id,
          localChineseName:   prod.chineseName ?? null,
          inTransitQuantity:  prod.inTransitQuantity ?? 0,
        };
        if (prod.sku) {
          inventoryMap.set(prod.sku, entry);
          if (!prod.imageUrl) noImageProductSkus.push(prod.sku); // 命中但无图，标记补查
        }
        if (prod.pnk) pnkMap.set(prod.pnk, entry); // 同时填充 pnkMap
      }

      // ── 路径②：Inventory 表兜底 ─────────────────────────────────
      // 查询范围 = ① Product 完全未命中的 SKU  +  ② Product 命中但 imageUrl 为空的 SKU
      // 字段说明：Inventory.localImage (local_image) = 手动上传的本地高清图
      const missingSkus     = skuArr.filter((s) => !inventoryMap.has(s));
      const invQuerySkus    = [...new Set([...missingSkus, ...noImageProductSkus])];
      if (invQuerySkus.length > 0) {
        const invList = await prisma.inventory.findMany({
          where: { sku: { in: invQuerySkus } },
          select: { sku: true, localImage: true, purchaseCost: true, weight: true },
        });
        for (const inv of invList) {
          const existing = inventoryMap.get(inv.sku);
          if (existing) {
            // Product 命中但无图：用 Inventory.localImage 回填图片，保留 Product 的其他字段
            if (!existing.localImage && inv.localImage) {
              existing.localImage = inv.localImage;
            }
          } else {
            // Product 完全未命中：从 Inventory 建立完整条目
            inventoryMap.set(inv.sku, {
              localImage:         inv.localImage ?? null,
              purchaseCost:       Number(inv.purchaseCost ?? 0),
              weight:             inv.weight != null ? Number(inv.weight) : null,
              localProductId:     null,
              localChineseName:   null,
              inTransitQuantity:  0,
            });
          }
        }
      }
    }

    // ── 路径③：按 pnk 查 Product（兜底 SKU 路径全部失败的情况）────
    // 只查路径①②均未命中 SKU 的那批 pnk，减少无效 DB 查询
    const pnksToFetch = list
      .filter((p) => {
        const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
        return !skuKey || !inventoryMap.has(skuKey);
      })
      .map((p) => p.pnk)
      .filter((pnk) => !!pnk && !pnkMap.has(pnk));

    if (pnksToFetch.length > 0) {
      const pnkProductList = await prisma.product.findMany({
        where: { pnk: { in: pnksToFetch } },
        select: { id: true, sku: true, pnk: true, imageUrl: true, purchasePrice: true, actualWeight: true, chineseName: true, inTransitQuantity: true },
      });
      for (const prod of pnkProductList) {
        const entry: InvEntry = {
          localImage:         prod.imageUrl ?? null,
          purchaseCost:       Number(prod.purchasePrice ?? 0),
          weight:             prod.actualWeight != null ? Number(prod.actualWeight) : null,
          localProductId:     prod.id,
          localChineseName:   prod.chineseName ?? null,
          inTransitQuantity:  prod.inTransitQuantity ?? 0,
        };
        if (prod.pnk) pnkMap.set(prod.pnk, entry);
        // 如果该 Product 有 SKU，顺便补充到 inventoryMap 以供后续 skuKey 命中
        if (prod.sku) inventoryMap.set(prod.sku, entry);
      }
    }

    // ── 按当前店铺隔离计算 FBE 在途库存 ─────────────────────────────
    // Product.inTransitQuantity 是全局累积值，跨店污染；此处实时聚合：
    //   条件：发货单 shopId === 当前 shopId，状态为 SHIPPED（已发但未入仓）
    // 结果 key = productId（本地 Product 主键）
    const allProductIds = [...inventoryMap.values()]
      .map((e) => e.localProductId)
      .filter((id): id is number => id !== null);
    const pnkProductIds = [...pnkMap.values()]
      .map((e) => e.localProductId)
      .filter((id): id is number => id !== null);
    const productIdsToCheck = [...new Set([...allProductIds, ...pnkProductIds])];

    // productId → 该店在途数量
    const shopInTransitMap = new Map<number, number>();
    if (productIdsToCheck.length > 0) {
      const fbeItems = await prisma.fbeShipmentItem.findMany({
        where: {
          productId: { in: productIdsToCheck },
          shipment:  { shopId, status: 'SHIPPED' },   // ★ 核心隔离：仅计当前店 + 在途状态
        },
        select: { productId: true, quantity: true },
      });
      for (const item of fbeItems) {
        shopInTransitMap.set(
          item.productId,
          (shopInTransitMap.get(item.productId) ?? 0) + item.quantity,
        );
      }
    }

    // 将店铺级在途数回写到 inventoryMap / pnkMap，覆盖全局字段
    for (const entry of inventoryMap.values()) {
      if (entry.localProductId !== null) {
        entry.inTransitQuantity = shopInTransitMap.get(entry.localProductId) ?? 0;
      }
    }
    for (const entry of pnkMap.values()) {
      if (entry.localProductId !== null) {
        entry.inTransitQuantity = shopInTransitMap.get(entry.localProductId) ?? 0;
      }
    }
    // ─────────────────────────────────────────────────────────────────

    const shopName = list[0]?.shop?.shopName ?? '';
    const shopRegion = list[0]?.shop?.region;
    const region = shopRegion && ['RO', 'BG', 'HU'].includes(shopRegion) ? shopRegion : resolveRegion(shopName);
    const defaultCurrency = (region && REGION_CURRENCY[region as keyof typeof REGION_CURRENCY]) ?? 'RON';

    let zeroSalesDiagnosticCount = 0;
    const data = list.map((p) => {
      const v = p.validationStatus ?? (p.status === 1 ? 'active' : 'rejected');
      const validationStatusDisplay = v === 'rejected' || v === 'inactive' ? '已驳回' : '已通过';
      const displayName = p.name || (validationStatusDisplay === '已驳回' ? '待更新' : '待完善');
      const salePriceNum = Number(p.salePrice);
      const stockNum = p.stock;
      const isRejected = validationStatusDisplay === '已驳回';

      const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
      // 三路查：① SKU 精确匹配 → ② pnk 兜底（mappedInventorySku 为空或 SKU 对不上时）
      const inv = (skuKey ? inventoryMap.get(skuKey) : undefined) ?? pnkMap.get(p.pnk);

      // 图片三级回退：平台主图 → 平台副图 → 本地库存 SKU 图片
      const emagImage = p.mainImage ?? p.imageUrl ?? null;
      const localImage = inv?.localImage ?? null;
      const finalImage = emagImage || localImage || null;

      const purchaseCost = inv ? Number(inv.purchaseCost ?? 0) : 0;
      const invWeight = inv?.weight != null ? Number(inv.weight) : null;
      const estShipping = invWeight != null && invWeight > 0 ? invWeight * SHIPPING_PER_KG : DEFAULT_SHIPPING;
      const estimatedProfit = salePriceNum - (purchaseCost + estShipping);

      const currency = p.currency ?? defaultCurrency;

      const sales_stats = getSalesForProduct(salesMap, p.sku, p.vendorSku);
      if (sales_stats.d30 === 0 && skusWithSales.length > 0 && zeroSalesDiagnosticCount < 3) {
        logZeroSalesDiagnostic(p.sku, p.vendorSku, salesMap, skusWithSales);
        zeroSalesDiagnosticCount++;
      }

      const salesStatsObj = { d7: sales_stats.d7, d14: sales_stats.d14, d30: sales_stats.d30 };

      // ★ 强耦合计算：在同一作用域内用实时销量原子计算 comprehensive_sales
      // 公式: (d7/7*0.3) + (d14/14*0.3) + (d30/30*0.4)，与 backfillComprehensiveSales 完全一致
      const compSales = parseFloat(
        (((sales_stats.d7 || 0) / 7) * 0.3 + ((sales_stats.d14 || 0) / 14) * 0.3 + ((sales_stats.d30 || 0) / 30) * 0.4).toFixed(2)
      );
      const productUrl = p.productUrl ?? (() => {
        const domain = (region && REGION_DOMAIN[region as keyof typeof REGION_DOMAIN]) ?? 'emag.ro';
        const name = (p.name ?? '').trim();
        const slug = name
          ? name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 150)
          : 'product';
        return `https://www.${domain}/${slug}/pd/${p.pnk}/`;
      })();
      return {
        id: p.id,
        pnk: p.pnk,
        sku: p.sku ?? null,
        ean: p.ean ?? null,
        mapped_inventory_sku: p.mappedInventorySku ?? null,
        product_url: productUrl,
        image: finalImage,
        imageUrl: finalImage,
        main_image: finalImage,
        local_image: localImage,
        name: displayName,
        vendor_sku: p.vendorSku ?? null,
        emagOfferId: p.emagOfferId,
        sale_price: salePriceNum,
        sale_price_display: isRejected && salePriceNum === 0 ? '待更新' : salePriceNum,
        currency,
        stock: stockNum,
        stock_display: isRejected && stockNum === 0 ? '待更新' : stockNum,
        purchase_cost: purchaseCost || null,
        local_product_id:    inv?.localProductId    ?? null,
        local_chinese_name:  inv?.localChineseName  ?? null,
        in_transit_quantity: inv?.inTransitQuantity ?? 0,
        estimated_profit: Number(estimatedProfit.toFixed(2)),
        comprehensive_sales: compSales,   // 实时计算，与 sales_stats 强耦合，永不陈旧
        sales_stats: salesStatsObj,
        salesStats: salesStatsObj,
        validation_status: validationStatusDisplay,
        doc_errors: p.docErrors ?? null,
        rejection_reason: p.rejectionReason ?? null,
      };
    });

    const sampleWithSales = data.find((d) => (d.sales_stats?.d30 ?? 0) > 0);
    if (sampleWithSales) {
      console.log(`[StoreProducts] Sample product with sales: ${sampleWithSales.name} -> d7=${sampleWithSales.sales_stats?.d7}, d14=${sampleWithSales.sales_stats?.d14}, d30=${sampleWithSales.sales_stats?.d30}, compSales=${sampleWithSales.comprehensive_sales}`);
    } else {
      console.log(`[StoreProducts] Sample product with sales: (none in this page, total ${data.length} products)`);
    }

    // ★ 异步写回 DB：将本次实时计算结果持久化到 store_products.comprehensive_sales
    // 火箭发射式（fire-and-forget），不阻塞响应，失败只打印日志
    // 只写有变化的行（stale 检测），避免无意义写入
    const staleItems = data
      .map((d, i) => ({ id: list[i].id, newVal: d.comprehensive_sales, oldVal: list[i].comprehensiveSales }))
      .filter((x) => Math.abs(x.newVal - x.oldVal) > 0.001);
    if (staleItems.length > 0) {
      setImmediate(async () => {
        try {
          await Promise.all(
            staleItems.map((x) => prisma.storeProduct.update({ where: { id: x.id }, data: { comprehensiveSales: x.newVal } }))
          );
          console.log(`[StoreProducts] 后台写回 comprehensive_sales: ${staleItems.length} 条已更新 (shopId=${shopId})`);
        } catch (e) {
          console.error('[StoreProducts] 后台写回 comprehensive_sales 失败:', e instanceof Error ? e.message : e);
        }
      });
    }

    console.log('=== PAGING DEBUG ===', { listLength: list.length, actualTotal: total, page, limit, shopId });
    res.json({ code: 200, data: { list: data, total, page, limit }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/store-products]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
