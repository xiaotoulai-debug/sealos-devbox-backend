/**
 * 清理款运营建议排查：复用 store-products 列表同口径
 * 用法: npx tsx scripts/diagnose-clearance-advices.ts [shopId] [limit]
 */
import { PrismaClient } from '@prisma/client';
import { generateOperationAdvices } from '../src/services/operationAdviceEngine';
import { buildPurchaseSuggestion } from '../src/services/storeProductOverview';
import {
  classifyStoreProduct,
  calculateStockStatus,
  calculateComprehensiveSales,
} from '../src/services/productClassification';
import { getSalesForProduct, getSalesStatsByShop } from '../src/services/salesStats';
import { resolveEffectiveStockSignals } from '../src/services/firstAvailableAt';
import { getMatchedStoreProductIdsByProductClass } from '../src/services/storeProductOverview';
import type { EmagLinkType } from '../src/services/emagLinkType';
import type { BuyBoxStatus } from '../src/services/emagBuyBox';
import { inferBuyBoxStatus } from '../src/services/emagBuyBox';

const prisma = new PrismaClient();

function normalizeStoredLinkType(value: string | null | undefined): EmagLinkType {
  return value === 'SELF_BUILT' || value === 'RESELL' || value === 'OWN_BRAND_RESELL' || value === 'UNKNOWN'
    ? value
    : 'UNKNOWN';
}

function normalizeStoredBuyBoxStatus(value: string | null | undefined): BuyBoxStatus {
  return value === 'WON' || value === 'LOST' || value === 'UNKNOWN' || value === 'NO_ACTIVE_BUYBOX'
    || value === 'POSSIBLY_WON' || value === 'POSSIBLY_LOST'
    ? value
    : 'UNKNOWN';
}

function isClearanceHeavySlowMoverDebug(input: {
  productClass: string;
  stock: number;
  stockStatus: string;
  stockDays: number | null;
  sales7: number;
  sales14: number;
  sales30: number;
}): { hit: boolean; highStock: boolean; poorSales: boolean } {
  const highStock = input.stock >= 30
    || input.stockStatus === 'OVERSTOCK'
    || (input.stockDays != null && input.stockDays > 120);
  const poorSales = input.sales30 <= 2 && input.sales14 <= 3 && input.sales7 <= 2;
  const hit = input.productClass === 'CLEARANCE' && input.stock > 0 && highStock && poorSales;
  return { hit, highStock, poorSales };
}

async function main() {
  const shopId = process.argv[2] ? Number(process.argv[2]) : 5;
  const limit = process.argv[3] ? Number(process.argv[3]) : 15;

  const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId } });
  if (!shop) {
    console.error('shop not found');
    process.exit(1);
  }

  const where = { shopId, isArchived: false };
  const matchedIds = await getMatchedStoreProductIdsByProductClass(shopId, 'CLEARANCE', where);
  const list = await prisma.storeProduct.findMany({
    where: { id: { in: matchedIds } },
    orderBy: { stock: 'desc' },
    take: limit,
  });

  const { map: salesMap } = await getSalesStatsByShop(shopId, true);

  console.log(`\n=== ${shop.shopName} ${shop.region} 清理款 平台库存倒序 前 ${list.length} 条 ===`);
  console.log(`引擎文件存在 ADJUST_ADS: ${JSON.stringify(generateOperationAdvices({
    productClass: 'CLEARANCE', stockStatus: 'OVERSTOCK', stock: 99, stockDays: 200,
    platformInTransit: 0, localStock: 0, purchasingInTransit: 0, planningStock: 0,
    sales7: 0, sales14: 0, sales30: 0, comprehensiveSales: 0,
    replenishReferenceDailySales: 0, targetStock: 0, coverageStock: 99, suggestAmount: 0,
    estimatedProfit: 1, profitMarginPct: 20, price: 100,
    linkType: 'SELF_BUILT', buyBoxStatus: 'WON',
  }).map(a => a.action))}\n`);

  for (const p of list) {
    const stockNum = p.stock;
    const sales_stats = getSalesForProduct(salesMap, p.sku, p.vendorSku, p.pnk);
    const compSales = calculateComprehensiveSales(sales_stats, stockNum);
    const { signals } = resolveEffectiveStockSignals(
      {
        id: p.id,
        stock: stockNum,
        inTransitStock: 0,
        firstAvailableAt: p.firstAvailableAt ?? null,
        firstInboundAt: p.firstInboundAt ?? null,
        firstStockSignalAt: p.firstStockSignalAt ?? null,
      },
      sales_stats,
    );
    const fallbackClassification = classifyStoreProduct({
      stock: stockNum,
      inTransitStock: 0,
      firstAvailableAt: signals.firstAvailableAt,
      firstStockSignalAt: signals.firstStockSignalAt,
      firstInboundAt: signals.firstInboundAt,
      syncedAt: p.syncedAt,
      mappedInventorySku: p.mappedInventorySku,
      mainImage: p.mainImage,
      imageUrl: p.imageUrl,
      estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
    }, sales_stats);
    const productClass = fallbackClassification.productClass;
    const stockStatusResult = calculateStockStatus(stockNum, compSales, sales_stats.d30);
    const purchaseSuggestion = buildPurchaseSuggestion({
      productClass,
      newProductStage: fallbackClassification.newProductStage,
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
      firstAvailableAt: signals.firstAvailableAt,
      firstStockSignalAt: signals.firstStockSignalAt,
      firstInboundAt: signals.firstInboundAt,
      lastOrderAt: sales_stats.lastOrderAt ?? null,
      daysSinceSynced: 0,
    });
    const linkType = normalizeStoredLinkType(p.emagLinkType);
    const inferredBuyBox = inferBuyBoxStatus({
      buyButtonRank: p.buyBoxRank ?? p.buyButtonRank,
      salePrice: Number(p.salePrice),
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

    const engineInput = {
      productClass,
      newProductStage: fallbackClassification.newProductStage,
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
      price: Number(p.salePrice),
      linkType,
      buyBoxStatus,
      numberOfOffers: p.numberOfOffers,
      daysSinceSynced: 0,
    };

    const operationAdvices = generateOperationAdvices(engineInput);
    const dbg = isClearanceHeavySlowMoverDebug({
      productClass,
      stock: stockNum,
      stockStatus: stockStatusResult.stockStatus,
      stockDays: stockStatusResult.stockDays,
      sales7: sales_stats.d7,
      sales14: sales_stats.d14,
      sales30: sales_stats.d30,
    });

    const sku = p.sku ?? p.vendorSku ?? p.pnk;
    console.log(`SKU: ${sku}`);
    console.log(`productClass: ${productClass} (db=${p.productClass ?? 'null'})`);
    console.log(`stock: ${stockNum}`);
    console.log(`sales7/14/30: ${sales_stats.d7}/${sales_stats.d14}/${sales_stats.d30}`);
    console.log(`stockStatus: ${stockStatusResult.stockStatus}, stockDays: ${stockStatusResult.stockDays}`);
    console.log(`suggestAmount: ${purchaseSuggestion.suggestAmount}`);
    console.log(`heavySlowMover: hit=${dbg.hit} highStock=${dbg.highStock} poorSales=${dbg.poorSales}`);
    console.log(`operationAdvices.length: ${operationAdvices.length}`);
    console.log(`actions: ${operationAdvices.map((a) => `${a.priority}-${a.action}-${a.title}`).join(' | ')}`);
    console.log('---');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
