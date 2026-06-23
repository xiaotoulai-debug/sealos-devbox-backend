/**
 * 一次性诊断：抽样 store-products 运营建议数组长度（不启动 HTTP）
 * 用法: npx tsx scripts/diagnose-operation-advices.ts [shopId] [limit]
 */
import { PrismaClient } from '@prisma/client';
import { generateOperationAdvices } from '../src/services/operationAdvice';
import { buildPurchaseSuggestion } from '../src/services/storeProductOverview';
import {
  classifyStoreProduct,
  calculateStockStatus,
  calculateComprehensiveSales,
} from '../src/services/productClassification';
import { resolveEffectiveStockSignals } from '../src/services/firstAvailableAt';
import type { EmagLinkType } from '../src/services/emagLinkType';
import type { BuyBoxStatus } from '../src/services/emagBuyBox';
import { inferBuyBoxStatus } from '../src/services/emagBuyBox';
import { getSalesForProduct, getSalesStatsByShop } from '../src/services/salesStats';

const prisma = new PrismaClient();

function normalizeStoredLinkType(value: string | null | undefined): EmagLinkType {
  return value === 'SELF_BUILT' || value === 'RESELL' || value === 'OWN_BRAND_RESELL' || value === 'UNKNOWN'
    ? value
    : 'UNKNOWN';
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

const PRODUCT_CLASS_LABEL: Record<string, string> = {
  HOT: '主推款',
  POTENTIAL: '成长款',
  NORMAL: '常规款',
  NEW: '新品',
  CLEARANCE: '清理款',
};

async function main() {
  const shopIdArg = process.argv[2] ? Number(process.argv[2]) : undefined;
  const limit = process.argv[3] ? Number(process.argv[3]) : 20;

  const shop = shopIdArg
    ? await prisma.shopAuthorization.findUnique({ where: { id: shopIdArg } })
    : await prisma.shopAuthorization.findFirst({ orderBy: { id: 'asc' } });

  if (!shop) {
    console.error('未找到店铺');
    process.exit(1);
  }

  const list = await prisma.storeProduct.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: [{ comprehensiveSales: 'desc' }, { id: 'asc' }],
    take: limit,
    include: { shop: { select: { shopName: true, region: true } } },
  });

  const salesStatsResult = await getSalesStatsByShop(shop.id, true);
  const fullSalesMap = salesStatsResult.map;

  const lengthStats = new Map<number, number>();
  let multiCount = 0;
  let observeOnly = 0;

  console.log(`\n=== 店铺 shopId=${shop.id} ${shop.shopName ?? ''} 抽样 ${list.length} 条 ===\n`);

  for (const p of list) {
    const stockNum = p.stock;
    const salePriceNum = Number(p.salePrice);
    const sales_stats = getSalesForProduct(fullSalesMap, p.sku, p.vendorSku, p.pnk);
    const compSales = calculateComprehensiveSales(sales_stats, stockNum);
    const effectiveSignals = resolveEffectiveStockSignals(
      {
        id: p.id,
        stock: stockNum,
        inTransitStock: 0,
        firstAvailableAt: p.firstAvailableAt ?? null,
        firstInboundAt: p.firstInboundAt ?? null,
        firstStockSignalAt: p.firstStockSignalAt ?? null,
      },
      sales_stats,
    ).signals;

    const fallbackClassification = classifyStoreProduct({
      stock: stockNum,
      inTransitStock: 0,
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
    const stockStatusResult = calculateStockStatus(stockNum, compSales, sales_stats.d30);

    const purchaseSuggestion = buildPurchaseSuggestion({
      productClass,
      newProductStage,
      stockStatus: stockStatusResult.stockStatus,
      platformStock: stockNum,
      platformInTransit: 0,
      localStock: 0,
      purchasingInTransit: 0,
      planningStock: 0,
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
      lastOrderAt: sales_stats.lastOrderAt ?? null,
      daysSinceSynced: 0,
    });

    const linkType = normalizeStoredLinkType(p.emagLinkType);
    const inferredBuyBox = inferBuyBoxStatus({
      buyButtonRank: p.buyBoxRank ?? p.buyButtonRank,
      salePrice: salePriceNum,
      bestOfferSalePrice: p.bestOfferSalePrice != null ? Number(p.bestOfferSalePrice) : null,
      mainOfferPrice: p.mainOfferPrice != null ? Number(p.mainOfferPrice) : null,
      stock: stockNum,
      status: p.status,
      offerValidationStatus: p.validationStatus,
      numberOfOffers: p.numberOfOffers,
    });
    const buyBoxStatus = p.buyBoxStatus
      ? normalizeStoredBuyBoxStatus(p.buyBoxStatus)
      : inferredBuyBox.buyBoxStatus;

    const operationAdvices = generateOperationAdvices({
      productClass,
      newProductStage,
      replenishmentStage: purchaseSuggestion.replenishmentStage ?? null,
      stockStatus: stockStatusResult.stockStatus,
      stock: stockNum,
      stockDays: stockStatusResult.stockDays,
      platformInTransit: 0,
      localStock: 0,
      purchasingInTransit: 0,
      planningStock: 0,
      sales7: sales_stats.d7,
      sales14: sales_stats.d14,
      sales30: sales_stats.d30,
      comprehensiveSales: compSales,
      replenishReferenceDailySales: purchaseSuggestion.replenishReferenceDailySales,
      targetStock: purchaseSuggestion.targetStock,
      coverageStock: purchaseSuggestion.coverageStock,
      suggestAmount: purchaseSuggestion.suggestAmount,
      estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
      profitMarginPct: p.profitMarginPct ?? null,
      price: Number.isFinite(salePriceNum) ? salePriceNum : null,
      linkType,
      buyBoxStatus,
      numberOfOffers: p.numberOfOffers,
      daysSinceSynced: 0,
    });

    const len = operationAdvices.length;
    lengthStats.set(len, (lengthStats.get(len) ?? 0) + 1);
    if (len > 1) multiCount += 1;
    if (len === 1 && operationAdvices[0]?.action === 'OBSERVE') observeOnly += 1;

    const sku = p.sku ?? p.vendorSku ?? p.pnk;
    const actions = operationAdvices.map((a) => `${a.priority}-${a.action}-${a.title}`);
    console.log(`SKU: ${sku}`);
    console.log(`productClass: ${PRODUCT_CLASS_LABEL[productClass] ?? productClass}`);
    console.log(`stockStatus: ${stockStatusResult.stockStatus}`);
    console.log(`stock: ${stockNum}`);
    console.log(`sales7/14/30: ${sales_stats.d7}/${sales_stats.d14}/${sales_stats.d30}`);
    console.log(`purchaseSuggestAmount: ${purchaseSuggestion.suggestAmount}`);
    console.log(`purchaseSuggestion.text: ${purchaseSuggestion.text ?? '(无)'}`);
    console.log(`profitMarginPct: ${p.profitMarginPct ?? 'null'}`);
    console.log(`linkType: ${linkType}`);
    console.log(`buyBoxStatus: ${buyBoxStatus}`);
    console.log(`operationAdvices.length: ${len}`);
    console.log(`actions: [${actions.join(', ')}]`);
    console.log('---');
  }

  console.log('\n=== 统计 ===');
  console.log(`多条建议(>1): ${multiCount}/${list.length}`);
  console.log(`仅 OBSERVE: ${observeOnly}/${list.length}`);
  console.log('长度分布:', Object.fromEntries([...lengthStats.entries()].sort((a, b) => a[0] - b[0])));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
