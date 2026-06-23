import type { ProductClass, StockStatus, NewProductStage } from './productClassification';
import type { EmagLinkType } from './emagLinkType';
import type { BuyBoxStatus } from './emagBuyBox';

export type OperationPriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

export type OperationAction =
  | 'URGENT_REPLENISH'
  | 'RAISE_PROFIT'
  | 'RAISE_PRICE_MODERATELY'
  | 'JOIN_CAMPAIGN'
  | 'COMPLAIN_HIJACKER'
  | 'WIN_BUY_BOX'
  | 'CREATE_AD'
  | 'INCREASE_CPC'
  | 'ADJUST_ADS'
  | 'LOWER_PRICE'
  | 'WAIT_FOR_ARRIVAL'
  | 'PAUSE_PURCHASE'
  | 'OBSERVE'
  | 'ADVERTISE';

export interface OperationAdvice {
  priority: OperationPriority;
  action: OperationAction;
  title: string;
  reason: string;
  score: number;
  tags?: string[];
  metrics?: Record<string, unknown>;
}

export interface StoreProductAdviceInput {
  productClass: ProductClass;
  newProductStage?: NewProductStage | null;
  replenishmentStage?: string | null;
  stockStatus: StockStatus;
  stock: number;
  stockDays: number | null;
  platformInTransit: number;
  localStock: number;
  purchasingInTransit: number;
  planningStock: number;
  sales7: number;
  sales14: number;
  sales30: number;
  comprehensiveSales: number;
  replenishReferenceDailySales: number;
  targetStock: number;
  coverageStock: number;
  suggestAmount: number;
  estimatedProfit: number | null;
  profitMarginPct: number | null;
  price: number | null;
  linkType: EmagLinkType;
  buyBoxStatus: BuyBoxStatus;
  numberOfOffers?: number | null;
  daysSinceSynced?: number;
}

type AdviceBucket = 'BUYBOX' | 'STOCKOUT' | 'PROFIT' | 'INVENTORY' | 'NEW_PRODUCT' | 'OBSERVE';

interface AdviceCandidate {
  action: OperationAction;
  title: string;
  reason: string;
  score: number;
  tags: string[];
  bucket: AdviceBucket;
}

export const OPERATION_ADVICE_ENGINE_RULES = {
  lowProfitMarginPct: 15,
  highProfitMarginPct: 40,
  clearanceStockThreshold: 10,
  clearanceHighStockThreshold: 30,
  clearancePoorSales30Threshold: 2,
  lowSales30Threshold: 2,
  maxAdvices: 5,
  ruleVersion: 'v2-multi',
} as const;

const CLEARANCE_INVENTORY_ACTIONS: OperationAction[] = [
  'LOWER_PRICE',
  'JOIN_CAMPAIGN',
  'ADJUST_ADS',
  'PAUSE_PURCHASE',
];

const INVENTORY_ACTIONS: OperationAction[] = ['LOWER_PRICE', 'JOIN_CAMPAIGN', 'ADJUST_ADS', 'PAUSE_PURCHASE'];

const CLEARANCE_INVENTORY_ORDER: Record<string, number> = {
  LOWER_PRICE: 0,
  JOIN_CAMPAIGN: 1,
  ADJUST_ADS: 2,
  PAUSE_PURCHASE: 3,
};

function isSalesClass(productClass: ProductClass): boolean {
  return productClass === 'HOT' || productClass === 'POTENTIAL' || productClass === 'NORMAL';
}

function isClearance(productClass: ProductClass): boolean {
  return productClass === 'CLEARANCE';
}

function isNewProduct(productClass: ProductClass): boolean {
  return productClass === 'NEW';
}

function isOwnLink(linkType: EmagLinkType): boolean {
  return linkType === 'SELF_BUILT' || linkType === 'OWN_BRAND_RESELL';
}

function isResellLink(linkType: EmagLinkType): boolean {
  return linkType === 'RESELL';
}

function buyBoxLost(buyBoxStatus: BuyBoxStatus): boolean {
  return buyBoxStatus !== 'WON';
}

function hasRecentSales(input: StoreProductAdviceInput): boolean {
  return input.comprehensiveSales > 0 || input.sales30 > 0 || input.sales7 > 0;
}

function isLowOrOutStock(stockStatus: StockStatus): boolean {
  return stockStatus === 'OUT_OF_STOCK' || stockStatus === 'LOW_STOCK' || stockStatus === 'WARNING';
}

function isOverstock(stockStatus: StockStatus, stockDays: number | null): boolean {
  return stockStatus === 'OVERSTOCK' || (stockDays != null && stockDays > 120);
}

function isSalesTrendRising(sales7: number, sales14: number): boolean {
  return sales7 > 0 && sales7 >= sales14 / 2;
}

function isSalesTrendFalling(sales7: number, sales14: number): boolean {
  return sales14 > 0 && sales7 < sales14;
}

function isClearanceHeavySlowMover(input: StoreProductAdviceInput): boolean {
  if (!isClearance(input.productClass) || input.stock <= 0) return false;
  const highStock = input.stock >= OPERATION_ADVICE_ENGINE_RULES.clearanceHighStockThreshold
    || isOverstock(input.stockStatus, input.stockDays);
  const poorSales = input.sales30 <= OPERATION_ADVICE_ENGINE_RULES.clearancePoorSales30Threshold
    && input.sales14 <= 3
    && input.sales7 <= 2;
  return highStock && poorSales;
}

function clearanceStockRiskSuffix(input: StoreProductAdviceInput): string {
  const pending = input.platformInTransit + input.purchasingInTransit + input.planningStock;
  if (pending <= 0) return '';
  return ' 当前仍有在途或计划库存，需关注库存累积风险。';
}

function appendClearanceHeavySlowMoverCandidates(
  out: AdviceCandidate[],
  input: StoreProductAdviceInput,
): void {
  if (!isClearanceHeavySlowMover(input)) return;
  const stockRisk = clearanceStockRiskSuffix(input);
  out.push(
    {
      action: 'LOWER_PRICE',
      title: '降低价格',
      reason: `清理款库存较高且近 30 天动销较差，建议优先降价释放库存。${stockRisk}`.trim(),
      score: 780,
      tags: withProfitTag(input, ['清理款', '库存压力', '降低价格']),
      bucket: 'INVENTORY',
    },
    {
      action: 'JOIN_CAMPAIGN',
      title: '参与活动',
      reason: `库存占用较高，可通过平台活动加速清理。${stockRisk}`.trim(),
      score: 720,
      tags: withProfitTag(input, ['清理款', '库存压力', '参与活动']),
      bucket: 'INVENTORY',
    },
    {
      action: 'ADJUST_ADS',
      title: '调整广告',
      reason: `库存较高但动销较差，建议重新调整广告投放，测试清仓流量。${stockRisk}`.trim(),
      score: 650,
      tags: withProfitTag(input, ['清理款', '调整广告']),
      bucket: 'INVENTORY',
    },
    {
      action: 'PAUSE_PURCHASE',
      title: '暂停采购',
      reason: `清理款库存仍高，建议暂停继续采购，避免库存继续累积。${stockRisk}`.trim(),
      score: 580,
      tags: withProfitTag(input, ['清理款', '暂停采购']),
      bucket: 'INVENTORY',
    },
  );
}

function withProfitTag(input: StoreProductAdviceInput, tags: string[]): string[] {
  if (input.profitMarginPct == null || input.estimatedProfit == null) {
    return [...tags, '毛利数据不足'];
  }
  return tags;
}

function buildMetrics(input: StoreProductAdviceInput): Record<string, unknown> {
  return {
    productClass: input.productClass,
    stockStatus: input.stockStatus,
    platformStock: input.stock,
    stockDays: input.stockDays,
    sales7: input.sales7,
    sales14: input.sales14,
    sales30: input.sales30,
    comprehensiveSales: input.comprehensiveSales,
    suggestAmount: input.suggestAmount,
    targetStock: input.targetStock,
    coverageStock: input.coverageStock,
    profitMarginPct: input.profitMarginPct,
    estimatedProfit: input.estimatedProfit,
    linkType: input.linkType,
    buyBoxStatus: input.buyBoxStatus,
    ruleVersion: OPERATION_ADVICE_ENGINE_RULES.ruleVersion,
  };
}

function collectCandidates(input: StoreProductAdviceInput): AdviceCandidate[] {
  const out: AdviceCandidate[] = [];
  const {
    productClass,
    newProductStage,
    stockStatus,
    stock,
    stockDays,
    sales7,
    sales14,
    sales30,
    comprehensiveSales,
    suggestAmount,
    targetStock,
    coverageStock,
    profitMarginPct,
    estimatedProfit,
    linkType,
    buyBoxStatus,
  } = input;

  const hasSales = hasRecentSales(input);
  const lowSales30 = sales30 <= OPERATION_ADVICE_ENGINE_RULES.lowSales30Threshold;
  const overstock = isOverstock(stockStatus, stockDays);

  if (isOwnLink(linkType) && buyBoxLost(buyBoxStatus) && stock > 0) {
    out.push({
      action: 'COMPLAIN_HIJACKER',
      title: '投诉跟卖',
      reason: '当前为自建或自有品牌链接、平台有可售库存但未获得购物车，建议核查跟卖并发起投诉。',
      score: 950,
      tags: ['链接安全', '购物车丢失', '投诉跟卖'],
      bucket: 'BUYBOX',
    });
  }

  if (isResellLink(linkType) && buyBoxLost(buyBoxStatus) && stock > 0 && lowSales30) {
    out.push({
      action: 'WIN_BUY_BOX',
      title: '抢购物车',
      reason: '跟卖链接未获得购物车，建议优化报价或促销以争取 Buy Box。',
      score: 900,
      tags: ['跟卖链接', '购物车丢失', '抢购物车'],
      bucket: 'BUYBOX',
    });
  }

  if (
    isSalesClass(productClass)
    && isLowOrOutStock(stockStatus)
    && hasSales
    && suggestAmount > 0
    && coverageStock < targetStock
  ) {
    out.push({
      action: 'URGENT_REPLENISH',
      title: '紧急补货',
      reason: '库存偏低或断货且近期有销量，采购建议量大于 0，在途/计划库存不足以覆盖目标库存。',
      score: 880,
      tags: ['缺货', '有销量', '紧急补货'],
      bucket: 'STOCKOUT',
    });
  }

  if (
    isSalesClass(productClass)
    && stock <= 0
    && hasSales
    && suggestAmount > 0
    && coverageStock < targetStock
  ) {
    out.push({
      action: 'URGENT_REPLENISH',
      title: '紧急补货',
      reason: '平台库存为 0 且近期仍有销量，建议优先安排补货避免继续丢单。',
      score: 870,
      tags: ['断货', '有销量', '紧急补货'],
      bucket: 'STOCKOUT',
    });
  }

  if (
    (isNewProduct(productClass) || newProductStage === 'NEW_WAITING_INBOUND')
    && stock <= 0
    && sales30 === 0
  ) {
    out.push({
      action: 'WAIT_FOR_ARRIVAL',
      title: '新品待入仓',
      reason: '新品暂无平台库存且近 30 天无销量，建议等待入仓或确认在途到货。',
      score: 860,
      tags: withProfitTag(input, ['新品', '待入仓']),
      bucket: 'NEW_PRODUCT',
    });
  }

  if (
    !isClearance(productClass)
    && profitMarginPct != null
    && profitMarginPct < OPERATION_ADVICE_ENGINE_RULES.lowProfitMarginPct
    && hasSales
  ) {
    out.push({
      action: 'RAISE_PROFIT',
      title: '提高毛利',
      reason: '毛利率偏低且产品有正常销售，建议复核成本与售价，优先提高毛利。',
      score: 750,
      tags: ['毛利偏低', '有销量', '提高毛利'],
      bucket: 'PROFIT',
    });
  }

  if (
    !isClearance(productClass)
    && isSalesTrendRising(sales7, sales14)
    && isLowOrOutStock(stockStatus)
    && coverageStock > 0
    && (profitMarginPct == null || profitMarginPct >= 0)
  ) {
    out.push({
      action: 'RAISE_PRICE_MODERATELY',
      title: '适度提价',
      reason: '销量趋势上涨且库存偏紧，已有在途可短期支撑，可考虑适度提价。',
      score: 620,
      tags: withProfitTag(input, ['趋势上涨', '库存偏紧', '适度提价']),
      bucket: 'PROFIT',
    });
  }

  if (
    overstock
    && !isClearance(productClass)
    && (isSalesTrendFalling(sales7, sales14) || sales30 === 0 || productClass === 'POTENTIAL')
  ) {
    out.push({
      action: 'JOIN_CAMPAIGN',
      title: '参与活动',
      reason: '库存偏多且销量趋势走弱，可报名平台活动加速动销。',
      score: 600,
      tags: withProfitTag(input, ['库存偏多', '趋势下降', '参与活动']),
      bucket: 'INVENTORY',
    });
  }

  appendClearanceHeavySlowMoverCandidates(out, input);

  if (isNewProduct(productClass) && stock > 0 && lowSales30) {
    out.push({
      action: 'ADJUST_ADS',
      title: '调整广告',
      reason: '新品有库存但无销量，建议创建广告或调整投放测试流量。',
      score: 520,
      tags: withProfitTag(input, ['新品', '低销量', '调整广告']),
      bucket: 'NEW_PRODUCT',
    });
  }

  if (
    isNewProduct(productClass)
    && stock > 0
    && lowSales30
    && profitMarginPct != null
    && profitMarginPct >= OPERATION_ADVICE_ENGINE_RULES.highProfitMarginPct
  ) {
    out.push({
      action: 'LOWER_PRICE',
      title: '降低价格',
      reason: '新品有库存但无销量，毛利率较高时可测试小幅降价验证转化。',
      score: 480,
      tags: withProfitTag(input, ['新品', '降价测试']),
      bucket: 'INVENTORY',
    });
  }

  if (isClearance(productClass) && overstock && suggestAmount <= 0 && !isClearanceHeavySlowMover(input)) {
    out.push({
      action: 'PAUSE_PURCHASE',
      title: '暂停采购',
      reason: '清理款库存偏多、动销差且采购建议量为 0，建议暂停继续采购。',
      score: 680,
      tags: withProfitTag(input, ['清理款', '暂停采购']),
      bucket: 'INVENTORY',
    });
  }

  if (
    estimatedProfit != null
    && estimatedProfit < 0
    && (productClass === 'HOT' || productClass === 'POTENTIAL')
    && sales30 > 0
    && !isClearance(productClass)
  ) {
    out.push({
      action: 'RAISE_PROFIT',
      title: '提高毛利',
      reason: '近期有销量但预估毛利为负，建议立即复核成本与售价。',
      score: 920,
      tags: ['负毛利', '有销量', '提高毛利'],
      bucket: 'PROFIT',
    });
  }

  return out;
}

function dedupeByAction(candidates: AdviceCandidate[]): AdviceCandidate[] {
  const seen = new Set<OperationAction>();
  const result: AdviceCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.action)) continue;
    seen.add(c.action);
    result.push(c);
  }
  return result;
}

function keepHigherScore(
  candidates: AdviceCandidate[],
  actionA: OperationAction,
  actionB: OperationAction,
): AdviceCandidate[] {
  const a = candidates.find((c) => c.action === actionA);
  const b = candidates.find((c) => c.action === actionB);
  if (!a || !b) return candidates;
  const drop = a.score >= b.score ? actionB : actionA;
  return candidates.filter((c) => c.action !== drop);
}

function capInventoryActions(
  candidates: AdviceCandidate[],
  max: number,
  preferClearanceOrder = false,
): AdviceCandidate[] {
  const inventory = candidates.filter((c) => INVENTORY_ACTIONS.includes(c.action));
  const others = candidates.filter((c) => !INVENTORY_ACTIONS.includes(c.action));
  if (inventory.length <= max) return candidates;
  const sorted = preferClearanceOrder
    ? [...inventory].sort((a, b) => {
      const orderDiff = (CLEARANCE_INVENTORY_ORDER[a.action] ?? 99)
        - (CLEARANCE_INVENTORY_ORDER[b.action] ?? 99);
      return orderDiff !== 0 ? orderDiff : b.score - a.score;
    })
    : [...inventory].sort((a, b) => b.score - a.score);
  const kept = sorted.slice(0, max);
  const keptActions = new Set(kept.map((c) => c.action));
  return [...others, ...inventory.filter((c) => keptActions.has(c.action))];
}

function sortByBucketAndScore(
  candidates: AdviceCandidate[],
  input: StoreProductAdviceInput,
): AdviceCandidate[] {
  const bucketOrder: Record<AdviceBucket, number> = {
    BUYBOX: 0,
    STOCKOUT: 1,
    PROFIT: 2,
    INVENTORY: 3,
    NEW_PRODUCT: 4,
    OBSERVE: 5,
  };
  return [...candidates].sort((a, b) => {
    const orderDiff = bucketOrder[a.bucket] - bucketOrder[b.bucket];
    if (orderDiff !== 0) return orderDiff;
    if (
      isClearance(input.productClass)
      && a.bucket === 'INVENTORY'
      && b.bucket === 'INVENTORY'
      && CLEARANCE_INVENTORY_ACTIONS.includes(a.action)
      && CLEARANCE_INVENTORY_ACTIONS.includes(b.action)
    ) {
      const actionOrder = (CLEARANCE_INVENTORY_ORDER[a.action] ?? 99)
        - (CLEARANCE_INVENTORY_ORDER[b.action] ?? 99);
      if (actionOrder !== 0) return actionOrder;
    }
    return b.score - a.score;
  });
}

function resolveConflicts(candidates: AdviceCandidate[], input: StoreProductAdviceInput): AdviceCandidate[] {
  let list = [...candidates];
  const isClearanceProduct = isClearance(input.productClass);
  const isNewNoStock = isNewProduct(input.productClass) && input.stock <= 0 && input.sales30 === 0;
  if (isClearanceProduct) {
    list = list.filter((c) => c.action !== 'RAISE_PROFIT' && c.action !== 'RAISE_PRICE_MODERATELY');
  }

  if (isNewNoStock || input.newProductStage === 'NEW_WAITING_INBOUND') {
    list = list.filter((c) => (
      c.action !== 'CREATE_AD'
      && c.action !== 'INCREASE_CPC'
      && c.action !== 'ADJUST_ADS'
      && c.action !== 'LOWER_PRICE'
    ));
  }

  list = keepHigherScore(list, 'RAISE_PROFIT', 'RAISE_PRICE_MODERATELY');

  const clearanceHeavy = isClearanceHeavySlowMover(input);
  list = capInventoryActions(list, clearanceHeavy ? 4 : 2, clearanceHeavy);

  list = dedupeByAction(list);
  return sortByBucketAndScore(list, input);
}

function defaultObserve(input: StoreProductAdviceInput): AdviceCandidate {
  return {
    action: 'OBSERVE',
    title: '继续观察',
    reason: '暂无明显强运营动作，持续观察销售、库存、毛利与购物车变化。',
    score: 100,
    tags: withProfitTag(input, ['持续观察']),
    bucket: 'OBSERVE',
  };
}

export function generateOperationAdvices(input: StoreProductAdviceInput): OperationAdvice[] {
  const metrics = buildMetrics(input);
  let candidates = resolveConflicts(collectCandidates(input), input);

  if (candidates.length === 0) {
    candidates = [defaultObserve(input)];
  }

  return candidates.slice(0, OPERATION_ADVICE_ENGINE_RULES.maxAdvices).map((c, idx) => ({
    priority: `P${idx + 1}` as OperationPriority,
    action: c.action,
    title: c.title,
    reason: c.reason,
    score: c.score,
    tags: c.tags,
    metrics,
  }));
}

export const OPERATION_ACTION_FILTERS: readonly OperationAction[] = [
  'URGENT_REPLENISH',
  'RAISE_PROFIT',
  'RAISE_PRICE_MODERATELY',
  'JOIN_CAMPAIGN',
  'COMPLAIN_HIJACKER',
  'WIN_BUY_BOX',
  'ADJUST_ADS',
  'LOWER_PRICE',
  'WAIT_FOR_ARRIVAL',
  'PAUSE_PURCHASE',
  'OBSERVE',
  'CREATE_AD',
  'INCREASE_CPC',
  'ADVERTISE',
];

const AD_ACTION_FAMILY: OperationAction[] = ['ADJUST_ADS', 'CREATE_AD', 'INCREASE_CPC', 'ADVERTISE'];

export function isOperationActionFilter(value: string): value is OperationAction {
  return (OPERATION_ACTION_FILTERS as readonly string[]).includes(value);
}

/** undefined=未传；null=非法值 */
export function normalizeOperationActionQuery(raw: unknown): OperationAction | null | undefined {
  if (raw == null) return undefined;
  const normalized = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!normalized || normalized.toLowerCase() === 'all') return undefined;
  const upper = normalized.toUpperCase();
  if (!isOperationActionFilter(upper)) return null;
  return upper;
}

export function matchesOperationAction(advices: OperationAdvice[], action: OperationAction): boolean {
  if (action === 'ADJUST_ADS') {
    return advices.some((a) => AD_ACTION_FAMILY.includes(a.action));
  }
  return advices.some((a) => a.action === action);
}

export type OperationActionStatItem = {
  action: OperationAction;
  label: string;
  count: number;
};

export const OPERATION_ACTION_LABELS: Record<OperationAction, string> = {
  COMPLAIN_HIJACKER: '投诉跟卖',
  WIN_BUY_BOX: '抢购物车',
  URGENT_REPLENISH: '紧急补货',
  LOWER_PRICE: '降低价格',
  JOIN_CAMPAIGN: '参与活动',
  ADJUST_ADS: '调整广告',
  PAUSE_PURCHASE: '暂停采购',
  RAISE_PROFIT: '提高毛利',
  RAISE_PRICE_MODERATELY: '适度提价',
  WAIT_FOR_ARRIVAL: '新品待入仓',
  OBSERVE: '继续观察',
  CREATE_AD: '调整广告',
  INCREASE_CPC: '调整广告',
  ADVERTISE: '调整广告',
};

export const OPERATION_ACTION_STAT_ORDER: OperationAction[] = [
  'COMPLAIN_HIJACKER',
  'WIN_BUY_BOX',
  'URGENT_REPLENISH',
  'LOWER_PRICE',
  'JOIN_CAMPAIGN',
  'ADJUST_ADS',
  'PAUSE_PURCHASE',
  'RAISE_PROFIT',
  'RAISE_PRICE_MODERATELY',
  'WAIT_FOR_ARRIVAL',
  'OBSERVE',
];

/** 统计口径：广告族动作统一归并为 ADJUST_ADS */
export function normalizeActionForStats(action: OperationAction | string): OperationAction {
  const upper = String(action).toUpperCase() as OperationAction;
  if ((AD_ACTION_FAMILY as readonly string[]).includes(upper)) {
    return 'ADJUST_ADS';
  }
  return upper;
}

/** 纯函数：汇总候选产品的运营动作命中数（每产品每 action 只计 1 次） */
export function buildOperationActionStats(advicesList: OperationAdvice[][]): OperationActionStatItem[] {
  const countMap = new Map<OperationAction, number>();

  for (const advices of advicesList) {
    const seen = new Set<OperationAction>();
    for (const a of advices) {
      const canonical = normalizeActionForStats(a.action);
      if (!OPERATION_ACTION_STAT_ORDER.includes(canonical)) continue;
      seen.add(canonical);
    }
    for (const action of seen) {
      countMap.set(action, (countMap.get(action) ?? 0) + 1);
    }
  }

  const statOrderSet = new Set(OPERATION_ACTION_STAT_ORDER);
  const result: OperationActionStatItem[] = [];
  for (const [action, count] of countMap.entries()) {
    if (count <= 0 || !statOrderSet.has(action)) continue;
    result.push({
      action,
      label: OPERATION_ACTION_LABELS[action],
      count,
    });
  }

  result.sort((a, b) => {
    const rankA = OPERATION_ACTION_STAT_ORDER.indexOf(a.action);
    const rankB = OPERATION_ACTION_STAT_ORDER.indexOf(b.action);
    if (rankA !== rankB) return rankA - rankB;
    return b.count - a.count;
  });

  return result;
}
