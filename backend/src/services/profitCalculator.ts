/**
 * 利润预计算引擎 v4 — 异步批量计算 StoreProduct 的预估毛利并写入缓存字段。
 *
 * 公式（v4，含退货损耗、FBE 可信来源、佣金来源枚举）：
 *   预估毛利(当地) = 售价 - 佣金(售价×佣金率) - FBE费 - 头程(CNY→当地) - 采购成本(CNY→当地)
 *                   - 退货损耗(采购成本 × returnLossRate → 当地)
 *   预估毛利(CNY) = 预估毛利(当地) × 汇率(当地→CNY)
 *
 * 规则（v4 新增）：
 *   - 每次评估都写入结果，不允许 continue 跳过（保留旧利润）
 *   - 利润无法计算时：estimatedProfit/estimatedProfitCny/profitMarginPct = null
 *   - profitBreakdown 必须写入，含 profitCalculationStatus 枚举
 *   - profitCalculatedAt = 最近一次评估尝试时间（非"成功时间"）
 *   - FBE：StoreProduct 可信来源 > DEFAULT_CNY_7；Product.fbeFee 历史值仅诊断
 *   - 佣金来源：LEGACY_DICTIONARY / RUNTIME_DICTIONARY / DEFAULT_FALLBACK
 *
 * 触发时机：
 *   - 汇率每日更新后自动级联
 *   - 产品雷达同步后按 shopId 增量重算
 *   - 手动产品同步完成后按 shopId 重算
 *   - SKU 绑定/解绑后按 shopId 重算
 *   - 成本/规格变更后按 SKU 反查重算
 *   - 手动 POST /api/store-products/recalc-profit
 */

import { prisma } from '../lib/prisma';
import { loadExchangeRateMap } from './exchangeRateSync';
import { calcHeadFreightCny } from './freightCalculator';
import { guessCommissionRate } from '../utils/commissionMatcher';
import { DEFAULT_COMMISSION_RATE } from '../config/commissionMap';

/**
 * FBE 冷启动兜底（CNY）：当 StoreProduct 无可信 FBE 时，以此 CNY 金额换算兜底。
 * 严禁按 0 扣减——0 会严重高估毛利，误导业务决策。
 * 业务基准：eMAG FBE 仓储费市场均值约 7 CNY（≈ 5 RON / ≈ 1 EUR / ≈ 2 000 HUF）
 */
export const DEFAULT_FBE_CNY = 7;

/** 可信 FBE 来源枚举（仅这两个来源可参与利润扣减） */
const TRUSTED_FBE_SOURCES = new Set(['MANUAL_STORE_PRODUCT', 'FBE_SIMULATOR_ESTIMATE']);

/** 佣金来源枚举 */
export type CommissionSource =
  | 'LEGACY_DICTIONARY'   // 已在 DB 存储，历史批量写入，来源为字典
  | 'RUNTIME_DICTIONARY'  // 本次由 commissionMatcher 字典匹配
  | 'DEFAULT_FALLBACK'    // 字典未命中，使用默认兜底率
  | 'EMAG_API_ESTIMATE';  // 预留，Migration B 接入后使用

/** 利润评估状态枚举 */
export type ProfitCalculationStatus =
  | 'READY'
  | 'MISSING_LOCAL_PRODUCT'
  | 'MISSING_PURCHASE_COST'
  | 'MISSING_EXCHANGE_RATE'
  | 'INVALID_SALE_PRICE';

/** 四舍五入至两位小数 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 批量写入时的分块大小与间隔（防连接池打满） */
const WRITE_CHUNK_SIZE  = 50;
const WRITE_CHUNK_DELAY = 80; // ms

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────────────────
// 纯利润计算函数（无 DB 依赖，可被 audit-profit.ts 直接复用）
// ────────────────────────────────────────────────────────────────────────────

export interface StoreProductInput {
  id: number;
  salePrice: number;
  currency: string;
  pnk: string;
  name: string;
  mappedInventorySku: string | null;
  // DB 存储的佣金字段
  commissionRate: number | null;
  commissionRateSource: string | null;
  // StoreProduct FBE 字段（可信来源）
  fbeFee: number | null;
  fbeCurrency: string | null;
  fbeSource: string | null;
  // 人工 FBE 纠偏（CNY，StoreProduct 层）
  fbeFeeOverrideCny: number | null;
  fbeFeeOverrideSource: string | null;
  fbeFeeOverrideUpdatedAt: Date | null;
}

export interface LocalProductInput {
  sku: string | null;
  pnk: string | null;
  purchasePrice: number | null;
  fbeFee: number | null;         // 历史值，仅诊断用
  length: number | null;
  width: number | null;
  height: number | null;
  actualWeight: number | null;
  category: string | null;
  returnLossRate: number;
}

export interface ProfitCalculationResult {
  status: ProfitCalculationStatus;
  estimatedProfit: number | null;
  estimatedProfitCny: number | null;
  profitMarginPct: number | null;
  breakdown: Record<string, unknown>;
}

/**
 * 纯利润计算函数。无任何 DB/IO 操作，可被 profitCalculator 和 audit-profit 共同复用。
 *
 * @param sp          StoreProduct 数据（仅计算相关字段）
 * @param local       本地 Product 数据，找不到时传 null
 * @param rateMap     ExchangeRate Map（key: "CNY→RON" 格式）
 */
export function calcProfitForProduct(
  sp: StoreProductInput,
  local: LocalProductInput | null,
  rateMap: Map<string, number>,
): ProfitCalculationResult {
  const now = new Date().toISOString();

  // ── 无效售价 ──────────────────────────────────────────────────────────
  if (sp.salePrice <= 0) {
    return {
      status: 'INVALID_SALE_PRICE',
      estimatedProfit: null,
      estimatedProfitCny: null,
      profitMarginPct: null,
      breakdown: {
        profitCalculationStatus: 'INVALID_SALE_PRICE',
        reason:    `售价 ${sp.salePrice} ≤ 0，数据异常`,
        salePrice: sp.salePrice,
        currency:  sp.currency,
        pnk:       sp.pnk,
        calculatedAt: now,
      },
    };
  }

  const currency = sp.currency;

  // ── 找不到本地 Product ────────────────────────────────────────────────
  if (!local) {
    return {
      status: 'MISSING_LOCAL_PRODUCT',
      estimatedProfit: null,
      estimatedProfitCny: null,
      profitMarginPct: null,
      breakdown: {
        profitCalculationStatus: 'MISSING_LOCAL_PRODUCT',
        reason:             '未找到匹配的本地库存 SKU / Product 记录（mappedInventorySku 未绑定且 PNK 无对应 Product）',
        salePrice:          round2(sp.salePrice),
        currency,
        pnk:                sp.pnk,
        mappedInventorySku: sp.mappedInventorySku,
        calculatedAt:       now,
      },
    };
  }

  // ── 无采购价 ──────────────────────────────────────────────────────────
  if (!local.purchasePrice) {
    return {
      status: 'MISSING_PURCHASE_COST',
      estimatedProfit: null,
      estimatedProfitCny: null,
      profitMarginPct: null,
      breakdown: {
        profitCalculationStatus: 'MISSING_PURCHASE_COST',
        reason:             '本地 Product 存在但 purchasePrice 为空',
        salePrice:          round2(sp.salePrice),
        currency,
        pnk:                sp.pnk,
        mappedInventorySku: sp.mappedInventorySku,
        localSku:           local.sku,
        calculatedAt:       now,
      },
    };
  }

  // ── 汇率缺失 ──────────────────────────────────────────────────────────
  const cnyToLocal = rateMap.get(`CNY→${currency}`);
  if (!cnyToLocal) {
    return {
      status: 'MISSING_EXCHANGE_RATE',
      estimatedProfit: null,
      estimatedProfitCny: null,
      profitMarginPct: null,
      breakdown: {
        profitCalculationStatus: 'MISSING_EXCHANGE_RATE',
        reason:    `ExchangeRate 表中缺少 CNY→${currency} 汇率`,
        salePrice: round2(sp.salePrice),
        currency,
        pnk:       sp.pnk,
        calculatedAt: now,
      },
    };
  }

  const localToCny = rateMap.get(`${currency}→CNY`);

  // ── 佣金来源三级链路 ─────────────────────────────────────────────────
  // storedCommissionRate：DB 中存的值（可能为历史手工写入）
  // effectiveCommissionRate：本次实际使用的佣金率
  // effectiveCommissionSource：本次实际来源枚举
  const storedCommissionRate = sp.commissionRate;
  const storedCommissionRateSource = sp.commissionRateSource;

  let effectiveCommissionRate: number;
  let effectiveCommissionSource: CommissionSource;

  if (storedCommissionRate != null) {
    effectiveCommissionRate  = storedCommissionRate;
    // DB 中已有 source 则直接用，否则认定为历史遗留字典来源
    effectiveCommissionSource = (storedCommissionRateSource as CommissionSource) ?? 'LEGACY_DICTIONARY';
  } else {
    const guessed = guessCommissionRate(sp.name, local.category ?? null);
    if (guessed != null) {
      effectiveCommissionRate  = guessed;
      effectiveCommissionSource = 'RUNTIME_DICTIONARY';
    } else {
      effectiveCommissionRate  = DEFAULT_COMMISSION_RATE;
      effectiveCommissionSource = 'DEFAULT_FALLBACK';
    }
  }

  // ── FBE 可信来源逻辑（优先级固定）──────────────────────────────────────
  // 1. fbe_fee_override_cny 且来源、更新时间有效 → MANUAL_STORE_PRODUCT
  // 2. StoreProduct.fbeFee + fbeCurrency + fbeSource 为可信值
  // 3. 其他所有情况 → DEFAULT_CNY_7
  //
  // Product.fbeFee 历史值：仅写入 breakdown 诊断字段，绝不参与扣减
  let fbeLocal: number;
  let effectiveFbeSource: string;
  let fbeCurrencyUnsupported = false;
  let manualFbeOverrideCny: number | null = null;
  let manualFbeOverrideSource: string | null = null;
  let isEstimatedFbe = false;

  const overrideCny    = sp.fbeFeeOverrideCny;
  const overrideSource = sp.fbeFeeOverrideSource?.trim() || null;
  const overrideAt     = sp.fbeFeeOverrideUpdatedAt;
  const hasValidManualOverride =
    overrideCny != null &&
    overrideCny >= 0 &&
    overrideSource != null &&
    overrideAt != null;

  const spFbeFee      = sp.fbeFee;
  const spFbeCurrency = sp.fbeCurrency;
  const spFbeSource   = sp.fbeSource;
  const isTrustedFbeSource = spFbeSource != null && TRUSTED_FBE_SOURCES.has(spFbeSource);
  const isFbeCurrencySupported =
    spFbeCurrency === currency || spFbeCurrency === 'CNY';

  if (hasValidManualOverride) {
    fbeLocal = overrideCny * cnyToLocal;
    effectiveFbeSource = 'MANUAL_STORE_PRODUCT';
    manualFbeOverrideCny = round2(overrideCny);
    manualFbeOverrideSource = overrideSource;
    isEstimatedFbe = false;
  } else if (spFbeFee != null && isTrustedFbeSource && isFbeCurrencySupported) {
    if (spFbeCurrency === 'CNY') {
      fbeLocal = spFbeFee * cnyToLocal;
    } else {
      fbeLocal = spFbeFee; // 已是当地货币
    }
    effectiveFbeSource = spFbeSource!;
    isEstimatedFbe = false;
  } else {
    fbeLocal = DEFAULT_FBE_CNY * cnyToLocal;
    effectiveFbeSource = 'DEFAULT_CNY_7';
    isEstimatedFbe = true;
    if (spFbeFee != null && isTrustedFbeSource && !isFbeCurrencySupported) {
      fbeCurrencyUnsupported = true;
    }
  }

  // 头程运费
  const headFreightCny   = calcHeadFreightCny(
    local.length, local.width, local.height, local.actualWeight,
  );
  const isMissingVolumeWeight = headFreightCny === null;
  const headFreightLocal = (headFreightCny ?? 0) * cnyToLocal;

  const purchasePriceCny = local.purchasePrice;
  const purchaseCostLocal = purchasePriceCny * cnyToLocal;

  // 退货损耗
  const returnLossRate  = local.returnLossRate ?? 0;
  const returnLossCny   = purchasePriceCny * returnLossRate;
  const returnLossLocal = returnLossCny * cnyToLocal;

  // 佣金（当地货币）
  const commission = sp.salePrice * effectiveCommissionRate;

  // 利润
  const profitLocal = sp.salePrice - commission - fbeLocal - headFreightLocal
                      - purchaseCostLocal - returnLossLocal;
  const profitCny       = localToCny != null ? profitLocal * localToCny : null;
  const marginPct       = (profitLocal / sp.salePrice) * 100;

  // Product.fbeFee 历史诊断字段（不参与扣减）
  const legacyFbeReferenceAvailable = local.fbeFee != null;
  const legacyFbeReferenceValue     = legacyFbeReferenceAvailable
    ? round2(Number(local.fbeFee))
    : null;

  const breakdown: Record<string, unknown> = {
    profitCalculationStatus:   'READY',
    salePrice:                 round2(sp.salePrice),
    currency,

    // 佣金明细
    storedCommissionRate,
    storedCommissionRateSource,
    effectiveCommissionRate,
    effectiveCommissionSource,
    commission:                round2(commission),

    // FBE 明细
    effectiveFbeSource,
    effectiveFbeLocal:         round2(fbeLocal),
    fbe:                       round2(fbeLocal),
    isEstimatedFbe,
    manualFbeOverrideCny,
    manualFbeOverrideSource,
    fbeCurrencyUnsupported,
    // 历史诊断（不参与计算）
    legacyFbeReferenceAvailable,
    legacyFbeReferenceValue,

    // 头程
    isMissingVolumeWeight,
    headFreightCny:            round2(headFreightCny ?? 0),
    headFreightLocal:          round2(headFreightLocal),

    // 采购成本
    purchaseCostCny:           round2(purchasePriceCny),
    purchaseCostLocal:         round2(purchaseCostLocal),

    // 退货损耗
    returnLossRate,
    returnLossCny:             round2(returnLossCny),
    returnLossLocal:           round2(returnLossLocal),

    // 汇率
    exchangeRateCnyToLocal:    cnyToLocal,
    exchangeRateLocalToCny:    localToCny ?? null,

    // 结果
    profitLocal:               round2(profitLocal),
    profitCny:                 profitCny != null ? round2(profitCny) : null,
    profitMarginPct:           round2(marginPct),

    calculatedAt:              now,
  };

  return {
    status: 'READY',
    estimatedProfit:    round2(profitLocal),
    estimatedProfitCny: profitCny != null ? round2(profitCny) : null,
    profitMarginPct:    round2(marginPct),
    breakdown,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 批量重算：按店铺
// ────────────────────────────────────────────────────────────────────────────

/**
 * 为指定店铺的全部 StoreProduct 重算利润并写入缓存字段。
 * v4：每条产品都写入评估结果（无论成功或失败），不允许跳过保留旧利润。
 * @returns 更新条数（含利润为 null 的失败评估）
 */
export async function recalcProfitForShop(shopId: number): Promise<number> {
  const products = await prisma.storeProduct.findMany({
    where: { shopId, isArchived: false },
    select: {
      id: true, salePrice: true, currency: true,
      commissionRate: true, commissionRateSource: true,
      mappedInventorySku: true, pnk: true,
      name: true,
      // StoreProduct FBE 可信来源字段
      fbeFee: true, fbeCurrency: true, fbeSource: true,
      fbeFeeOverrideCny: true, fbeFeeOverrideSource: true, fbeFeeOverrideUpdatedAt: true,
    },
  });

  if (products.length === 0) return 0;

  // ── 跨店 SKU 继承 ──────────────────────────────────────────────────────
  const ownSkus = products
    .map((p) => p.mappedInventorySku)
    .filter((s): s is string => !!s);

  const pnks = products.map((p) => p.pnk).filter(Boolean) as string[];

  const unmappedPnks = products
    .filter((p) => !p.mappedInventorySku && p.pnk)
    .map((p) => p.pnk!)
    .filter(Boolean);

  const inheritedRows = unmappedPnks.length > 0
    ? await prisma.storeProduct.findMany({
        where: {
          pnk:                { in: unmappedPnks },
          isArchived:         false,
          mappedInventorySku: { not: null },
          shopId:             { not: shopId },
        },
        select: { pnk: true, mappedInventorySku: true },
        distinct: ['pnk'],
      })
    : [];

  const inheritedSkuMap = new Map<string, string>();
  for (const row of inheritedRows) {
    if (row.pnk && row.mappedInventorySku && !inheritedSkuMap.has(row.pnk)) {
      inheritedSkuMap.set(row.pnk, row.mappedInventorySku);
    }
  }
  if (inheritedRows.length > 0) {
    console.log(`[ProfitCalc] shopId=${shopId} 跨店继承命中 ${inheritedRows.length} 条 PNK 映射`);
  }

  // ── 批量加载 Product ────────────────────────────────────────────────────
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

  type RawLocalProduct = (typeof skuProducts)[number];
  const skuMap = new Map<string, RawLocalProduct>();
  const pnkMap = new Map<string, RawLocalProduct>();
  for (const lp of skuProducts) if (lp.sku) skuMap.set(lp.sku, lp);
  for (const lp of pnkProducts) if (lp.pnk) pnkMap.set(lp.pnk, lp);

  const rateMap = await loadExchangeRateMap();
  const now     = new Date();

  // ── 第一步：纯内存计算，所有产品都进入评估 ──────────────────────────
  type PendingUpdate = {
    id: number;
    estimatedProfit: number | null;
    estimatedProfitCny: number | null;
    profitMarginPct: number | null;
    profitCalculatedAt: Date;
    profitBreakdown: object;
  };
  const pending: PendingUpdate[] = [];

  for (const sp of products) {
    const effectiveSku = sp.mappedInventorySku ?? inheritedSkuMap.get(sp.pnk);
    const rawLocal =
      (effectiveSku ? skuMap.get(effectiveSku) : undefined) ?? pnkMap.get(sp.pnk);

    // 转换为纯计算函数所需的 LocalProductInput
    const local: LocalProductInput | null = rawLocal
      ? {
          sku:           rawLocal.sku,
          pnk:           rawLocal.pnk,
          purchasePrice: rawLocal.purchasePrice ? Number(rawLocal.purchasePrice) : null,
          fbeFee:        rawLocal.fbeFee ? Number(rawLocal.fbeFee) : null,
          length:        rawLocal.length ? Number(rawLocal.length) : null,
          width:         rawLocal.width  ? Number(rawLocal.width)  : null,
          height:        rawLocal.height ? Number(rawLocal.height) : null,
          actualWeight:  rawLocal.actualWeight ? Number(rawLocal.actualWeight) : null,
          category:      rawLocal.category,
          returnLossRate: Number(rawLocal.returnLossRate ?? 0),
        }
      : null;

    const spInput: StoreProductInput = {
      id:                  sp.id,
      salePrice:           Number(sp.salePrice),
      currency:            sp.currency ?? 'RON',
      pnk:                 sp.pnk,
      name:                sp.name,
      mappedInventorySku:  sp.mappedInventorySku,
      commissionRate:      sp.commissionRate,
      commissionRateSource: sp.commissionRateSource,
      fbeFee:              sp.fbeFee ? Number(sp.fbeFee) : null,
      fbeCurrency:         sp.fbeCurrency,
      fbeSource:           sp.fbeSource,
      fbeFeeOverrideCny:   sp.fbeFeeOverrideCny != null ? Number(sp.fbeFeeOverrideCny) : null,
      fbeFeeOverrideSource: sp.fbeFeeOverrideSource,
      fbeFeeOverrideUpdatedAt: sp.fbeFeeOverrideUpdatedAt,
    };

    const result = calcProfitForProduct(spInput, local, rateMap);

    pending.push({
      id:                 sp.id,
      estimatedProfit:    result.estimatedProfit,
      estimatedProfitCny: result.estimatedProfitCny,
      profitMarginPct:    result.profitMarginPct,
      profitCalculatedAt: now,
      profitBreakdown:    result.breakdown,
    });
  }

  // ── 第二步：分块批量写入（含失败评估，统一清空旧利润）────────────────
  let updated = 0;
  for (let i = 0; i < pending.length; i += WRITE_CHUNK_SIZE) {
    const chunk = pending.slice(i, i + WRITE_CHUNK_SIZE);
    try {
      await prisma.$transaction(
        chunk.map((u) =>
          prisma.storeProduct.update({
            where: { id: u.id },
            data: {
              estimatedProfit:    u.estimatedProfit,
              estimatedProfitCny: u.estimatedProfitCny,
              profitMarginPct:    u.profitMarginPct,
              profitCalculatedAt: u.profitCalculatedAt,
              profitBreakdown:    u.profitBreakdown,
            },
          }),
        ),
      );
      updated += chunk.length;
    } catch (err: any) {
      console.error(`[ProfitCalc] shopId=${shopId} chunk[${i}~${i + chunk.length - 1}] 写入失败:`, err.message ?? err);
    }
    if (i + WRITE_CHUNK_SIZE < pending.length) await sleep(WRITE_CHUNK_DELAY);
  }

  return updated;
}

// ────────────────────────────────────────────────────────────────────────────
// 全店铺批量重算
// ────────────────────────────────────────────────────────────────────────────

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
        console.log(`[ProfitCalc] ${shop.shopName} (id=${shop.id}): ${count} 条已评估`);
      }
    } catch (err: any) {
      console.error(`[ProfitCalc] ${shop.shopName} 重算失败:`, err.message ?? err);
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[ProfitCalc] 全量重算完成：${shops.length} 家店铺，${totalUpdated} 条产品，耗时 ${elapsed}ms`);
  return { totalUpdated, shopCount: shops.length };
}

// ────────────────────────────────────────────────────────────────────────────
// 按 SKU 列表增量重算
// ────────────────────────────────────────────────────────────────────────────

/**
 * 按 SKU 列表反查 StoreProduct 并重算利润。
 * 用于 inventory-batch-update / recalculate 修改采购价/规格后的增量触发。
 */
export async function recalcProfitBySkus(skus: string[]): Promise<number> {
  if (skus.length === 0) return 0;

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
