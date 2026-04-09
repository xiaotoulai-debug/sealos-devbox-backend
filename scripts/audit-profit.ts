/**
 * 单品利润审计脚本（只读诊断，不修改任何数据）
 *
 * 用法：npm run ops:audit-profit
 * 目标：完整复现 profitCalculator 的每一步计算，逐项打印明细供人工核对。
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_PNK = 'DQTQ7Z3BM';
const TARGET_REGION = 'RO'; // 指定审计 RO 店（传空字符串则取第一条）
const DEFAULT_COMMISSION_RATE = 0.15;
const DEFAULT_FBE_CNY = 7;          // 与 profitCalculator.ts 保持一致
const VOLUME_DIVISOR = 6000;
const FREIGHT_RATE_PER_KG = 17;

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
  sep('① 查询 StoreProduct（eMAG 平台侧数据）');

  const sp = await prisma.storeProduct.findFirst({
    where: {
      pnk: TARGET_PNK,
      ...(TARGET_REGION ? { shop: { region: TARGET_REGION } } : {}),
    },
    select: {
      id: true, pnk: true, sku: true, vendorSku: true,
      salePrice: true, currency: true,
      commissionRate: true, mappedInventorySku: true,
      estimatedProfit: true, estimatedProfitCny: true,
      profitMarginPct: true, profitCalculatedAt: true,
      shop: { select: { shopName: true, region: true } },
    },
  });

  if (!sp) {
    console.error(`❌ 未找到 PNK=${TARGET_PNK} 的 StoreProduct，请确认 PNK 是否正确。`);
    return;
  }

  console.log(`StoreProduct ID   : ${sp.id}`);
  console.log(`店铺              : ${sp.shop?.shopName ?? '?'} (region=${sp.shop?.region ?? '?'})`);
  console.log(`eMAG PNK          : ${sp.pnk}`);
  console.log(`eMAG SKU          : ${sp.sku ?? '无'}`);
  console.log(`vendorSku         : ${sp.vendorSku ?? '无'}`);
  console.log(`mappedInventorySku: ${sp.mappedInventorySku ?? '无（将尝试 PNK 兜底匹配）'}`);
  console.log(`数据库已存毛利    : ${sp.estimatedProfit ?? 'null'} ${sp.currency ?? ''}`);
  console.log(`数据库已存毛利CNY : ${sp.estimatedProfitCny ?? 'null'} CNY`);
  console.log(`上次计算时间      : ${sp.profitCalculatedAt ?? '从未计算'}`);

  sep('② 查询本地 Product（库存侧成本与规格数据）');

  let local: {
    sku: string; pnk: string | null; purchasePrice: any;
    fbeFee: any; length: any; width: any; height: any; actualWeight: any;
  } | null = null;

  let matchedBy = '';

  if (sp.mappedInventorySku) {
    local = await prisma.product.findFirst({
      where: { sku: sp.mappedInventorySku },
      select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true },
    });
    if (local) matchedBy = `mappedInventorySku="${sp.mappedInventorySku}"`;
  }

  if (!local) {
    local = await prisma.product.findFirst({
      where: { pnk: TARGET_PNK },
      select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true },
    });
    if (local) matchedBy = `PNK="${TARGET_PNK}"（兜底匹配）`;
  }

  if (!local) {
    console.error(`❌ 未找到对应的本地 Product 记录（既无 mappedInventorySku 匹配，也无 PNK 匹配）`);
    console.error(`   → 这是导致利润无法计算（null）的根本原因！`);
    return;
  }

  console.log(`匹配方式          : ${matchedBy}`);
  console.log(`本地 SKU          : ${local.sku}`);
  console.log(`本地 PNK          : ${local.pnk ?? '无'}`);
  console.log(`采购价 (CNY)      : ${local.purchasePrice ?? 'null（缺失！）'}`);
  console.log(`FBE 费用          : ${local.fbeFee ?? 'null（将使用冷启动兜底值 0）'}`);
  console.log(`长 (cm)           : ${local.length ?? 'null'}`);
  console.log(`宽 (cm)           : ${local.width ?? 'null'}`);
  console.log(`高 (cm)           : ${local.height ?? 'null'}`);
  console.log(`实重 (kg)         : ${local.actualWeight ?? 'null'}`);

  if (!local.purchasePrice) {
    console.error(`\n❌ 采购价为 null，profitCalculator 会在此处 continue 跳过，毛利无法计算！`);
    return;
  }

  sep('③ 查询汇率（ExchangeRate 表）');

  const currency = sp.currency ?? 'RON';
  const [rateCnyToLocal, rateLocalToCny] = await Promise.all([
    prisma.exchangeRate.findUnique({ where: { source_target: { source: 'CNY', target: currency } } }),
    prisma.exchangeRate.findUnique({ where: { source_target: { source: currency, target: 'CNY' } } }),
  ]);

  console.log(`店铺货币          : ${currency}`);
  console.log(`CNY → ${currency} 汇率  : ${rateCnyToLocal?.rate ?? 'null（缺失！）'} (fetchedAt: ${rateCnyToLocal?.fetchedAt?.toISOString() ?? '?'})`);
  console.log(`${currency} → CNY 汇率  : ${rateLocalToCny?.rate ?? 'null（缺失！）'} (fetchedAt: ${rateLocalToCny?.fetchedAt?.toISOString() ?? '?'})`);

  if (!rateCnyToLocal) {
    console.error(`\n❌ CNY→${currency} 汇率缺失，profitCalculator 会在此处 continue 跳过！`);
    return;
  }

  // ── 以下严格复现 profitCalculator.ts 的每一步 ────────────────────────
  const cnyToLocal = Number(rateCnyToLocal.rate);
  const localToCny = rateLocalToCny ? Number(rateLocalToCny.rate) : null;

  sep('④ 逐项成本计算明细');

  // 1. 售价
  const salePrice = Number(sp.salePrice);
  console.log(`\n【售价】`);
  console.log(`  售价 = ${fmt(salePrice, currency, 2)}`);

  // 2. 佣金
  const commRate = sp.commissionRate ?? DEFAULT_COMMISSION_RATE;
  const commission = salePrice * commRate;
  const commSource = sp.commissionRate != null ? '来自数据库字段 commissionRate' : `默认兜底值 ${DEFAULT_COMMISSION_RATE * 100}%`;
  console.log(`\n【佣金】`);
  console.log(`  佣金率 = ${(commRate * 100).toFixed(2)}%  (${commSource})`);
  console.log(`  佣金 = ${fmt(salePrice, currency, 2)} × ${(commRate * 100).toFixed(2)}% = ${fmt(commission, currency, 4)}`);

  // 3. 头程运费
  const lengthCm = local.length ? Number(local.length) : null;
  const widthCm  = local.width  ? Number(local.width)  : null;
  const heightCm = local.height ? Number(local.height) : null;
  const actualWeightKg = local.actualWeight ? Number(local.actualWeight) : null;

  const hasVolume = lengthCm != null && widthCm != null && heightCm != null && lengthCm > 0 && widthCm > 0 && heightCm > 0;
  const hasWeight = actualWeightKg != null && actualWeightKg > 0;

  const volumeWeightKg = hasVolume ? (lengthCm! * widthCm! * heightCm!) / VOLUME_DIVISOR : null;
  const chargeableWeight = Math.max(actualWeightKg ?? 0, volumeWeightKg ?? 0);
  const headFreightCny = (hasVolume || hasWeight) && chargeableWeight > 0
    ? Math.round(chargeableWeight * FREIGHT_RATE_PER_KG * 100) / 100
    : null;
  const headFreightLocal = (headFreightCny ?? 0) * cnyToLocal;

  console.log(`\n【头程运费】`);
  console.log(`  实重              = ${fmt(actualWeightKg, 'kg')}`);
  console.log(`  尺寸              = ${fmt(lengthCm, 'cm')} × ${fmt(widthCm, 'cm')} × ${fmt(heightCm, 'cm')}`);
  if (hasVolume) {
    console.log(`  体积重            = ${lengthCm} × ${widthCm} × ${heightCm} / ${VOLUME_DIVISOR} = ${fmt(volumeWeightKg, 'kg')}`);
  } else {
    console.log(`  体积重            = 无法计算（尺寸数据缺失），体积重视为 0`);
  }
  console.log(`  计费重量          = MAX(实重, 体积重) = MAX(${fmt(actualWeightKg,'kg')}, ${fmt(volumeWeightKg,'kg')}) = ${fmt(chargeableWeight, 'kg')}`);
  if (headFreightCny == null) {
    console.log(`  头程费 (CNY)      = null（尺寸与重量均缺失，视为 0 参与计算）`);
  } else {
    console.log(`  头程费 (CNY)      = ${fmt(chargeableWeight, 'kg')} × ${FREIGHT_RATE_PER_KG} 元/kg = ${fmt(headFreightCny, 'CNY', 2)}`);
  }
  console.log(`  头程费 (${currency})     = ${fmt(headFreightCny ?? 0, 'CNY', 4)} × ${fmt(cnyToLocal, `CNY→${currency}`, 6)} = ${fmt(headFreightLocal, currency, 4)}`);

  // 4. 采购成本
  const purchasePriceCny = Number(local.purchasePrice);
  const purchaseCostLocal = purchasePriceCny * cnyToLocal;
  console.log(`\n【采购成本】`);
  console.log(`  采购价 (CNY)      = ${fmt(purchasePriceCny, 'CNY', 4)}`);
  console.log(`  汇率 CNY→${currency}    = ${fmt(cnyToLocal, `(1 CNY = ${fmt(cnyToLocal, currency, 4)})`, 6)}`);
  console.log(`  采购成本 (${currency})   = ${fmt(purchasePriceCny, 'CNY', 4)} × ${fmt(cnyToLocal, '', 6)} = ${fmt(purchaseCostLocal, currency, 4)}`);

  // 5. FBE 费用（与 profitCalculator.ts 保持一致：null 时改用 DEFAULT_FBE_CNY 换算兜底）
  const fbeLocal = local.fbeFee
    ? Number(local.fbeFee)
    : DEFAULT_FBE_CNY * cnyToLocal;
  const isFbeEstimated = !local.fbeFee;
  const fbeSource = local.fbeFee
    ? `来自数据库 fbeFee 字段`
    : `⚠️  数据缺失，冷启动兜底 = ${DEFAULT_FBE_CNY} CNY × ${fmt(cnyToLocal, '', 6)} = ${fmt(fbeLocal, currency, 4)}`;
  console.log(`\n【FBE 费用】`);
  console.log(`  fbeFee 原始值     = ${local.fbeFee ?? 'null'}`);
  console.log(`  FBE (${currency})         = ${fmt(fbeLocal, currency, 4)}  ← ${fbeSource}`);

  // 6. 最终汇总
  const profitLocal = salePrice - commission - fbeLocal - headFreightLocal - purchaseCostLocal;
  const profitCny = localToCny != null ? profitLocal * localToCny : null;
  const marginPct = salePrice > 0 ? (profitLocal / salePrice) * 100 : null;

  sep('⑤ 最终核算等式');
  console.log(`\n  售价             = ${fmt(salePrice, currency, 4)}`);
  console.log(`  - 佣金           = ${fmt(commission, currency, 4)}`);
  console.log(`  - FBE 费         = ${fmt(fbeLocal, currency, 4)}`);
  console.log(`  - 头程运费       = ${fmt(headFreightLocal, currency, 4)}`);
  console.log(`  - 采购成本       = ${fmt(purchaseCostLocal, currency, 4)}`);
  console.log(`  ${'─'.repeat(42)}`);
  console.log(`  = 预估毛利 (${currency}) = ${fmt(profitLocal, currency, 4)}  ← 本次计算结果`);
  if (profitCny != null) {
    console.log(`  = 预估毛利 (CNY) = ${fmt(profitCny, 'CNY', 4)}  (× ${fmt(localToCny!, `${currency}→CNY`, 6)})`);
  } else {
    console.log(`  = 预估毛利 (CNY) = null（${currency}→CNY 汇率缺失）`);
  }
  console.log(`  毛利率           = ${marginPct != null ? fmt(marginPct, '%', 2) : 'null'}`);

  sep('⑥ 与数据库缓存值对比');
  const dbProfit = sp.estimatedProfit ? Number(sp.estimatedProfit) : null;
  const dbProfitCny = sp.estimatedProfitCny ? Number(sp.estimatedProfitCny) : null;
  console.log(`  数据库 estimatedProfit    = ${dbProfit ?? 'null'} ${currency}`);
  console.log(`  本次计算 profitLocal      = ${Math.round(profitLocal * 100) / 100} ${currency}`);
  const diffLocal = dbProfit != null ? Math.abs(dbProfit - Math.round(profitLocal * 100) / 100) : null;
  console.log(`  差异                      = ${diffLocal != null ? fmt(diffLocal, currency, 4) : '无法比较（DB 为 null）'}`);
  if (diffLocal != null && diffLocal > 0.01) {
    console.log(`  ⚠️  差异 > 0.01，可能汇率已更新但利润未重算，建议执行 npm run ops:init-profit`);
  } else if (diffLocal != null) {
    console.log(`  ✅ DB 缓存与本次计算一致（差异 ≤ 0.01，舍入误差范围内）`);
  }

  console.log('\n');
}

async function crossShopSummary() {
  sep('【附录】同 PNK 跨店铺利润汇总对比');
  const allSps = await prisma.storeProduct.findMany({
    where: { pnk: TARGET_PNK },
    select: {
      id: true, sku: true, salePrice: true, currency: true,
      mappedInventorySku: true, estimatedProfit: true, estimatedProfitCny: true,
      profitMarginPct: true, profitCalculatedAt: true,
      shop: { select: { shopName: true, region: true } },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`\n共找到 ${allSps.length} 条跨店记录：\n`);
  for (const s of allSps) {
    const pct = s.profitMarginPct != null ? `${Number(s.profitMarginPct).toFixed(2)}%` : 'N/A';
    const mapped = s.mappedInventorySku ?? '❌ 未绑定';
    const profit = s.estimatedProfit != null ? `${Number(s.estimatedProfit).toFixed(2)} ${s.currency}` : '❌ null（未计算）';
    const profitCny = s.estimatedProfitCny != null ? `${Number(s.estimatedProfitCny).toFixed(2)} CNY` : 'null';
    console.log(`  [${s.shop?.region}] StoreProduct#${s.id} | 售价: ${s.salePrice} ${s.currency} | mappedSku: ${mapped}`);
    console.log(`        毛利: ${profit} | ${profitCny} | 毛利率: ${pct} | 计算时间: ${s.profitCalculatedAt?.toISOString() ?? '从未'}`);
  }

  // 诊断跨店 null 原因
  const nullShops = allSps.filter(s => s.estimatedProfit == null);
  if (nullShops.length > 0) {
    console.log(`\n  ⚠️  以下店铺毛利为 null（Phase 2 跨店继承方案可修复）：`);
    nullShops.forEach(s => {
      const reason = !s.mappedInventorySku
        ? `mappedInventorySku 未绑定，且 PNK 无法在本地 Product 表匹配`
        : `mappedInventorySku 已绑定但计算异常`;
      console.log(`     [${s.shop?.region}] #${s.id} → ${reason}`);
    });
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
