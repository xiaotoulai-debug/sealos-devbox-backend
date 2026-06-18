/**
 * 利润预计算引擎 — 异步批量计算 StoreProduct 的预估毛利并写入缓存字段。
 *
 * 公式（v3，含退货损耗）：
 *   预估毛利(当地) = 售价 - 佣金(售价×佣金率) - FBE费 - 头程(CNY→当地) - 采购成本(CNY→当地)
 *                   - 退货损耗(采购成本 × returnLossRate → 当地)
 *   预估毛利(CNY) = 预估毛利(当地) × 汇率(当地→CNY)
 *
 * 触发时机：
 *   - 汇率每日更新后自动级联
 *   - 产品雷达同步后按 shopId 增量重算
 *   - 成本/规格变更后按 SKU 反查重算
 *   - 手动 POST /api/store-products/recalc-profit
 */

import { prisma } from '../lib/prisma';
import { loadExchangeRateMap } from './exchangeRateSync';
import { calcHeadFreightCny } from './freightCalculator';
import { guessCommissionRate } from '../utils/commissionMatcher';
import { DEFAULT_COMMISSION_RATE } from '../config/commissionMap';
import { DEFAULT_FBE_CNY } from './priceProtection';

/**
 * FBE 冷启动兜底（CNY）：当 Product.fbeFee 为 null 时，以此 CNY 金额换算为当地货币兜底。
 * 严禁按 0 扣减——0 会严重高估毛利，误导业务决策。
 * 业务基准：eMAG FBE 仓储费市场均值约 7 CNY（≈ 5 RON / ≈ 1 EUR / ≈ 2 000 HUF），后续
 * 录入真实 fbeFee 后此兜底自动失效。
 */
/** 四舍五入至两位小数 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 批量写入时的分块大小与间隔（防连接池打满） */
const WRITE_CHUNK_SIZE  = 50;
const WRITE_CHUNK_DELAY = 80; // ms

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type StoreProductProfitRow = {
  id: number;
  shopId: number;
  salePrice: unknown;
  currency: string | null;
  commissionRate: number | null;
  mappedInventorySku: string | null;
  pnk: string;
  name: string;
};

type LocalProductRow = {
  sku: string | null;
  pnk: string | null;
  purchasePrice: unknown;
  fbeFee: unknown;
  length: unknown;
  width: unknown;
  height: unknown;
  actualWeight: unknown;
  category: string | null;
  returnLossRate: number | null;
};

type PendingProfitUpdate = {
  id: number;
  estimatedProfit: number;
  estimatedProfitCny: number | null;
  profitMarginPct: number | null;
  profitCalculatedAt: Date;
  profitBreakdown: object;
};

export type TargetedProfitRecalcItemResult = {
  storeProductId: number;
  shopId: number | null;
  sku: string | null;
  oldEstimatedProfit: number | null;
  newEstimatedProfit: number | null;
  oldProfitMarginPct: number | null;
  newProfitMarginPct: number | null;
  oldProfitBreakdown: unknown;
  newProfitBreakdown: unknown;
  status: 'PLANNED' | 'UPDATED' | 'SKIPPED' | 'FAILED';
  message?: string;
};

export type TargetedProfitRecalcResult = {
  dryRun: boolean;
  mode: 'STORE_PRODUCT_IDS';
  totalScanned: number;
  planned: number;
  updated: number;
  skipped: number;
  failed: number;
  items: TargetedProfitRecalcItemResult[];
};

async function buildInheritedSkuMap(products: Array<{ pnk: string; shopId: number; mappedInventorySku: string | null }>): Promise<Map<string, string>> {
  const unmappedPnks = [...new Set(
    products.filter((p) => !p.mappedInventorySku && p.pnk).map((p) => p.pnk),
  )];
  if (unmappedPnks.length === 0) return new Map();

  const inheritedRows = await prisma.storeProduct.findMany({
    where: {
      pnk: { in: unmappedPnks },
      isArchived: false,
      mappedInventorySku: { not: null },
    },
    select: { pnk: true, mappedInventorySku: true, shopId: true },
  });

  const requestingShopByPnk = new Map<string, Set<number>>();
  for (const product of products) {
    if (!product.mappedInventorySku && product.pnk) {
      const shops = requestingShopByPnk.get(product.pnk) ?? new Set<number>();
      shops.add(product.shopId);
      requestingShopByPnk.set(product.pnk, shops);
    }
  }

  const inheritedSkuMap = new Map<string, string>();
  for (const row of inheritedRows) {
    if (!row.pnk || !row.mappedInventorySku || inheritedSkuMap.has(row.pnk)) continue;
    const requestingShops = requestingShopByPnk.get(row.pnk);
    if (requestingShops?.has(row.shopId)) continue;
    inheritedSkuMap.set(row.pnk, row.mappedInventorySku);
  }
  return inheritedSkuMap;
}

function computePendingProfitUpdates(params: {
  products: StoreProductProfitRow[];
  inheritedSkuMap: Map<string, string>;
  skuMap: Map<string, LocalProductRow>;
  pnkMap: Map<string, LocalProductRow>;
  rateMap: Map<string, number>;
}): PendingProfitUpdate[] {
  const now = new Date();
  const pending: PendingProfitUpdate[] = [];

  for (const sp of params.products) {
    const salePrice = Number(sp.salePrice);
    if (salePrice <= 0) continue;

    const currency = sp.currency ?? 'RON';
    const effectiveSku = sp.mappedInventorySku ?? params.inheritedSkuMap.get(sp.pnk);
    const local = (effectiveSku ? params.skuMap.get(effectiveSku) : undefined)
      ?? params.pnkMap.get(sp.pnk);

    if (!local?.purchasePrice) continue;

    let commissionRateSource: 'exact' | 'dictionary' | 'default';
    let commRate: number;
    if (sp.commissionRate != null) {
      commRate = sp.commissionRate;
      commissionRateSource = 'exact';
    } else {
      const guessed = guessCommissionRate(sp.name, local.category ?? null);
      if (guessed != null) {
        commRate = guessed;
        commissionRateSource = 'dictionary';
      } else {
        commRate = DEFAULT_COMMISSION_RATE;
        commissionRateSource = 'default';
      }
    }
    const isEstimatedCommission = commissionRateSource !== 'exact';

    const cnyToLocal = params.rateMap.get(`CNY→${currency}`);
    if (!cnyToLocal) continue;

    const localToCny = params.rateMap.get(`${currency}→CNY`);
    const purchasePriceCny = Number(local.purchasePrice);
    const purchaseCostLocal = purchasePriceCny * cnyToLocal;

    const headFreightCny = calcHeadFreightCny(
      local.length ? Number(local.length) : null,
      local.width ? Number(local.width) : null,
      local.height ? Number(local.height) : null,
      local.actualWeight ? Number(local.actualWeight) : null,
    );
    const isMissingVolumeWeight = headFreightCny === null;
    const headFreightLocal = (headFreightCny ?? 0) * cnyToLocal;

    const isEstimatedFbe = local.fbeFee == null;
    const fbeFeeCny = local.fbeFee != null ? Number(local.fbeFee) : DEFAULT_FBE_CNY;
    const fbeLocal = fbeFeeCny * cnyToLocal;

    const returnLossRate = local.returnLossRate ?? 0;
    const returnLossCny = purchasePriceCny * returnLossRate;
    const returnLossLocal = returnLossCny * cnyToLocal;
    const commission = salePrice * commRate;
    const profitLocal = salePrice - commission - fbeLocal - headFreightLocal
      - purchaseCostLocal - returnLossLocal;
    const profitCny = localToCny != null ? profitLocal * localToCny : null;
    const marginPct = salePrice > 0 ? (profitLocal / salePrice) * 100 : null;

    const warnings = [
      ...(isEstimatedFbe ? [`FBE 费用使用 ${DEFAULT_FBE_CNY} RMB 默认估算`] : []),
      ...(isEstimatedCommission ? ['佣金率来自字典或默认配置'] : []),
      ...(isMissingVolumeWeight ? ['缺少尺寸或重量，头程成本按 0 估算'] : []),
    ];

    pending.push({
      id: sp.id,
      estimatedProfit: round2(profitLocal),
      estimatedProfitCny: profitCny != null ? round2(profitCny) : null,
      profitMarginPct: marginPct != null ? round2(marginPct) : null,
      profitCalculatedAt: now,
      profitBreakdown: {
        salePrice: round2(salePrice),
        currency,
        commissionRate: commRate,
        commissionRateSource,
        isEstimatedCommission,
        commission: round2(commission),
        fbe: round2(fbeLocal),
        fbeLocal: round2(fbeLocal),
        fbeFeeCny: round2(fbeFeeCny),
        isEstimatedFbe,
        isMissingVolumeWeight,
        warnings,
        headFreightCny: round2(headFreightCny ?? 0),
        headFreightLocal: round2(headFreightLocal),
        purchaseCostCny: round2(purchasePriceCny),
        purchaseCostLocal: round2(purchaseCostLocal),
        returnLossRate,
        returnLossCny: round2(returnLossCny),
        returnLossLocal: round2(returnLossLocal),
        exchangeRateCnyToLocal: cnyToLocal,
        exchangeRateLocalToCny: localToCny ?? null,
        profitLocal: round2(profitLocal),
        profitCny: profitCny != null ? round2(profitCny) : null,
        profitMarginPct: marginPct != null ? round2(marginPct) : null,
      },
    });
  }

  return pending;
}

async function writePendingProfitUpdates(pending: PendingProfitUpdate[]): Promise<number> {
  let updated = 0;
  for (let i = 0; i < pending.length; i += WRITE_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + WRITE_CHUNK_SIZE);
    try {
      await prisma.$transaction(
        chunk.map((u) =>
          prisma.storeProduct.update({
            where: { id: u.id },
            data: {
              estimatedProfit: u.estimatedProfit,
              estimatedProfitCny: u.estimatedProfitCny,
              profitMarginPct: u.profitMarginPct,
              profitCalculatedAt: u.profitCalculatedAt,
              profitBreakdown: u.profitBreakdown,
            },
          }),
        ),
      );
      updated += chunk.length;
    } catch (err: any) {
      console.error(`[ProfitCalc] chunk[${i}~${i + chunk.length - 1}] 写入失败:`, err.message ?? err);
    }
    if (i + WRITE_CHUNK_SIZE < pending.length) await sleep(WRITE_CHUNK_DELAY);
  }
  return updated;
}

/**
 * 为指定店铺的全部 StoreProduct 重算利润并写入缓存字段。
 * @returns 更新条数
 */
export async function recalcProfitForShop(shopId: number): Promise<number> {
  const products = await prisma.storeProduct.findMany({
    where: { shopId, isArchived: false },
    select: {
      id: true, shopId: true, salePrice: true, currency: true,
      commissionRate: true, mappedInventorySku: true, pnk: true,
      name: true,   // 用于 commissionMatcher 关键词匹配
    },
  });

  if (products.length === 0) return 0;

  // ── 本店已有 mappedInventorySku 的 SKU 列表 ────────────────────────
  const ownSkus = products
    .map((p) => p.mappedInventorySku)
    .filter((s): s is string => !!s);

  const pnks = products.map((p) => p.pnk).filter(Boolean) as string[];

  // ── Phase 2 Scheme A：跨店 SKU 继承 ──────────────────────────────────
  // 本店无 mappedInventorySku 的产品，从全平台其它店铺中找同 PNK 已有绑定的记录
  const unmappedPnks = products
    .filter((p) => !p.mappedInventorySku && p.pnk)
    .map((p) => p.pnk!)
    .filter(Boolean);

  const inheritedRows = unmappedPnks.length > 0
    ? await prisma.storeProduct.findMany({
        where: {
          pnk:               { in: unmappedPnks },
          isArchived:        false,
          mappedInventorySku: { not: null },
          shopId:            { not: shopId },  // 排除本店自身
        },
        select: { pnk: true, mappedInventorySku: true },
        distinct: ['pnk'],
      })
    : [];

  // pnk → 继承到的 mappedInventorySku（单次查询，Map 缓存，零 N+1）
  const inheritedSkuMap = new Map<string, string>();
  for (const row of inheritedRows) {
    if (row.pnk && row.mappedInventorySku && !inheritedSkuMap.has(row.pnk)) {
      inheritedSkuMap.set(row.pnk, row.mappedInventorySku);
    }
  }
  if (inheritedRows.length > 0) {
    console.log(`[ProfitCalc] shopId=${shopId} 跨店继承命中 ${inheritedRows.length} 条 PNK 映射`);
  }

  // 合并本店 SKU + 继承 SKU，一次性批量查 Product 表
  const inheritedSkus = [...inheritedSkuMap.values()].filter((s) => !ownSkus.includes(s));
  const allSkus = [...new Set([...ownSkus, ...inheritedSkus])];

  // ── 批量加载本地 Product（采购价、FBE 费、尺寸/重量）─────────────────
  const [skuProducts, pnkProducts] = await Promise.all([
    allSkus.length > 0
      ? prisma.product.findMany({
          where: { sku: { in: allSkus } },
          select: {
            sku: true, pnk: true, purchasePrice: true, fbeFee: true,
            length: true, width: true, height: true, actualWeight: true,
            category: true,         // 用于 commissionMatcher 类目关键词匹配
            returnLossRate: true,   // 退货损耗率（0.03 = 3%）
          },
        })
      : [],
    pnks.length > 0
      ? prisma.product.findMany({
          where: { pnk: { in: pnks } },
          select: {
            sku: true, pnk: true, purchasePrice: true, fbeFee: true,
            length: true, width: true, height: true, actualWeight: true,
            category: true,
            returnLossRate: true,
          },
        })
      : [],
  ]);

  type LocalProduct = (typeof skuProducts)[number];
  const skuMap = new Map<string, LocalProduct>();
  const pnkMap = new Map<string, LocalProduct>();
  for (const lp of skuProducts) if (lp.sku) skuMap.set(lp.sku, lp);
  for (const lp of pnkProducts) if (lp.pnk) pnkMap.set(lp.pnk, lp);

  const rateMap = await loadExchangeRateMap();
  const pending = computePendingProfitUpdates({
    products,
    inheritedSkuMap,
    skuMap,
    pnkMap,
    rateMap,
  });

  return writePendingProfitUpdates(pending);
}

/**
 * 全店铺批量重算。在汇率更新后由 Cron 级联调用。
 */
export async function recalcProfitForAllShops(): Promise<{ totalUpdated: number; shopCount: number }> {
  console.log('[ProfitCalc] 全量重算开始...');
  const start = Date.now();

  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true, shopName: true },
  });

  let totalUpdated = 0;
  for (const shop of shops) {
    try {
      const count = await recalcProfitForShop(shop.id);
      totalUpdated += count;
      if (count > 0) {
        console.log(`[ProfitCalc] ${shop.shopName} (id=${shop.id}): ${count} 条已更新`);
      }
    } catch (err: any) {
      console.error(`[ProfitCalc] ${shop.shopName} 重算失败:`, err.message ?? err);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[ProfitCalc] 全量重算完成：${shops.length} 家店铺，${totalUpdated} 条产品，耗时 ${elapsed}ms`);
  return { totalUpdated, shopCount: shops.length };
}

/**
 * 按 SKU 列表反查 StoreProduct 并重算利润。
 * 用于 inventory-batch-update 修改采购价/规格后的增量触发。
 */
export async function recalcProfitBySkus(skus: string[]): Promise<number> {
  if (skus.length === 0) return 0;

  // 找出所有映射了这些 SKU 的 StoreProduct 所在的 shopId
  const affected = await prisma.storeProduct.findMany({
    where: { mappedInventorySku: { in: skus }, isArchived: false },
    select: { shopId: true },
    distinct: ['shopId'],
  });

  let totalUpdated = 0;
  for (const { shopId } of affected) {
    totalUpdated += await recalcProfitForShop(shopId);
  }
  return totalUpdated;
}

/**
 * 按 StoreProduct ID 列表重算利润，避免一次改价触发全店重算。
 */
export async function recalcProfitForStoreProducts(storeProductIds: number[]): Promise<number> {
  const result = await recalcProfitForStoreProductsDetailed({ storeProductIds, dryRun: false });
  return result.updated;
}

const TARGETED_PROFIT_RECALC_MAX_IDS = 100;

function normalizeStoreProductIds(ids: number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

export async function recalcProfitForStoreProductsDetailed(params: {
  storeProductIds: number[];
  dryRun?: boolean;
}): Promise<TargetedProfitRecalcResult> {
  const dryRun = params.dryRun !== false;
  const uniqueIds = normalizeStoreProductIds(params.storeProductIds);
  if (uniqueIds.length === 0) throw new Error('storeProductIds 不能为空');
  if (uniqueIds.length > TARGETED_PROFIT_RECALC_MAX_IDS) {
    throw new Error(`storeProductIds 一次最多 ${TARGETED_PROFIT_RECALC_MAX_IDS} 个`);
  }

  const allRows = await prisma.storeProduct.findMany({
    where: { id: { in: uniqueIds } },
    select: {
      id: true,
      shopId: true,
      sku: true,
      salePrice: true,
      currency: true,
      commissionRate: true,
      mappedInventorySku: true,
      pnk: true,
      name: true,
      isArchived: true,
      estimatedProfit: true,
      profitMarginPct: true,
      profitBreakdown: true,
    },
    orderBy: { id: 'asc' },
  });

  const rowById = new Map(allRows.map((row) => [row.id, row]));
  const result: TargetedProfitRecalcResult = {
    dryRun,
    mode: 'STORE_PRODUCT_IDS',
    totalScanned: uniqueIds.length,
    planned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  for (const id of uniqueIds) {
    if (!rowById.has(id)) {
      result.failed++;
      result.items.push({
        storeProductId: id,
        shopId: null,
        sku: null,
        oldEstimatedProfit: null,
        newEstimatedProfit: null,
        oldProfitMarginPct: null,
        newProfitMarginPct: null,
        oldProfitBreakdown: null,
        newProfitBreakdown: null,
        status: 'FAILED',
        message: 'STORE_PRODUCT_NOT_FOUND',
      });
    }
  }

  const archivedRows = allRows.filter((row) => row.isArchived);
  for (const row of archivedRows) {
    result.skipped++;
    result.items.push({
      storeProductId: row.id,
      shopId: row.shopId,
      sku: row.sku,
      oldEstimatedProfit: row.estimatedProfit != null ? Number(row.estimatedProfit) : null,
      newEstimatedProfit: null,
      oldProfitMarginPct: row.profitMarginPct ?? null,
      newProfitMarginPct: null,
      oldProfitBreakdown: row.profitBreakdown ?? null,
      newProfitBreakdown: null,
      status: 'SKIPPED',
      message: 'StoreProduct 已归档',
    });
  }

  const activeRows = allRows.filter((row) => !row.isArchived);
  if (activeRows.length === 0) {
    result.items.sort((a, b) => a.storeProductId - b.storeProductId);
    return result;
  }

  const products: StoreProductProfitRow[] = activeRows.map((row) => ({
    id: row.id,
    shopId: row.shopId,
    salePrice: row.salePrice,
    currency: row.currency,
    commissionRate: row.commissionRate,
    mappedInventorySku: row.mappedInventorySku,
    pnk: row.pnk,
    name: row.name,
  }));

  const ownSkus = products
    .map((p) => p.mappedInventorySku)
    .filter((s): s is string => !!s);
  const pnks = products.map((p) => p.pnk).filter(Boolean) as string[];
  const inheritedSkuMap = await buildInheritedSkuMap(products);
  const inheritedSkus = [...inheritedSkuMap.values()].filter((s) => !ownSkus.includes(s));
  const allSkus = [...new Set([...ownSkus, ...inheritedSkus])];

  const [skuProducts, pnkProducts] = await Promise.all([
    allSkus.length > 0
      ? prisma.product.findMany({
          where: { sku: { in: allSkus } },
          select: {
            sku: true, pnk: true, purchasePrice: true, fbeFee: true,
            length: true, width: true, height: true, actualWeight: true,
            category: true, returnLossRate: true,
          },
        })
      : [],
    pnks.length > 0
      ? prisma.product.findMany({
          where: { pnk: { in: pnks } },
          select: {
            sku: true, pnk: true, purchasePrice: true, fbeFee: true,
            length: true, width: true, height: true, actualWeight: true,
            category: true, returnLossRate: true,
          },
        })
      : [],
  ]);

  const skuMap = new Map<string, LocalProductRow>();
  const pnkMap = new Map<string, LocalProductRow>();
  for (const lp of skuProducts) if (lp.sku) skuMap.set(lp.sku, lp);
  for (const lp of pnkProducts) if (lp.pnk) pnkMap.set(lp.pnk, lp);

  const rateMap = await loadExchangeRateMap();
  const pending = computePendingProfitUpdates({
    products,
    inheritedSkuMap,
    skuMap,
    pnkMap,
    rateMap,
  });

  const pendingById = new Map(pending.map((item) => [item.id, item]));
  for (const row of activeRows) {
    const update = pendingById.get(row.id);
    if (!update) {
      result.skipped++;
      result.items.push({
        storeProductId: row.id,
        shopId: row.shopId,
        sku: row.sku,
        oldEstimatedProfit: row.estimatedProfit != null ? Number(row.estimatedProfit) : null,
        newEstimatedProfit: null,
        oldProfitMarginPct: row.profitMarginPct ?? null,
        newProfitMarginPct: null,
        oldProfitBreakdown: row.profitBreakdown ?? null,
        newProfitBreakdown: null,
        status: 'SKIPPED',
        message: '利润计算条件不足（可能缺 salePrice、purchasePrice、汇率或 Product 映射）',
      });
      continue;
    }

    if (dryRun) {
      result.planned++;
      result.items.push({
        storeProductId: row.id,
        shopId: row.shopId,
        sku: row.sku,
        oldEstimatedProfit: row.estimatedProfit != null ? Number(row.estimatedProfit) : null,
        newEstimatedProfit: update.estimatedProfit,
        oldProfitMarginPct: row.profitMarginPct ?? null,
        newProfitMarginPct: update.profitMarginPct,
        oldProfitBreakdown: row.profitBreakdown ?? null,
        newProfitBreakdown: update.profitBreakdown,
        status: 'PLANNED',
      });
    }
  }

  if (!dryRun && pending.length > 0) {
    const updatedCount = await writePendingProfitUpdates(pending);
    result.updated = updatedCount;
    for (const row of activeRows) {
      const update = pendingById.get(row.id);
      if (!update) continue;
      result.items.push({
        storeProductId: row.id,
        shopId: row.shopId,
        sku: row.sku,
        oldEstimatedProfit: row.estimatedProfit != null ? Number(row.estimatedProfit) : null,
        newEstimatedProfit: update.estimatedProfit,
        oldProfitMarginPct: row.profitMarginPct ?? null,
        newProfitMarginPct: update.profitMarginPct,
        oldProfitBreakdown: row.profitBreakdown ?? null,
        newProfitBreakdown: update.profitBreakdown,
        status: 'UPDATED',
      });
    }
  }

  result.items.sort((a, b) => a.storeProductId - b.storeProductId);
  return result;
}
