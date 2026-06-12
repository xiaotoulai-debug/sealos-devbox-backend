/**
 * 店铺在售产品 API — StoreProduct + Inventory SKU 碰头
 *
 * 数据源: StoreProduct（eMAG 同步），通过 mapped_inventory_sku 联表 Inventory
 * 图片优先级: 平台 main_image/imageUrl > 本地 Inventory.local_image（本地关联 SKU 兜底）
 * 毛利预估: sale_price - (purchase_cost + 预估物流费)
 */

import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { getEmagCredentials, resolveRegion, REGION_CURRENCY, REGION_DOMAIN } from '../services/emagClient';
import { getSalesStatsByShop, getSalesForProduct, logZeroSalesDiagnostic } from '../services/salesStats';
import { tryAcquireLock, releaseLock } from '../lib/syncStatus';
import { backfillProductUrls, backfillProductImages, syncStoreProducts, backfillComprehensiveSales } from '../services/storeProductSync';
import { recalcProfitForShop, recalcProfitForAllShops } from '../services/profitCalculator';
import { syncExchangeRates } from '../services/exchangeRateSync';
import { resolveEffectiveStockSignals, scheduleStockSignalBackfill } from '../services/firstAvailableAt';
import { buildOperationAdvice } from '../services/operationAdvice';
import {
  buildPurchaseSuggestion,
  getMatchedStoreProductIdsByProductClass,
  getMatchedStoreProductIdsByOverviewFilters,
  getProductStructureSummary,
  getStoreProductOverview,
  isPurchaseActionFilter,
  isStockGroupFilter,
  isStockStatusFilter,
  type PurchaseActionKey,
  PURCHASE_ACTION_FILTERS,
  STOCK_GROUP_FILTERS,
  STOCK_STATUS_FILTERS,
  type StockGroupKey,
} from '../services/storeProductOverview';
import {
  calculateComprehensiveSales,
  calculateStockStatus,
  classifyStoreProduct,
  normalizeProductClassQuery,
  PRODUCT_CLASSES,
  PRODUCT_CLASS_NAMES,
  recalcProductClassForAllShops,
  recalcProductClassForShop,
  type StockStatus,
} from '../services/productClassification';
import {
  inferContentPermission,
  inferLinkActionTips,
  inferOfferCompetition,
  LINK_TYPE_LABELS,
  OFFER_COMPETITION_LABELS,
  normalizeOwnershipDisplay,
  resolveBrandFromOfferMeta,
  resolveLinkTypeReasonFromOfferMeta,
  type EmagLinkType,
  type LinkTypeReason,
  type OfferCompetitionType,
} from '../services/emagLinkType';
import {
  BUY_BOX_STATUS_LABELS,
  inferBuyBoxStatus,
  type BuyBoxStatus,
  type BuyBoxStatusConfidence,
  type BuyBoxStatusSource,
} from '../services/emagBuyBox';

const router = Router();
router.use(authenticate);

const PRODUCT_CLASS_SUMMARY_KEYS = PRODUCT_CLASSES;

function normalizeNullableDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeStoredLinkType(value: string | null | undefined): EmagLinkType {
  return value === 'SELF_BUILT' || value === 'RESELL' || value === 'OWN_BRAND_RESELL' || value === 'UNKNOWN'
    ? value
    : 'UNKNOWN';
}

function normalizeStoredCompetitionType(value: string | null | undefined): OfferCompetitionType {
  return value === 'NO_ACTIVE_COMPETITION' || value === 'EXCLUSIVE' || value === 'COMPETITIVE' || value === 'UNKNOWN' ? value : 'UNKNOWN';
}

function normalizeStoredBuyBoxStatus(value: string | null | undefined): BuyBoxStatus {
  return value === 'WON' ||
    value === 'LOST' ||
    value === 'UNKNOWN' ||
    value === 'NO_ACTIVE_BUYBOX' ||
    value === 'POSSIBLY_WON' ||
    value === 'POSSIBLY_LOST'
    ? value
    : 'UNKNOWN';
}

function normalizeStoredBuyBoxSource(value: string | null | undefined): BuyBoxStatusSource {
  return value === 'BUY_BUTTON_RANK' || value === 'PRICE_HEURISTIC' || value === 'OFFER_STATE' || value === 'UNKNOWN'
    ? value
    : 'UNKNOWN';
}

function normalizeStoredBuyBoxConfidence(value: string | null | undefined): BuyBoxStatusConfidence {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' ? value : 'LOW';
}

type BuyBoxGroupFilter = 'ALL' | 'WON' | 'NOT_WON' | 'UNKNOWN';
type LinkTypeFilter = 'ALL' | 'SELF_BUILT' | 'RESELL' | 'OWN_BRAND_RESELL' | 'UNKNOWN';

function normalizeBuyBoxGroupFilter(value: unknown): BuyBoxGroupFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? 'ALL').trim().toUpperCase();
  return normalized === 'WON' || normalized === 'NOT_WON' || normalized === 'UNKNOWN' || normalized === 'ALL'
    ? normalized
    : 'ALL';
}

function normalizeLinkTypeFilter(value: unknown): LinkTypeFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw ?? 'ALL').trim().toUpperCase();
  return normalized === 'SELF_BUILT'
    || normalized === 'RESELL'
    || normalized === 'OWN_BRAND_RESELL'
    || normalized === 'UNKNOWN'
    || normalized === 'ALL'
    ? normalized
    : 'ALL';
}

function appendStoreProductAnd(
  where: Prisma.StoreProductWhereInput,
  condition: Prisma.StoreProductWhereInput,
): void {
  const andClauses = where.AND
    ? Array.isArray(where.AND) ? where.AND : [where.AND]
    : [];
  andClauses.push(condition);
  where.AND = andClauses;
}

function normalizeActionTips(value: unknown, linkType: EmagLinkType, offerCompetitionType: OfferCompetitionType): string[] {
  if (Array.isArray(value)) {
    const tips = value.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (tips.length > 0) return tips;
  }
  return inferLinkActionTips(linkType, offerCompetitionType);
}

function normalizeStoredTips(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    const tips = value.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (tips.length > 0) return tips;
  }
  return fallback;
}

function buildStoreProductListWhere(shopId: number, mappingStatus: string, search: string): Prisma.StoreProductWhereInput {
  const where: Prisma.StoreProductWhereInput = { shopId, isArchived: false };

  if (mappingStatus === 'mapped') {
    where.AND = [
      { mappedInventorySku: { not: null } },
      { mappedInventorySku: { not: '' } },
    ];
  } else if (mappingStatus === 'unmapped') {
    where.OR = [
      { mappedInventorySku: null },
      { mappedInventorySku: '' },
    ];
  }

  if (!search) return where;

  const q = { contains: search, mode: 'insensitive' as const };
  const eanSearchTerms: string[] = [search];
  if (/^\d{12,13}$/.test(search)) {
    const withLeadingZero = search.padStart(13, '0');
    const withoutLeadingZero = search.replace(/^0+/, '') || search;
    if (!eanSearchTerms.includes(withLeadingZero)) eanSearchTerms.push(withLeadingZero);
    if (!eanSearchTerms.includes(withoutLeadingZero)) eanSearchTerms.push(withoutLeadingZero);
  }
  const eanOrConditions = eanSearchTerms.map((t) => ({ ean: { equals: t, mode: 'insensitive' as const } }));
  const searchOr = [
    { sku: q },
    ...eanOrConditions,
    { pnk: q },
    { name: q },
    { vendorSku: q },
  ];

  if (mappingStatus === 'unmapped') {
    const existingOr = where.OR;
    delete where.OR;
    where.AND = [
      { OR: existingOr } as Prisma.StoreProductWhereInput,
      { OR: searchOr } as Prisma.StoreProductWhereInput,
    ];
  } else if (where.AND) {
    const andClauses = Array.isArray(where.AND) ? where.AND : [where.AND];
    andClauses.push({ OR: searchOr } as Prisma.StoreProductWhereInput);
    where.AND = andClauses;
  } else {
    where.OR = searchOr as Prisma.StoreProductWhereInput['OR'];
  }

  return where;
}

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
    const nullCount = await prisma.storeProduct.count({ where: { productUrl: null, isArchived: false } });
    const total = await prisma.storeProduct.count({ where: { isArchived: false } });
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
      where: { isArchived: false, AND: [{ mainImage: { not: null } }, { mainImage: { not: '' } }] },
    });
    const total = await prisma.storeProduct.count({ where: { isArchived: false } });
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
 * POST /api/store-products/recalc-product-class
 * 手动触发平台产品分类重算。默认真实写库；传 dryRun=true 可只预览。
 * Body: { shopId?: number, dryRun?: boolean }
 */
router.post('/recalc-product-class', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const rawShopId = req.body?.shopId ?? req.query?.shopId;
    const rawDryRun = req.body?.dryRun ?? req.query?.dryRun;
    const dryRun = rawDryRun === true || String(rawDryRun ?? '').toLowerCase() === 'true' || String(rawDryRun ?? '') === '1';

    if (rawShopId != null) {
      const shopId = Number(rawShopId);
      if (!Number.isInteger(shopId) || shopId <= 0) {
        res.status(400).json({ code: 400, data: null, message: 'shopId 无效' });
        return;
      }
      const result = await recalcProductClassForShop(shopId, { dryRun });
      res.json({ code: 200, data: result, message: dryRun ? '产品分类 dry-run 完成' : '产品分类重算完成' });
      return;
    }

    const results = await recalcProductClassForAllShops({ dryRun });
    const totalScanned = results.reduce((sum, r) => sum + r.scanned, 0);
    const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
    res.json({
      code: 200,
      data: { results, totalScanned, totalUpdated },
      message: dryRun ? '全店铺产品分类 dry-run 完成' : '全店铺产品分类重算完成',
    });
  } catch (err: any) {
    console.error('[POST /api/store-products/recalc-product-class]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '产品分类重算失败' });
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
      const found = await prisma.storeProduct.findFirst({
        where:  { shopId, pnk, isArchived: false },
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
      select: { id: true, pnk: true, shopId: true, isArchived: true },
    });
    if (!sp || sp.isArchived) {
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
 * GET /api/store-products/classification-summary
 * 平台产品分类数量汇总，用于前端分类下拉框展示。
 *
 * Query: shopId (必填), mappingStatus/search (预留并按列表口径支持)
 */
router.get('/classification-summary', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (!Number.isInteger(shopId) || shopId <= 0) {
      res.status(400).json({ code: 400, data: null, message: '缺少 shopId 参数' });
      return;
    }

    const shop = await prisma.shopAuthorization.findFirst({
      where: { id: shopId, platform: { equals: 'emag', mode: 'insensitive' } },
      select: { id: true },
    });
    if (!shop) {
      res.status(404).json({ code: 404, data: null, message: '未找到有效的 eMAG 店铺' });
      return;
    }

    const mappingStatus = String(req.query.mappingStatus ?? 'all').trim().toLowerCase();
    const search = String(req.query.search ?? req.query.query ?? '').trim();
    const where = buildStoreProductListWhere(shopId, mappingStatus, search);

    const summary = await getProductStructureSummary(shopId, where);
    res.json({ code: 200, data: summary, message: 'success' });
  } catch (err) {
    console.error('[GET /api/store-products/classification-summary] Error:', err);
    res.status(500).json({ code: 500, data: null, message: err instanceof Error ? err.message : '分类统计失败' });
  }
});

/**
 * GET /api/store-products/store-overview
 * 平台产品店铺结构概览：产品结构、库存风险、采购动作。
 *
 * Query: shopId (必填)
 */
router.get('/store-overview', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (!Number.isInteger(shopId) || shopId <= 0) {
      res.status(400).json({ code: 400, data: null, message: '缺少 shopId 参数' });
      return;
    }

    const shop = await prisma.shopAuthorization.findFirst({
      where: { id: shopId, platform: { equals: 'emag', mode: 'insensitive' } },
      select: { id: true },
    });
    if (!shop) {
      res.status(404).json({ code: 404, data: null, message: '未找到有效的 eMAG 店铺' });
      return;
    }

    const overview = await getStoreProductOverview(shopId);
    res.json({ code: 200, data: overview, message: 'success' });
  } catch (err) {
    console.error('[GET /api/store-products/store-overview] Error:', err);
    res.status(500).json({ code: 500, data: null, message: err instanceof Error ? err.message : '店铺结构概览统计失败' });
  }
});

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
    const rawProductClass = req.query.productClass ?? req.query.product_class;
    const productClassFilter = normalizeProductClassQuery(rawProductClass);
    if (rawProductClass != null && productClassFilter == null) {
      res.status(400).json({
        code: 400,
        data: null,
        message: 'productClass 无效，合法值：HOT/POTENTIAL/NORMAL/CLEARANCE/NEW/all',
      });
      return;
    }
    const rawStockStatus = req.query.stockStatus ?? req.query.stock_status;
    const normalizedStockStatus = rawStockStatus == null
      ? undefined
      : String(Array.isArray(rawStockStatus) ? rawStockStatus[0] : rawStockStatus).trim().toUpperCase();
    if (normalizedStockStatus && !isStockStatusFilter(normalizedStockStatus)) {
      res.status(400).json({
        code: 400,
        data: null,
        message: `stockStatus 无效，合法值：${STOCK_STATUS_FILTERS.join('/')}`,
      });
      return;
    }
    const stockStatusFilter: StockStatus | undefined = normalizedStockStatus && isStockStatusFilter(normalizedStockStatus)
      ? normalizedStockStatus
      : undefined;
    const rawPurchaseAction = req.query.purchaseAction ?? req.query.purchase_action;
    const normalizedPurchaseAction = rawPurchaseAction == null
      ? undefined
      : String(Array.isArray(rawPurchaseAction) ? rawPurchaseAction[0] : rawPurchaseAction).trim().toUpperCase();
    if (normalizedPurchaseAction && !isPurchaseActionFilter(normalizedPurchaseAction)) {
      res.status(400).json({
        code: 400,
        data: null,
        message: `purchaseAction 无效，合法值：${PURCHASE_ACTION_FILTERS.join('/')}`,
      });
      return;
    }
    const purchaseActionFilter: PurchaseActionKey | undefined = normalizedPurchaseAction && isPurchaseActionFilter(normalizedPurchaseAction)
      ? normalizedPurchaseAction
      : undefined;
    const rawStockGroup = req.query.stockGroup ?? req.query.stock_group;
    const normalizedStockGroup = rawStockGroup == null
      ? undefined
      : String(Array.isArray(rawStockGroup) ? rawStockGroup[0] : rawStockGroup).trim().toUpperCase();
    const stockGroupFilter: StockGroupKey | undefined =
      normalizedStockGroup && normalizedStockGroup !== 'ALL' && isStockGroupFilter(normalizedStockGroup)
        ? normalizedStockGroup
        : undefined;
    if (normalizedStockGroup && normalizedStockGroup !== 'ALL' && !isStockGroupFilter(normalizedStockGroup)) {
      console.warn(`[GET /api/store-products] 忽略非法 stockGroup=${normalizedStockGroup}，合法值：ALL/${STOCK_GROUP_FILTERS.join('/')}`);
    }
    const buyBoxGroupFilter = normalizeBuyBoxGroupFilter(req.query.buyBoxGroup ?? req.query.buy_box_group);
    const linkTypeFilter = normalizeLinkTypeFilter(req.query.linkType ?? req.query.link_type);

    // Prisma 无法在一条 where 里同时表达「IS NULL OR = ''」，使用 OR 组合处理空字符串边界
    const where: Prisma.StoreProductWhereInput = { shopId, isArchived: false };

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

      // EAN 双格式容错：当搜索词为纯数字 12~13 位时（扫码枪 / 手动输入），
      // 同时匹配「带前导零的 13 位标准格式」与「去除前导零的短格式」，
      // 避免因历史数据格式不一致导致漏搜。
      // 使用 ean 字段 B-tree 索引（store_products_ean_idx），不触发全表扫描。
      const eanSearchTerms: string[] = [search];
      if (/^\d{12,13}$/.test(search)) {
        const withLeadingZero    = search.padStart(13, '0');
        const withoutLeadingZero = search.replace(/^0+/, '') || search; // 防止全零
        if (!eanSearchTerms.includes(withLeadingZero))    eanSearchTerms.push(withLeadingZero);
        if (!eanSearchTerms.includes(withoutLeadingZero)) eanSearchTerms.push(withoutLeadingZero);
      }
      // EAN 搜索：对每个候选格式生成一条 equals 条件（走索引），合并为 OR
      const eanOrConditions = eanSearchTerms.map((t) => ({ ean: { equals: t, mode: 'insensitive' as const } }));

      // 四维混合搜索：sku / ean / pnk / name / vendorSku
      // 支持仓库扫码枪输入 EAN 条码、PNK 码、供应商 SKU 等任意标识符
      const searchOr = [
        { sku:       q },   // 本地 SKU
        ...eanOrConditions, // EAN 条码（双格式兼容，走 ean 索引）
        { pnk:       q },   // eMAG part_number_key（PNK 码）
        { name:      q },   // 平台产品名称（支持关键词搜索）
        { vendorSku: q },   // 供应商 SKU / part_number（仓库备用扫码标识）
      ];
      // 若已有 OR（unmapped 场景），需将搜索条件与现有 OR 通过 AND 组合
      if (mappingStatus === 'unmapped') {
        const existingOr = where.OR;
        delete where.OR;
        where.AND = [
          { OR: existingOr }  as Prisma.StoreProductWhereInput,
          { OR: searchOr }    as Prisma.StoreProductWhereInput,
        ];
      } else {
        // mapped / all 场景：直接追加搜索 OR
        if (where.AND) {
          const andClauses = Array.isArray(where.AND) ? where.AND : [where.AND];
          andClauses.push({ OR: searchOr } as Prisma.StoreProductWhereInput);
          where.AND = andClauses;
        } else {
          where.OR = searchOr as Prisma.StoreProductWhereInput['OR'];
        }
      }
    }

    if (buyBoxGroupFilter === 'WON') {
      appendStoreProductAnd(where, { buyBoxStatus: 'WON' });
    } else if (buyBoxGroupFilter === 'NOT_WON') {
      appendStoreProductAnd(where, { buyBoxStatus: { in: ['LOST', 'NO_ACTIVE_BUYBOX', 'POSSIBLY_LOST'] } });
    } else if (buyBoxGroupFilter === 'UNKNOWN') {
      appendStoreProductAnd(where, {
        OR: [
          { buyBoxStatus: { in: ['UNKNOWN', 'POSSIBLY_WON'] } },
          { buyBoxStatus: null },
        ],
      });
    }

    if (linkTypeFilter === 'SELF_BUILT') {
      appendStoreProductAnd(where, { emagLinkType: 'SELF_BUILT' });
    } else if (linkTypeFilter === 'RESELL') {
      appendStoreProductAnd(where, { emagLinkType: 'RESELL' });
    } else if (linkTypeFilter === 'OWN_BRAND_RESELL') {
      appendStoreProductAnd(where, { emagLinkType: 'OWN_BRAND_RESELL' });
    } else if (linkTypeFilter === 'UNKNOWN') {
      appendStoreProductAnd(where, {
        OR: [
          { emagLinkType: 'UNKNOWN' },
          { emagLinkType: null },
        ],
      });
    }

    const realtimeFilterIdSets: number[][] = [];
    if (productClassFilter && productClassFilter !== 'all') {
      realtimeFilterIdSets.push(await getMatchedStoreProductIdsByProductClass(shopId, productClassFilter, where));
    }

    if (stockStatusFilter || stockGroupFilter || purchaseActionFilter) {
      const matchedIds = await getMatchedStoreProductIdsByOverviewFilters(shopId, {
        ...(stockStatusFilter ? { stockStatus: stockStatusFilter } : {}),
        ...(stockGroupFilter ? { stockGroup: stockGroupFilter } : {}),
        ...(purchaseActionFilter ? { purchaseAction: purchaseActionFilter } : {}),
      }, where);
      realtimeFilterIdSets.push(matchedIds);
    }

    if (realtimeFilterIdSets.length > 0) {
      const [firstSet, ...restSets] = realtimeFilterIdSets.map((ids) => new Set(ids));
      const matchedIds = [...firstSet].filter((id) => restSets.every((set) => set.has(id)));
      where.id = { in: matchedIds };
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
    const normalizeSkuKey = (value: string | null | undefined) => String(value ?? '').trim().toLowerCase();
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
          inventoryMap.set(normalizeSkuKey(prod.sku), entry);
          if (!prod.imageUrl) noImageProductSkus.push(prod.sku); // 命中但无图，标记补查
        }
        if (prod.pnk) pnkMap.set(prod.pnk, entry); // 同时填充 pnkMap
      }

      // ── 路径②：Inventory 表兜底 ─────────────────────────────────
      // 查询范围 = ① Product 完全未命中的 SKU  +  ② Product 命中但 imageUrl 为空的 SKU
      // 字段说明：Inventory.localImage (local_image) = 手动上传的本地高清图
      const missingSkus     = skuArr.filter((s) => !inventoryMap.has(normalizeSkuKey(s)));
      const invQuerySkus    = [...new Set([...missingSkus, ...noImageProductSkus])];
      if (invQuerySkus.length > 0) {
        const invList = await prisma.inventory.findMany({
          where: { sku: { in: invQuerySkus } },
          select: { sku: true, localImage: true, purchaseCost: true, weight: true },
        });
        for (const inv of invList) {
          const existing = inventoryMap.get(normalizeSkuKey(inv.sku));
          if (existing) {
            // Product 命中但无图：用 Inventory.localImage 回填图片，保留 Product 的其他字段
            if (!existing.localImage && inv.localImage) {
              existing.localImage = inv.localImage;
            }
          } else {
            // Product 完全未命中：从 Inventory 建立完整条目
            inventoryMap.set(normalizeSkuKey(inv.sku), {
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
        return !skuKey || !inventoryMap.has(normalizeSkuKey(skuKey));
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
        if (prod.sku) inventoryMap.set(normalizeSkuKey(prod.sku), entry);
      }
    }

    // ── 按当前店铺隔离计算 FBE 在途库存（SKU / Product.id 维度，非 PNK 维度）──
    // Product.inTransitQuantity 是全局累积值，跨店污染；此处实时聚合：
    //   条件：发货单 shopId === 当前 shopId，状态为 SHIPPED（已发但未入仓）
    //   聚合 key = 本地 Product.id（通过 mappedInventorySku / sku 映射）
    // 如果多个 StoreProduct / PNK 绑定同一个本地 Product.id，它们会共享同一在途数量。
    // 这不是 PNK 维度；API 返回 inTransitScope=SKU 标明口径。
    const allProductIds = [...inventoryMap.values()]
      .map((e) => e.localProductId)
      .filter((id): id is number => id !== null);
    const pnkProductIds = [...pnkMap.values()]
      .map((e) => e.localProductId)
      .filter((id): id is number => id !== null);
    const productIdsToCheck = [...new Set([...allProductIds, ...pnkProductIds])];

    // ── 智能采购建议：批量聚合本地库存，避免逐行查询 ─────────────────
    type StockAgg = { localStock: number };
    const warehouseStockMap = new Map<number, StockAgg>();
    if (productIdsToCheck.length > 0) {
      const whStocks = await prisma.warehouseStock.findMany({
        where:  { productId: { in: productIdsToCheck } },
        select: { productId: true, stockQuantity: true },
      });
      for (const ws of whStocks) {
        const agg = warehouseStockMap.get(ws.productId) ?? { localStock: 0 };
        agg.localStock += Number(ws.stockQuantity ?? 0);
        warehouseStockMap.set(ws.productId, agg);
      }
    }

    // ── 智能采购建议：批量聚合采购在途（当前店铺 + 通用备货）──────────
    const purchasingInTransitMap = new Map<number, number>();
    if (productIdsToCheck.length > 0) {
      const productIdSet = new Set(productIdsToCheck);
      const activePurchaseItems = await prisma.purchaseOrderItem.findMany({
        where: {
          purchaseOrder: {
            status: { in: ['PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL'] },
            OR: [{ shopId }, { shopId: null }],
          },
        },
        select: { productIds: true, quantity: true, receivedQuantity: true },
      });
      for (const item of activePurchaseItems) {
        let pids: number[] = [];
        try {
          pids = JSON.parse(item.productIds ?? '[]')
            .map((id: unknown) => Number(id))
            .filter((id: number) => Number.isInteger(id) && productIdSet.has(id));
        } catch { /* ignore malformed productIds */ }
        if (pids.length === 0) continue;
        const remainingQty = Math.max(0, Number(item.quantity ?? 0) - Number(item.receivedQuantity ?? 0));
        if (remainingQty <= 0) continue;
        const qtyPerProduct = remainingQty / pids.length;
        for (const pid of pids) {
          purchasingInTransitMap.set(pid, (purchasingInTransitMap.get(pid) ?? 0) + qtyPerProduct);
        }
      }
    }

    // ── 智能采购建议：批量聚合本店采购计划中数量（Product 动态计划表）──
    const planningStockMap = new Map<string, number>();
    const planSkuArr = [...new Set([...skusToFetch].map((sku) => sku.trim()).filter(Boolean))];
    if (planSkuArr.length > 0) {
      const planningProducts = await prisma.product.findMany({
        where: {
          sku:             { in: planSkuArr },
          status:          'PURCHASING',
          purchaseOrderId: null,
          OR: [{ shopId }, { shopId: null }],
        },
        select: { sku: true, purchaseQuantity: true },
      });
      for (const prod of planningProducts) {
        const key = normalizeSkuKey(prod.sku);
        if (!key) continue;
        planningStockMap.set(key, (planningStockMap.get(key) ?? 0) + Number(prod.purchaseQuantity ?? 0));
      }
    }

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

    const stockSignalPatches = new Map<number, import('../services/firstAvailableAt').StockSignalDbPatch>();
    const stockSignalMap = new Map<number, import('../services/firstAvailableAt').EffectiveStockSignals>();
    for (const p of list) {
      const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
      const inv = (skuKey ? inventoryMap.get(normalizeSkuKey(skuKey)) : undefined) ?? pnkMap.get(p.pnk);
      const inTransit = Number(inv?.inTransitQuantity ?? 0);
      const salesStats = getSalesForProduct(salesMap, p.sku, p.vendorSku, p.pnk);
      const { signals, pendingDbPatch } = resolveEffectiveStockSignals(
        {
          id: p.id,
          stock: p.stock,
          inTransitStock: inTransit,
          firstAvailableAt: p.firstAvailableAt ?? null,
          firstInboundAt: p.firstInboundAt ?? null,
          firstStockSignalAt: p.firstStockSignalAt ?? null,
        },
        salesStats,
      );
      stockSignalMap.set(p.id, signals);
      if (Object.keys(pendingDbPatch).length > 0) {
        stockSignalPatches.set(p.id, pendingDbPatch);
      }
    }
    if (stockSignalPatches.size > 0) {
      scheduleStockSignalBackfill(stockSignalPatches);
    }
    // ─────────────────────────────────────────────────────────────────

    const shopName = list[0]?.shop?.shopName ?? '';
    const shopRegion = list[0]?.shop?.region;
    const region = shopRegion && ['RO', 'BG', 'HU'].includes(shopRegion) ? shopRegion : resolveRegion(shopName);
    const defaultCurrency = (region && REGION_CURRENCY[region as keyof typeof REGION_CURRENCY]) ?? 'RON';

    let zeroSalesDiagnosticCount = 0;
    const nowMs = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const data = list.map((p) => {
      const v = p.validationStatus ?? (p.status === 1 ? 'active' : 'rejected');
      const validationStatusDisplay = v === 'rejected' || v === 'inactive' ? '已驳回' : '已通过';
      const displayName = p.name || (validationStatusDisplay === '已驳回' ? '待更新' : '待完善');
      const salePriceNum = Number(p.salePrice);
      const stockNum = p.stock;
      const isRejected = validationStatusDisplay === '已驳回';

      const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
      // 三路查：① SKU 精确匹配 → ② pnk 兜底（mappedInventorySku 为空或 SKU 对不上时）
      const inv = (skuKey ? inventoryMap.get(normalizeSkuKey(skuKey)) : undefined) ?? pnkMap.get(p.pnk);

      // 图片三级回退：平台主图 → 平台副图 → 本地库存 SKU 图片
      const emagImage = p.mainImage ?? p.imageUrl ?? null;
      const localImage = inv?.localImage ?? null;
      const finalImage = emagImage || localImage || null;

      const purchaseCost = inv ? Number(inv.purchaseCost ?? 0) : 0;

      const currency = p.currency ?? defaultCurrency;

      const sales_stats = getSalesForProduct(salesMap, p.sku, p.vendorSku, p.pnk);
      if (sales_stats.d30 === 0 && skusWithSales.length > 0 && zeroSalesDiagnosticCount < 3) {
        logZeroSalesDiagnostic(p.sku, p.vendorSku, salesMap, skusWithSales);
        zeroSalesDiagnosticCount++;
      }

      const salesStatsObj = {
        d3: sales_stats.d3,
        d7: sales_stats.d7,
        d14: sales_stats.d14,
        d30: sales_stats.d30,
        d60: sales_stats.d60,
        d90: sales_stats.d90,
        d180: sales_stats.d180,
        lastOrderAt: sales_stats.lastOrderAt,
      };

      // ★ 强耦合计算：在同一作用域内用实时销量原子计算 comprehensive_sales。
      // 统一使用 3/7/14/30/60/90 天窗口 + 断货保护，避免旧缓存分类与列表口径漂移。
      const compSales = calculateComprehensiveSales(sales_stats, stockNum);
      const stockAgg = inv?.localProductId != null
        ? warehouseStockMap.get(inv.localProductId)
        : undefined;
      // FBE 平台在途必须与列表「在途库存」列同源，避免明细气泡与主列不一致。
      const fbeInTransitQuantity = Number(inv?.inTransitQuantity ?? 0);
      const effectiveSignals = stockSignalMap.get(p.id)!;
      const fallbackClassification = classifyStoreProduct({
        stock: stockNum,
        inTransitStock: fbeInTransitQuantity,
        firstAvailableAt: effectiveSignals.firstAvailableAt,
        firstStockSignalAt: effectiveSignals.firstStockSignalAt,
        firstInboundAt: effectiveSignals.firstInboundAt,
        syncedAt: p.syncedAt,
        mappedInventorySku: p.mappedInventorySku,
        mainImage: p.mainImage,
        imageUrl: p.imageUrl,
        estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
      }, sales_stats);
      const productClass = fallbackClassification.productClass;
      const newProductStage = fallbackClassification.newProductStage;

      const classificationReason = fallbackClassification.reason;
      const classificationMetrics = fallbackClassification.metrics;
      const classificationName = fallbackClassification.classificationName;
      const riskTags = fallbackClassification.riskTags;
      const stockStatusResult = calculateStockStatus(stockNum, compSales, sales_stats.d30);
      const platformStock = stockNum;
      const platformInTransit = fbeInTransitQuantity;
      const localStock = stockAgg?.localStock ?? 0;
      const purchasingInTransit = inv?.localProductId != null
        ? purchasingInTransitMap.get(inv.localProductId) ?? 0
        : 0;
      const planningStock = planningStockMap.get(normalizeSkuKey(skuKey)) ?? 0;
      const daysSinceSynced = Math.floor((nowMs - p.syncedAt.getTime()) / DAY_MS);
      const lastOrderAt = normalizeNullableDate(sales_stats.lastOrderAt);
      const daysSinceLastOrder = lastOrderAt
        ? Math.max(0, Math.floor((nowMs - lastOrderAt.getTime()) / DAY_MS))
        : null;
      const purchaseSuggestion = buildPurchaseSuggestion({
        productClass,
        newProductStage,
        stockStatus: stockStatusResult.stockStatus,
        platformStock,
        platformInTransit,
        localStock,
        purchasingInTransit,
        planningStock,
        comprehensiveSales: compSales,
        sales7: sales_stats.d7,
        sales14: sales_stats.d14,
        sales30: sales_stats.d30,
        sales60: sales_stats.d60,
        sales90: sales_stats.d90,
        sales180: sales_stats.d180 ?? 0,
        estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
        firstAvailableAt: effectiveSignals.firstAvailableAt,
        firstStockSignalAt: effectiveSignals.firstStockSignalAt,
        firstInboundAt: effectiveSignals.firstInboundAt,
        lastOrderAt,
        daysSinceSynced,
      });
      const estimatedProfit = p.estimatedProfit != null ? Number(p.estimatedProfit) : null;
      const profitMarginPct = p.profitMarginPct ?? null;
      const operationAdvice = buildOperationAdvice({
        productClass,
        stockStatus: stockStatusResult.stockStatus,
        stock: platformStock,
        stockDays: stockStatusResult.stockDays,
        platformInTransit,
        localStock,
        purchasingInTransit,
        planningStock,
        sales7: sales_stats.d7,
        sales14: sales_stats.d14,
        sales30: sales_stats.d30,
        sales60: sales_stats.d60,
        sales90: sales_stats.d90,
        sales180: sales_stats.d180 ?? 0,
        lastOrderAt,
        daysSinceLastOrder,
        comprehensiveSales: compSales,
        replenishReferenceDailySales: purchaseSuggestion.replenishReferenceDailySales,
        targetStock: purchaseSuggestion.targetStock,
        coverageStock: purchaseSuggestion.coverageStock,
        suggestAmount: purchaseSuggestion.suggestAmount,
        replenishmentStage: purchaseSuggestion.replenishmentStage ?? null,
        newProductStage,
        estimatedProfit,
        profitMarginPct,
        price: Number.isFinite(salePriceNum) ? salePriceNum : null,
        daysSinceSynced,
      });
      const productUrl = p.productUrl ?? (() => {
        const domain = (region && REGION_DOMAIN[region as keyof typeof REGION_DOMAIN]) ?? 'emag.ro';
        const name = (p.name ?? '').trim();
        const slug = name
          ? name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 150)
          : 'product';
        return `https://www.${domain}/${slug}/pd/${p.pnk}/`;
      })();
      const linkType = normalizeStoredLinkType(p.emagLinkType);
      const platformBrand = resolveBrandFromOfferMeta(p.emagOfferMeta);
      const linkTypeReason: LinkTypeReason | null = resolveLinkTypeReasonFromOfferMeta(p.emagOfferMeta);
      const ownershipDisplay = normalizeOwnershipDisplay(p.emagOwnership);
      const competition = inferOfferCompetition({ numberOfOffers: p.numberOfOffers });
      const offerCompetitionType = p.offerCompetitionType
        ? normalizeStoredCompetitionType(p.offerCompetitionType)
        : competition.offerCompetitionType;
      const contentPermissionResult = inferContentPermission(linkType);
      const linkActionTips = normalizeActionTips(p.linkActionTips, linkType, offerCompetitionType);
      const storedBuyBoxMeta = p.buyBoxMeta && typeof p.buyBoxMeta === 'object' && !Array.isArray(p.buyBoxMeta)
        ? p.buyBoxMeta as Record<string, unknown>
        : null;
      const inferredBuyBox = inferBuyBoxStatus({
        buyButtonRank: p.buyBoxRank ?? p.buyButtonRank,
        salePrice: salePriceNum,
        bestOfferSalePrice: p.bestOfferSalePrice != null ? Number(p.bestOfferSalePrice) : null,
        mainOfferPrice: p.mainOfferPrice != null ? Number(p.mainOfferPrice) : null,
        stock: stockNum,
        status: p.status,
        offerValidationStatus: storedBuyBoxMeta?.offerValidationStatus ?? p.validationStatus,
        numberOfOffers: p.numberOfOffers,
      });
      const buyBoxStatus = p.buyBoxStatus
        ? normalizeStoredBuyBoxStatus(p.buyBoxStatus)
        : inferredBuyBox.buyBoxStatus;
      const buyBoxStatusSource = p.buyBoxStatusSource
        ? normalizeStoredBuyBoxSource(p.buyBoxStatusSource)
        : inferredBuyBox.buyBoxStatusSource;
      const buyBoxStatusConfidence = p.buyBoxStatusConfidence
        ? normalizeStoredBuyBoxConfidence(p.buyBoxStatusConfidence)
        : inferredBuyBox.buyBoxStatusConfidence;
      const buyBoxRank = p.buyBoxRank ?? inferredBuyBox.buyBoxRank;
      const buyBoxActionTips = normalizeStoredTips(p.buyBoxActionTips, inferredBuyBox.buyBoxActionTips);
      const buyBoxMeta = storedBuyBoxMeta ?? {
        buyButtonRank: p.buyButtonRank ?? null,
        salePrice: salePriceNum,
        bestOfferSalePrice: p.bestOfferSalePrice != null ? Number(p.bestOfferSalePrice) : null,
        mainOfferPrice: p.mainOfferPrice != null ? Number(p.mainOfferPrice) : null,
        stock: stockNum,
        offerValidationStatus: p.validationStatus ?? null,
        numberOfOffers: p.numberOfOffers ?? null,
        checkedAt: p.syncedAt.toISOString(),
      };
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
        in_transit_quantity: fbeInTransitQuantity,
        inTransitQuantity: fbeInTransitQuantity,
        sku_in_transit_quantity: fbeInTransitQuantity,
        skuInTransitQuantity: fbeInTransitQuantity,
        in_transit_scope: 'SKU',
        inTransitScope: 'SKU',
        purchaseSuggestion: {
          ...purchaseSuggestion,
          platformInTransit: fbeInTransitQuantity,
        },
        operation_advice: operationAdvice,
        operationAdvice,
        estimated_profit:     estimatedProfit,
        estimated_profit_cny: p.estimatedProfitCny ? Number(p.estimatedProfitCny) : null,
        profit_margin_pct:    profitMarginPct,
        commission_rate:      p.commissionRate ?? null,
        profit_calculated_at: p.profitCalculatedAt ?? null,
        // ── camelCase 别名（与架构方案文档 & 前端接口契约严格对齐，向前兼容）──
        estimatedProfitLocal: estimatedProfit,
        estimatedProfitCny:   p.estimatedProfitCny ? Number(p.estimatedProfitCny) : null,
        profitMarginPct,
        commissionRate:       p.commissionRate ?? null,
        profitCalculatedAt:   p.profitCalculatedAt ?? null,
        // ── 利润明细拆解（前端可直接渲染，无需重算）──
        profit_breakdown:     p.profitBreakdown ?? null,
        profitBreakdown:      p.profitBreakdown ?? null,
        comprehensive_sales: compSales,   // 实时计算，与 sales_stats 强耦合，永不陈旧
        comprehensiveSales: compSales,
        sales3: sales_stats.d3,
        sales7: sales_stats.d7,
        sales14: sales_stats.d14,
        sales30: sales_stats.d30,
        sales60: sales_stats.d60,
        sales90: sales_stats.d90,
        sales_stats: salesStatsObj,
        salesStats: salesStatsObj,
        product_class: productClass,
        productClass,
        product_class_label: PRODUCT_CLASS_NAMES[productClass],
        productClassLabel: PRODUCT_CLASS_NAMES[productClass],
        new_product_stage: newProductStage,
        newProductStage,
        first_stock_signal_at: effectiveSignals.firstStockSignalAt?.toISOString() ?? null,
        firstStockSignalAt: effectiveSignals.firstStockSignalAt?.toISOString() ?? null,
        first_inbound_at: effectiveSignals.firstInboundAt?.toISOString() ?? null,
        firstInboundAt: effectiveSignals.firstInboundAt?.toISOString() ?? null,
        first_available_at: effectiveSignals.firstAvailableAt?.toISOString() ?? null,
        firstAvailableAt: effectiveSignals.firstAvailableAt?.toISOString() ?? null,
        classification_name: classificationName,
        classificationName,
        classification_reason: classificationReason,
        classificationReason,
        classification_metrics: classificationMetrics,
        classificationMetrics,
        risk_tags: riskTags,
        riskTags,
        linkType,
        link_type: linkType,
        linkTypeLabel: LINK_TYPE_LABELS[linkType],
        link_type_label: LINK_TYPE_LABELS[linkType],
        linkTypeSource: p.emagLinkTypeSource ?? 'UNKNOWN',
        link_type_source: p.emagLinkTypeSource ?? 'UNKNOWN',
        linkTypeConfidence: p.emagLinkTypeConfidence ?? 'LOW',
        link_type_confidence: p.emagLinkTypeConfidence ?? 'LOW',
        linkTypeReason: linkTypeReason,
        link_type_reason: linkTypeReason,
        brand: platformBrand,
        platform_brand: platformBrand,
        ownership: ownershipDisplay,
        contentPermission: p.contentPermission ?? contentPermissionResult.contentPermission,
        contentPermissionLabel: contentPermissionResult.contentPermissionLabel,
        numberOfOffers: p.numberOfOffers ?? competition.numberOfOffers,
        offerCompetitionType,
        offerCompetitionLabel: OFFER_COMPETITION_LABELS[offerCompetitionType],
        buyButtonRank: p.buyButtonRank ?? null,
        bestOfferSalePrice: p.bestOfferSalePrice != null ? Number(p.bestOfferSalePrice) : null,
        mainOfferPrice: p.mainOfferPrice != null ? Number(p.mainOfferPrice) : null,
        linkActionTips,
        buyBoxStatus,
        buy_box_status: buyBoxStatus,
        buyBoxStatusLabel: BUY_BOX_STATUS_LABELS[buyBoxStatus],
        buy_box_status_label: BUY_BOX_STATUS_LABELS[buyBoxStatus],
        buyBoxStatusSource,
        buy_box_status_source: buyBoxStatusSource,
        buyBoxStatusConfidence,
        buy_box_status_confidence: buyBoxStatusConfidence,
        buyBoxRank,
        buy_box_rank: buyBoxRank,
        buyBoxActionTips,
        buy_box_action_tips: buyBoxActionTips,
        buyBoxMeta,
        buy_box_meta: buyBoxMeta,
        stock_status: stockStatusResult.stockStatus,
        stockStatus: stockStatusResult.stockStatus,
        stock_days: stockStatusResult.stockDays,
        stockDays: stockStatusResult.stockDays,
        reference_daily_sales: stockStatusResult.referenceDailySales,
        referenceDailySales: stockStatusResult.referenceDailySales,
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

/**
 * POST /api/store-products/recalc-profit
 * 手动触发利润重算（可指定 shopId，不传则全店铺）
 */
router.post('/recalc-profit', async (req: Request, res: Response) => {
  try {
    const rawShopId = req.body?.shopId ?? req.query?.shopId;
    if (rawShopId != null) {
      const shopId = Number(rawShopId);
      if (isNaN(shopId) || shopId <= 0) {
        res.status(400).json({ code: 400, data: null, message: 'shopId 无效' });
        return;
      }
      const updated = await recalcProfitForShop(shopId);
      res.json({ code: 200, data: { updated, shopId }, message: `已重算 ${updated} 条产品利润` });
    } else {
      const result = await recalcProfitForAllShops();
      res.json({ code: 200, data: result, message: `全量重算完成：${result.shopCount} 家店铺，${result.totalUpdated} 条` });
    }
  } catch (err: any) {
    console.error('[POST /api/store-products/recalc-profit]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '利润重算失败' });
  }
});

/**
 * PATCH /api/store-products/:pnk/cost-correction
 * 成本纠偏接口：允许用户手动修正 commissionRate（店铺级）/ fbeFee / returnLossRate（产品级），
 * 并同步触发利润重算，返回最新的 profitBreakdown。
 *
 * Body（均可选，至少传一项）：
 *   commissionRate  number   0~1，佣金率（写入 StoreProduct）
 *   fbeFee          number   >=0，FBE 费用 CNY（写入 Product）
 *   returnLossRate  number   0~1，退货损耗率（写入 Product）
 *   shopId          number   可选；指定则只更新该店 commissionRate；否则全 PNK 店铺同步更新
 */
router.patch('/:pnk/cost-correction', async (req: Request, res: Response) => {
  try {
    const pnk = String(req.params.pnk ?? '').trim();
    if (!pnk) {
      res.status(400).json({ code: 400, data: null, message: 'pnk 不能为空' });
      return;
    }

    const body = req.body ?? {};
    const { commissionRate, fbeFee, returnLossRate } = body;
    const shopId: number | undefined = body.shopId != null ? Number(body.shopId) : undefined;

    // ── 入参边界校验 ──────────────────────────────────────────────
    if (commissionRate === undefined && fbeFee === undefined && returnLossRate === undefined) {
      res.status(400).json({ code: 400, data: null, message: '至少提供一个要修改的字段（commissionRate / fbeFee / returnLossRate）' });
      return;
    }
    if (commissionRate !== undefined) {
      const v = Number(commissionRate);
      if (isNaN(v) || v < 0 || v > 1) {
        res.status(400).json({ code: 400, data: null, message: 'commissionRate 必须在 0~1 之间（如 0.15 表示 15%）' });
        return;
      }
    }
    if (fbeFee !== undefined) {
      const v = Number(fbeFee);
      if (isNaN(v) || v < 0) {
        res.status(400).json({ code: 400, data: null, message: 'fbeFee 不能为负数' });
        return;
      }
    }
    if (returnLossRate !== undefined) {
      const v = Number(returnLossRate);
      if (isNaN(v) || v < 0 || v > 1) {
        res.status(400).json({ code: 400, data: null, message: 'returnLossRate 必须在 0~1 之间（如 0.03 表示 3%）' });
        return;
      }
    }
    if (shopId !== undefined && (isNaN(shopId) || shopId <= 0)) {
      res.status(400).json({ code: 400, data: null, message: 'shopId 无效' });
      return;
    }

    // ── Step 2：查找关联的 StoreProduct（获取 shopId 列表 + mappedInventorySku）
    const storeProducts = await prisma.storeProduct.findMany({
      where: { pnk, isArchived: false, ...(shopId ? { shopId } : {}) },
      select: { id: true, shopId: true, mappedInventorySku: true },
    });

    if (storeProducts.length === 0) {
      res.status(404).json({ code: 404, data: null, message: `未找到 PNK "${pnk}" 的平台产品，请先同步产品数据` });
      return;
    }

    // ── Step 3a：更新 store_products.commission_rate（店铺级）──────
    if (commissionRate !== undefined) {
      await prisma.storeProduct.updateMany({
        where: { pnk, isArchived: false, ...(shopId ? { shopId } : {}) },
        data: { commissionRate: Number(commissionRate) },
      });
    }

    // ── Step 3b：更新 products.fbe_fee / return_loss_rate（产品级）─
    // 找第一个有 mappedInventorySku 的记录作为 Product 的查找键
    const effectiveSku = storeProducts.find((sp) => sp.mappedInventorySku)?.mappedInventorySku ?? null;
    let updatedProduct = false;
    const warning: string[] = [];

    if (fbeFee !== undefined || returnLossRate !== undefined) {
      if (effectiveSku) {
        const productData: Record<string, unknown> = {};
        if (fbeFee        !== undefined) productData.fbeFee        = Number(fbeFee);
        if (returnLossRate !== undefined) productData.returnLossRate = Number(returnLossRate);
        await prisma.product.update({
          where: { sku: effectiveSku },
          data: productData,
        });
        updatedProduct = true;
      } else {
        warning.push('该 PNK 未绑定本地库存 SKU，fbeFee / returnLossRate 未能保存，请先在"平台产品"页绑定库存 SKU');
      }
    }

    // ── Step 4：同步触发利润重算（用户主动纠偏，同步等待保证返回最新数据）──
    const shopIdsToRecalc = [...new Set(storeProducts.map((sp) => sp.shopId))];
    for (const sid of shopIdsToRecalc) {
      await recalcProfitForShop(sid);
    }

    // ── Step 5：读取最新 breakdown 返回给前端 ──────────────────────
    const refreshed = await prisma.storeProduct.findFirst({
      where: { pnk, isArchived: false, ...(shopId ? { shopId } : {}) },
      select: {
        estimatedProfit:    true,
        estimatedProfitCny: true,
        profitMarginPct:    true,
        commissionRate:     true,
        profitBreakdown:    true,
        profitCalculatedAt: true,
      },
    });

    res.json({
      code: 200,
      data: {
        pnk,
        shopId:                shopId ?? null,
        updatedStoreProducts:  storeProducts.length,
        updatedProduct,
        profitRecalcTriggered: true,
        estimatedProfit:       refreshed?.estimatedProfit    ? Number(refreshed.estimatedProfit)    : null,
        estimatedProfitCny:    refreshed?.estimatedProfitCny ? Number(refreshed.estimatedProfitCny) : null,
        profitMarginPct:       refreshed?.profitMarginPct    ?? null,
        commissionRate:        refreshed?.commissionRate      ?? null,
        profitCalculatedAt:    refreshed?.profitCalculatedAt  ?? null,
        profitBreakdown:       refreshed?.profitBreakdown     ?? null,
        warning:               warning.length > 0 ? warning.join('；') : undefined,
      },
      message: warning.length > 0
        ? `成本纠偏完成，利润已重算（注意：${warning[0]}）`
        : '成本纠偏完成，利润已重算',
    });
  } catch (err: any) {
    console.error('[PATCH /api/store-products/:pnk/cost-correction]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '服务器内部错误' });
  }
});

/**
 * POST /api/store-products/sync-exchange-rates
 * 手动触发汇率同步（测试用，正常由 Cron 每天自动执行）
 */
router.post('/sync-exchange-rates', async (_req: Request, res: Response) => {
  try {
    const result = await syncExchangeRates();
    res.json({ code: 200, data: result, message: `汇率同步完成：${result.updated} 条已更新` });
  } catch (err: any) {
    console.error('[POST /api/store-products/sync-exchange-rates]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '汇率同步失败' });
  }
});

export default router;
