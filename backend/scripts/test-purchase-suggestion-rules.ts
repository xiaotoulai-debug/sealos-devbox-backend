/**
 * 采购建议规则自测脚本（纯函数，不依赖数据库）
 */
import {
  classifyStoreProduct,
  type ClassificationSalesStats,
  isWithinWindowDays,
} from '../src/services/productClassification';
import {
  buildPurchaseSuggestion,
  TARGET_STOCK_DAYS_BY_CLASS,
} from '../src/services/storeProductOverview';

const now = new Date('2026-06-06T12:00:00.000Z');
const recentSignal = new Date('2026-05-20T12:00:00.000Z'); // 17 days ago
const oldSignal = new Date('2026-01-01T12:00:00.000Z'); // > 30 days
const recentFirstAvailable = new Date('2026-05-20T12:00:00.000Z');
const oldFirstAvailable = new Date('2026-01-01T12:00:00.000Z');

const zeroSales: ClassificationSalesStats = { d7: 0, d14: 0, d30: 0, d60: 0, d90: 0 };

function assert(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    console.error(`❌ ${name}`, detail ?? '');
    process.exitCode = 1;
  } else {
    console.log(`✅ ${name}`);
  }
}

function run() {
  // 场景 1：链接早已抓到，但最近第一次有在途
  const waiting = classifyStoreProduct(
    {
      stock: 0,
      inTransitStock: 10,
      firstAvailableAt: null,
      firstInboundAt: recentSignal,
      firstStockSignalAt: recentSignal,
    },
    zeroSales,
    now,
  );
  assert('场景1 productClass=NEW', waiting.productClass === 'NEW');
  assert('场景1 stage=NEW_WAITING_INBOUND', waiting.newProductStage === 'NEW_WAITING_INBOUND');

  const waitingSuggestion = buildPurchaseSuggestion({
    productClass: waiting.productClass,
    newProductStage: waiting.newProductStage,
    stockStatus: 'OUT_OF_STOCK',
    platformStock: 0,
    platformInTransit: 10,
    localStock: 0,
    purchasingInTransit: 0,
    planningStock: 0,
    comprehensiveSales: 0,
    sales7: 0,
    sales14: 0,
    sales30: 0,
    daysSinceSynced: 200,
    firstStockSignalAt: recentSignal,
    firstInboundAt: recentSignal,
  });
  assert('场景1 suggestAmount=0', waitingSuggestion.suggestAmount === 0);

  // 场景 2：链接早已抓到，但最近第一次有平台库存
  const observation = classifyStoreProduct(
    {
      stock: 5,
      inTransitStock: 0,
      firstAvailableAt: recentFirstAvailable,
      firstStockSignalAt: recentFirstAvailable,
    },
    zeroSales,
    now,
  );
  assert('场景2 productClass=NEW', observation.productClass === 'NEW');
  assert('场景2 stage=NEW_OBSERVATION', observation.newProductStage === 'NEW_OBSERVATION');

  // 场景 3：首次可售超过 30 天仍无销量 → 清理款
  const clearance = classifyStoreProduct(
    { stock: 20, inTransitStock: 0, firstAvailableAt: oldFirstAvailable, firstStockSignalAt: oldFirstAvailable },
    zeroSales,
    now,
  );
  assert('场景3 productClass=CLEARANCE', clearance.productClass === 'CLEARANCE');
  const clearanceSuggestion = buildPurchaseSuggestion({
    productClass: clearance.productClass,
    newProductStage: clearance.newProductStage,
    stockStatus: 'OVERSTOCK',
    platformStock: 20,
    platformInTransit: 0,
    localStock: 0,
    purchasingInTransit: 0,
    planningStock: 0,
    comprehensiveSales: 0,
    sales7: 0,
    sales14: 0,
    sales30: 0,
    firstAvailableAt: oldFirstAvailable,
    firstStockSignalAt: oldFirstAvailable,
    daysSinceSynced: 200,
  });
  assert('场景3 targetStockDays=0', clearanceSuggestion.targetStockDays === 0);
  assert('场景3 suggestAmount=0', clearanceSuggestion.suggestAmount === 0);

  // 场景 4：老产品有历史销量，等待到货
  const oldWaiting = classifyStoreProduct(
    {
      stock: 0,
      inTransitStock: 30,
      firstAvailableAt: null,
      firstInboundAt: recentSignal,
      firstStockSignalAt: recentSignal,
    },
    { d7: 0, d14: 0, d30: 0, d60: 6, d90: 6 },
    now,
  );
  assert('场景4 productClass!=NEW', oldWaiting.productClass !== 'NEW');

  // 场景 5：误回填 firstAvailableAt 但有 d60/d90 销量
  const backfillTrap = classifyStoreProduct(
    {
      stock: 10,
      inTransitStock: 0,
      firstAvailableAt: now,
      firstStockSignalAt: now,
    },
    { d7: 0, d14: 0, d30: 0, d60: 3, d90: 3 },
    now,
  );
  assert('场景5 有历史销量不判 NEW_OBSERVATION', backfillTrap.productClass !== 'NEW');

  // 场景 5b：库存信号过旧不是新品
  const staleSignal = classifyStoreProduct(
    {
      stock: 0,
      inTransitStock: 20,
      firstAvailableAt: null,
      firstInboundAt: oldSignal,
      firstStockSignalAt: oldSignal,
    },
    zeroSales,
    now,
  );
  assert('场景5b 库存信号>30天不是 NEW', staleSignal.productClass !== 'NEW');

  // HOT 保留
  const hotSales: ClassificationSalesStats = { d7: 70, d14: 140, d30: 300, d60: 600, d90: 900 };
  const hot = classifyStoreProduct(
    { stock: 10, inTransitStock: 0, firstAvailableAt: oldFirstAvailable, firstStockSignalAt: oldFirstAvailable },
    hotSales,
    now,
  );
  assert('HOT 分类保留', hot.productClass === 'HOT');

  assert('isWithinWindowDays 近信号', isWithinWindowDays(recentSignal, 30, now));
  assert('isWithinWindowDays 旧信号', !isWithinWindowDays(oldSignal, 30, now));

  console.log('\n自测完成');
}

run();
