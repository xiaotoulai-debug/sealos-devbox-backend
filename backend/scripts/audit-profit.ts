/**
 * 单品利润审计脚本（只读诊断，不修改任何数据）v2
 *
 * 用法：npm run ops:audit-profit
 * 目标：完整复现 profitCalculator v4 的每一步计算，逐项打印明细供人工核对。
 *
 * 关键原则：
 *   - 不得硬编码任何与 commissionMap / profitCalculator 不同的参数
 *   - 直接 import 真实引擎常量（DEFAULT_COMMISSION_RATE / DEFAULT_FBE_CNY）
 *   - 复用 calcProfitForProduct 纯计算函数，禁止自行实现另一套公式
 *   - 审计结果应与 profitBreakdown JSONB 字段完全一致
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_FBE_CNY,
  calcProfitForProduct,
  type StoreProductInput,
  type LocalProductInput,
} from '../src/services/profitCalculator';
import { DEFAULT_COMMISSION_RATE } from '../src/config/commissionMap';
import { loadExchangeRateMap } from '../src/services/exchangeRateSync';

const prisma = new PrismaClient();
const TARGET_PNK    = process.env.AUDIT_PNK    ?? 'DQTQ7Z3BM';
const TARGET_REGION = process.env.AUDIT_REGION  ?? 'RO';

function sep(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function fmt(val: number | null | undefined, unit = '', digits = 4): string {
  if (val == null) return `null（数据缺失）`;
  return `${val.toFixed(digits)} ${unit}`.trim();
}

async function audit() {
  console.log(`\n📋 利润审计引擎参数（来自真实引擎，非硬编码）`);
  console.log(`  DEFAULT_COMMISSION_RATE = ${DEFAULT_COMMISSION_RATE} (${(DEFAULT_COMMISSION_RATE * 100).toFixed(0)}%)`);
  console.log(`  DEFAULT_FBE_CNY         = ${DEFAULT_FBE_CNY} CNY`);

  sep('① 查询 StoreProduct（eMAG 平台侧数据）');

  const sp = await prisma.storeProduct.findFirst({
    where: {
      pnk: TARGET_PNK,
      isArchived: false,
      ...(TARGET_REGION ? { shop: { region: TARGET_REGION as any } } : {}),
    },
    select: {
      id: true, pnk: true, sku: true, vendorSku: true, name: true,
      salePrice: true, currency: true,
      commissionRate: true, commissionRateSource: true,
      mappedInventorySku: true,
      fbeFee: true, fbeCurrency: true, fbeSource: true,
      fbeFeeOverrideCny: true, fbeFeeOverrideSource: true, fbeFeeOverrideUpdatedAt: true,
      estimatedProfit: true, estimatedProfitCny: true,
      profitMarginPct: true, profitCalculatedAt: true,
      profitBreakdown: true,
      shop: { select: { shopName: true, region: true } },
    },
  });

  if (!sp) {
    console.error(`❌ 未找到 PNK=${TARGET_PNK} 的 StoreProduct，请确认 PNK 是否正确。`);
    return;
  }

  console.log(`StoreProduct ID         : ${sp.id}`);
  console.log(`店铺                    : ${sp.shop?.shopName ?? '?'} (region=${sp.shop?.region ?? '?'})`);
  console.log(`eMAG PNK                : ${sp.pnk}`);
  console.log(`eMAG SKU                : ${sp.sku ?? '无'}`);
  console.log(`vendorSku               : ${sp.vendorSku ?? '无'}`);
  console.log(`mappedInventorySku      : ${sp.mappedInventorySku ?? '无（将尝试 PNK 兜底匹配）'}`);
  console.log(`storedCommissionRate    : ${sp.commissionRate ?? 'null（将使用字典/默认兜底）'}`);
  console.log(`storedCommissionRateSource: ${sp.commissionRateSource ?? 'null'}`);
  console.log(`StoreProduct fbeFee     : ${sp.fbeFee ?? 'null'} ${sp.fbeCurrency ?? ''}`);
  console.log(`StoreProduct fbeSource  : ${sp.fbeSource ?? 'null'}`);
  console.log(`人工 FBE 纠偏(CNY)      : ${sp.fbeFeeOverrideCny ?? 'null'} (${sp.fbeFeeOverrideSource ?? '无来源'})`);
  console.log(`\n数据库已存毛利(当地)    : ${sp.estimatedProfit ?? 'null（利润评估未完成或条件不足）'} ${sp.currency ?? ''}`);
  console.log(`数据库已存毛利(CNY)     : ${sp.estimatedProfitCny ?? 'null'} CNY`);
  console.log(`上次评估时间            : ${sp.profitCalculatedAt ?? '从未评估'}`);
  if ((sp.profitBreakdown as any)?.profitCalculationStatus) {
    console.log(`上次评估状态            : ${(sp.profitBreakdown as any).profitCalculationStatus}`);
  }

  sep('② 查询本地 Product（库存侧成本与规格数据）');

  let rawLocal: {
    sku: string | null; pnk: string | null; purchasePrice: any;
    fbeFee: any; length: any; width: any; height: any; actualWeight: any;
    category: string | null; returnLossRate: any;
  } | null = null;
  let matchedBy = '';

  if (sp.mappedInventorySku) {
    rawLocal = await prisma.product.findFirst({
      where: { sku: sp.mappedInventorySku },
      select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true, category: true, returnLossRate: true },
    });
    if (rawLocal) matchedBy = `mappedInventorySku="${sp.mappedInventorySku}"`;
  }

  if (!rawLocal) {
    rawLocal = await prisma.product.findFirst({
      where: { pnk: TARGET_PNK },
      select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true, category: true, returnLossRate: true },
    });
    if (rawLocal) matchedBy = `PNK="${TARGET_PNK}"（兜底匹配）`;
  }

  if (rawLocal) {
    console.log(`匹配方式                : ${matchedBy}`);
    console.log(`本地 SKU                : ${rawLocal.sku}`);
    console.log(`本地 PNK                : ${rawLocal.pnk ?? '无'}`);
    console.log(`采购价 (CNY)            : ${rawLocal.purchasePrice ?? 'null（缺失！）'}`);
    console.log(`Product.fbeFee（历史）  : ${rawLocal.fbeFee ?? 'null'}（LEGACY_PRODUCT_UNKNOWN，仅诊断，不参与计算）`);
    console.log(`长/宽/高 (cm)           : ${rawLocal.length ?? 'null'} × ${rawLocal.width ?? 'null'} × ${rawLocal.height ?? 'null'}`);
    console.log(`实重 (kg)               : ${rawLocal.actualWeight ?? 'null'}`);
    console.log(`退货损耗率              : ${rawLocal.returnLossRate ?? 0}`);
  } else {
    console.log(`❌ 未找到本地 Product 记录（MISSING_LOCAL_PRODUCT）`);
  }

  sep('③ 加载汇率');
  const rateMap = await loadExchangeRateMap();
  const currency = sp.currency ?? 'RON';
  const cnyToLocal = rateMap.get(`CNY→${currency}`);
  const localToCny = rateMap.get(`${currency}→CNY`);
  console.log(`店铺货币   : ${currency}`);
  console.log(`CNY→${currency}: ${cnyToLocal ?? 'null（缺失！）'}`);
  console.log(`${currency}→CNY: ${localToCny ?? 'null（缺失）'}`);

  sep('④ 调用真实利润引擎纯函数 calcProfitForProduct');

  const spInput: StoreProductInput = {
    id:                  sp.id,
    salePrice:           Number(sp.salePrice),
    currency,
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

  const result = calcProfitForProduct(spInput, local, rateMap);

  console.log(`\n评估状态    : ${result.status}`);
  console.log(`预估毛利(当地): ${result.estimatedProfit ?? 'null'} ${currency}`);
  console.log(`预估毛利(CNY) : ${result.estimatedProfitCny ?? 'null'} CNY`);
  console.log(`毛利率        : ${result.profitMarginPct != null ? `${result.profitMarginPct.toFixed(2)}%` : 'null'}`);

  if (result.status === 'READY') {
    const bd = result.breakdown;
    console.log(`\n── 计算明细 ──`);
    console.log(`  售价           : ${bd.salePrice} ${currency}`);
    console.log(`  effectiveCommissionRate  : ${bd.effectiveCommissionRate} (${bd.effectiveCommissionSource})`);
    console.log(`  storedCommissionRate     : ${bd.storedCommissionRate ?? 'null'} (${bd.storedCommissionRateSource ?? 'null'})`);
    console.log(`  佣金           : ${bd.commission} ${currency}`);
    console.log(`  effectiveFbeSource       : ${bd.effectiveFbeSource}`);
    console.log(`  effectiveFbeLocal        : ${bd.effectiveFbeLocal} ${currency}`);
    console.log(`  isEstimatedFbe           : ${bd.isEstimatedFbe}`);
    console.log(`  manualFbeOverrideCny     : ${bd.manualFbeOverrideCny ?? 'null'}`);
    console.log(`  manualFbeOverrideSource  : ${bd.manualFbeOverrideSource ?? 'null'}`);
    console.log(`  FBE            : ${bd.fbe} ${currency}${bd.fbeCurrencyUnsupported ? ' ⚠️ 原FBE币种不支持，已回退DEFAULT_CNY_7' : ''}`);
    console.log(`  legacyFbeRef (诊断)      : ${bd.legacyFbeReferenceAvailable ? `${bd.legacyFbeReferenceValue}（不参与计算）` : '无'}`);
    console.log(`  头程费(CNY)   : ${bd.headFreightCny} CNY${bd.isMissingVolumeWeight ? ' ⚠️ 尺寸/重量缺失，按0处理' : ''}`);
    console.log(`  头程费(当地)  : ${bd.headFreightLocal} ${currency}`);
    console.log(`  采购成本(CNY) : ${bd.purchaseCostCny} CNY`);
    console.log(`  采购成本(当地): ${bd.purchaseCostLocal} ${currency}`);
    console.log(`  退货损耗率    : ${bd.returnLossRate}`);
    console.log(`  退货损耗(CNY) : ${bd.returnLossCny} CNY`);
    console.log(`  退货损耗(当地): ${bd.returnLossLocal} ${currency}`);
    console.log(`  利润(当地)    : ${bd.profitLocal} ${currency}`);
    console.log(`  利润(CNY)     : ${bd.profitCny ?? 'null'} CNY`);
  } else {
    console.log(`\n评估失败原因  : ${(result.breakdown as any).reason ?? '见 profitCalculationStatus'}`);
  }

  sep('⑤ 与数据库缓存值对比');
  const dbProfit = sp.estimatedProfit ? Number(sp.estimatedProfit) : null;
  console.log(`  数据库 estimatedProfit    = ${dbProfit ?? 'null'} ${currency}`);
  console.log(`  本次计算 profitLocal      = ${result.estimatedProfit ?? 'null'} ${currency}`);
  if (dbProfit != null && result.estimatedProfit != null) {
    const diff = Math.abs(dbProfit - result.estimatedProfit);
    console.log(`  差异                      = ${fmt(diff, currency, 4)}`);
    if (diff > 0.01) {
      console.log(`  ⚠️  差异 > 0.01，建议执行 POST /api/store-products/recalc-profit 重算`);
    } else {
      console.log(`  ✅ DB 缓存与本次计算一致（差异 ≤ 0.01）`);
    }
  } else if (dbProfit == null && result.estimatedProfit != null) {
    console.log(`  ⚠️  DB 利润为 null 但本次可以计算，建议触发重算`);
  } else if (dbProfit != null && result.estimatedProfit == null) {
    console.log(`  ❌ 本次无法计算但 DB 存有旧利润（旧缓存，v4 重算后将清空）`);
  }

  console.log('\n');
}

async function crossShopSummary() {
  sep('【附录】同 PNK 跨店铺利润汇总对比');
  const allSps = await prisma.storeProduct.findMany({
    where: { pnk: TARGET_PNK, isArchived: false },
    select: {
      id: true, sku: true, salePrice: true, currency: true,
      mappedInventorySku: true, estimatedProfit: true, estimatedProfitCny: true,
      profitMarginPct: true, profitCalculatedAt: true,
      profitBreakdown: true,
      shop: { select: { shopName: true, region: true } },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`\n共找到 ${allSps.length} 条跨店记录：\n`);
  for (const s of allSps) {
    const pct    = s.profitMarginPct != null ? `${Number(s.profitMarginPct).toFixed(2)}%` : 'N/A';
    const mapped = s.mappedInventorySku ?? '❌ 未绑定';
    const profit = s.estimatedProfit != null ? `${Number(s.estimatedProfit).toFixed(2)} ${s.currency}` : '❌ null';
    const status = (s.profitBreakdown as any)?.profitCalculationStatus ?? '未评估';
    console.log(`  [${s.shop?.region}] StoreProduct#${s.id} | 状态: ${status}`);
    console.log(`        售价: ${s.salePrice} ${s.currency} | mappedSku: ${mapped}`);
    console.log(`        毛利: ${profit} | 毛利率: ${pct} | 计算时间: ${s.profitCalculatedAt?.toISOString() ?? '从未'}`);
  }
}

audit()
  .then(() => crossShopSummary())
  .catch((e) => {
    console.error('脚本异常退出:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
