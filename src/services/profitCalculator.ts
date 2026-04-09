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

/**
 * FBE 冷启动兜底（CNY）：当 Product.fbeFee 为 null 时，以此 CNY 金额换算为当地货币兜底。
 * 严禁按 0 扣减——0 会严重高估毛利，误导业务决策。
 * 业务基准：eMAG FBE 仓储费市场均值约 7 CNY（≈ 5 RON / ≈ 1 EUR / ≈ 2 000 HUF），后续
 * 录入真实 fbeFee 后此兜底自动失效。
 */
const DEFAULT_FBE_CNY = 7;

/** 四舍五入至两位小数 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 批量写入时的分块大小与间隔（防连接池打满） */
const WRITE_CHUNK_SIZE  = 50;
const WRITE_CHUNK_DELAY = 80; // ms

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 为指定店铺的全部 StoreProduct 重算利润并写入缓存字段。
 * @returns 更新条数
 */
export async function recalcProfitForShop(shopId: number): Promise<number> {
  const products = await prisma.storeProduct.findMany({
    where: { shopId },
    select: {
      id: true, salePrice: true, currency: true,
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
  const now = new Date();

  // ── 第一步：纯内存计算，收集所有待写入记录 ────────────────────────
  type PendingUpdate = {
    id: number;
    estimatedProfit: number;
    estimatedProfitCny: number | null;
    profitMarginPct: number | null;
    profitCalculatedAt: Date;
    profitBreakdown: object;
  };
  const pending: PendingUpdate[] = [];

  for (const sp of products) {
    const salePrice = Number(sp.salePrice);
    if (salePrice <= 0) continue;

    const currency = sp.currency ?? 'RON';

    // 查找本地产品：① 本店 SKU 精确匹配 → ② 跨店继承 SKU → ③ PNK 兜底
    const effectiveSku = sp.mappedInventorySku ?? inheritedSkuMap.get(sp.pnk);
    const local = (effectiveSku ? skuMap.get(effectiveSku) : undefined)
      ?? pnkMap.get(sp.pnk);

    if (!local?.purchasePrice) continue; // 无采购价则跳过

    // ── 三级佣金率优先链路 ─────────────────────────────────────────
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

    const cnyToLocal = rateMap.get(`CNY→${currency}`);
    if (!cnyToLocal) continue; // 无汇率则跳过

    const localToCny = rateMap.get(`${currency}→CNY`);
    const purchasePriceCny = Number(local.purchasePrice);

    // 采购成本（当地货币）
    const purchaseCostLocal = purchasePriceCny * cnyToLocal;

    // 头程运费（CNY → 当地货币）
    // calcHeadFreightCny 返回 null 表示尺寸与重量数据均缺失
    const headFreightCny = calcHeadFreightCny(
      local.length ? Number(local.length) : null,
      local.width  ? Number(local.width)  : null,
      local.height ? Number(local.height) : null,
      local.actualWeight ? Number(local.actualWeight) : null,
    );
    const isMissingVolumeWeight = headFreightCny === null; // 体积/重量数据缺失标识
    const headFreightLocal = (headFreightCny ?? 0) * cnyToLocal;

    // FBE 费用：有真实录入值则用；否则 DEFAULT_FBE_CNY 换算兜底，严禁按 0 处理
    const isEstimatedFbe = !local.fbeFee;
    const fbeLocal = local.fbeFee
      ? Number(local.fbeFee)
      : DEFAULT_FBE_CNY * cnyToLocal;

    // 退货损耗（CNY → 当地货币）= 采购价 CNY × returnLossRate
    const returnLossRate  = (local.returnLossRate ?? 0);
    const returnLossCny   = purchasePriceCny * returnLossRate;
    const returnLossLocal = returnLossCny * cnyToLocal;

    // 佣金（当地货币）
    const commission = salePrice * commRate;

    // 利润（当地货币）
    const profitLocal = salePrice - commission - fbeLocal - headFreightLocal
                        - purchaseCostLocal - returnLossLocal;

    // 利润（CNY）
    const profitCny = localToCny != null ? profitLocal * localToCny : null;

    // 毛利率 %
    const marginPct = salePrice > 0 ? (profitLocal / salePrice) * 100 : null;

    // ── 利润明细 breakdown ──────────────────────────────────────────
    const breakdown = {
      salePrice:               round2(salePrice),
      currency,
      commissionRate:          commRate,
      commissionRateSource,
      isEstimatedCommission,
      commission:              round2(commission),
      fbe:                     round2(fbeLocal),
      isEstimatedFbe,
      isMissingVolumeWeight,   // true = 缺少尺寸/重量，头程按 0 估算
      headFreightCny:          round2(headFreightCny ?? 0),
      headFreightLocal:        round2(headFreightLocal),
      purchaseCostCny:         round2(purchasePriceCny),
      purchaseCostLocal:       round2(purchaseCostLocal),
      returnLossRate,
      returnLossCny:           round2(returnLossCny),
      returnLossLocal:         round2(returnLossLocal),
      exchangeRateCnyToLocal:  cnyToLocal,
      exchangeRateLocalToCny:  localToCny ?? null,
      profitLocal:             round2(profitLocal),
      profitCny:               profitCny != null ? round2(profitCny) : null,
      profitMarginPct:         marginPct != null ? round2(marginPct) : null,
    };

    pending.push({
      id:                 sp.id,
      estimatedProfit:    round2(profitLocal),
      estimatedProfitCny: profitCny != null ? round2(profitCny) : null,
      profitMarginPct:    marginPct != null ? round2(marginPct) : null,
      profitCalculatedAt: now,
      profitBreakdown:    breakdown,
    });
  }

  // ── 第二步：分块批量写入，防连接池打满 ────────────────────────────
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
    // 块间休眠，保护连接池
    if (i + WRITE_CHUNK_SIZE < pending.length) await sleep(WRITE_CHUNK_DELAY);
  }

  return updated;
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
    where: { mappedInventorySku: { in: skus } },
    select: { shopId: true },
    distinct: ['shopId'],
  });

  let totalUpdated = 0;
  for (const { shopId } of affected) {
    totalUpdated += await recalcProfitForShop(shopId);
  }
  return totalUpdated;
}
