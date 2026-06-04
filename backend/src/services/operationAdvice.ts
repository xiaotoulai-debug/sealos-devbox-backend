import type { ProductClass, StockStatus } from './productClassification';

export type OperationPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type OperationAction =
  | 'REPLENISH_NOW'
  | 'URGENT_REPLENISH'
  | 'STILL_NEED_REPLENISH'
  | 'RAISE_PRICE'
  | 'LOWER_PRICE'
  | 'JOIN_CAMPAIGN'
  | 'ADVERTISE'
  | 'CLEARANCE'
  | 'PAUSE_PURCHASE'
  | 'WAIT_FOR_ARRIVAL'
  | 'OBSERVE';

export interface OperationAdvice {
  priority: OperationPriority;
  action: OperationAction;
  title: string;
  reason: string;
  tags: string[];
  metrics: Record<string, unknown>;
}

export type BuildOperationAdviceInput = {
  productClass: ProductClass;
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
  sales60?: number;
  sales90: number;
  sales180: number;
  lastOrderAt: Date | null;
  daysSinceLastOrder: number | null;
  comprehensiveSales: number;
  replenishReferenceDailySales: number;
  targetStock: number;
  coverageStock: number;
  suggestAmount: number;
  estimatedProfit: number | null;
  profitMarginPct: number | null;
  price: number | null;
  daysSinceSynced: number;
};

export const OPERATION_ADVICE_RULES = {
  lowProfitMarginPct: 15,
  goodProfitMarginPct: 25,
  lowStockDays: 30,
  warningStockDays: 60,
  overstockDays: 120,
  clearanceStockThreshold: 10,
} as const;

const RULES_VERSION = 'v1';

function buildMetrics(input: BuildOperationAdviceInput): Record<string, unknown> {
  return {
    productClass: input.productClass,
    stockStatus: input.stockStatus,
    stock: input.stock,
    stockDays: input.stockDays,
    platformInTransit: input.platformInTransit,
    localStock: input.localStock,
    purchasingInTransit: input.purchasingInTransit,
    planningStock: input.planningStock,
    sales7: input.sales7,
    sales14: input.sales14,
    sales30: input.sales30,
    sales60: input.sales60 ?? null,
    sales90: input.sales90,
    sales180: input.sales180,
    lastOrderAt: input.lastOrderAt ? input.lastOrderAt.toISOString() : null,
    daysSinceLastOrder: input.daysSinceLastOrder,
    comprehensiveSales: input.comprehensiveSales,
    replenishReferenceDailySales: input.replenishReferenceDailySales,
    targetStock: input.targetStock,
    coverageStock: input.coverageStock,
    suggestAmount: input.suggestAmount,
    estimatedProfit: input.estimatedProfit,
    profitMarginPct: input.profitMarginPct,
    price: input.price,
    daysSinceSynced: input.daysSinceSynced,
    rulesVersion: RULES_VERSION,
  };
}

function withProfitDataTag(input: BuildOperationAdviceInput, tags: string[]): string[] {
  if (input.profitMarginPct == null || input.estimatedProfit == null) {
    return [...tags, '毛利数据不足'];
  }
  return tags;
}

function isWeakSalesClass(productClass: ProductClass): boolean {
  return productClass === 'CLEARANCE';
}

function isSalesClass(productClass: ProductClass): boolean {
  return productClass === 'HOT' || productClass === 'POTENTIAL';
}

export function buildOperationAdvice(input: BuildOperationAdviceInput): OperationAdvice {
  const metrics = buildMetrics(input);
  const {
    productClass,
    stockStatus,
    stock,
    platformInTransit,
    localStock,
    purchasingInTransit,
    planningStock,
    sales30,
    replenishReferenceDailySales,
    targetStock,
    coverageStock,
    comprehensiveSales,
    suggestAmount,
    estimatedProfit,
    profitMarginPct,
  } = input;

  const hasReplenishDemand = stock === 0 && replenishReferenceDailySales > 0;

  if (
    estimatedProfit != null &&
    estimatedProfit < 0 &&
    isSalesClass(productClass) &&
    sales30 > 0
  ) {
    return {
      priority: 'P0',
      action: 'RAISE_PRICE',
      title: '负毛利动销，优先调价',
      reason: '该产品近期有销量但预估毛利为负，建议立即复核成本和售价，优先调高价格或暂停低价活动。',
      tags: ['负毛利', '有销量', '优先处理'],
      metrics,
    };
  }

  if (hasReplenishDemand && coverageStock <= 0 && replenishReferenceDailySales >= 1) {
    return {
      priority: 'P0',
      action: 'REPLENISH_NOW',
      title: '立即补货',
      reason: '该产品当前平台库存为 0，且历史/近期销量较好，当前无足够在途或计划库存，建议立即补货。',
      tags: ['缺货', '有销量', '优先补货'],
      metrics,
    };
  }

  if (hasReplenishDemand && coverageStock <= 0) {
    return {
      priority: 'P1',
      action: 'URGENT_REPLENISH',
      title: '紧急补货',
      reason: '该产品当前平台库存为 0，但历史/近期仍有销量，建议优先安排补货，避免继续丢单。',
      tags: ['断货观察', '有销量', '紧急补货'],
      metrics,
    };
  }

  if (hasReplenishDemand && coverageStock > 0 && coverageStock < targetStock) {
    return {
      priority: 'P1',
      action: 'STILL_NEED_REPLENISH',
      title: '仍需补货',
      reason: '该产品虽然已有部分在途或计划库存，但按历史销量测算仍不足，建议继续补货。',
      tags: ['在途不足', '有销量', '继续补货'],
      metrics,
    };
  }

  if (hasReplenishDemand && coverageStock >= targetStock) {
    return {
      priority: 'P2',
      action: 'WAIT_FOR_ARRIVAL',
      title: '等待到货',
      reason: '当前平台无库存，但已有库存保障覆盖目标库存，建议等待到货并观察销售恢复情况。',
      tags: ['缺货', '已有在途', '等待到货'],
      metrics,
    };
  }

  if (
    isWeakSalesClass(productClass) &&
    stock >= OPERATION_ADVICE_RULES.clearanceStockThreshold &&
    sales30 === 0
  ) {
    return {
      priority: 'P1',
      action: 'CLEARANCE',
      title: '清仓处理',
      reason: '产品销量弱且存在库存压力，建议清仓回收资金。',
      tags: withProfitDataTag(input, ['销量弱', '库存压力', '回收资金']),
      metrics,
    };
  }

  if (isWeakSalesClass(productClass) && suggestAmount <= 0) {
    return {
      priority: 'P1',
      action: 'PAUSE_PURCHASE',
      title: '暂停采购',
      reason: '当前产品销量弱或待淘汰，建议暂停采购，避免继续占用资金。',
      tags: withProfitDataTag(input, ['销量弱', '暂停采购', '资金占用']),
      metrics,
    };
  }

  if (stock === 0 && (platformInTransit + purchasingInTransit + planningStock + localStock) > 0) {
    return {
      priority: 'P2',
      action: 'WAIT_FOR_ARRIVAL',
      title: '等待到货',
      reason: '当前平台无库存但已有在途，建议等待到货后再观察销售表现。',
      tags: withProfitDataTag(input, ['平台无库存', '已有在途', '等待到货']),
      metrics,
    };
  }

  if (
    isSalesClass(productClass) &&
    comprehensiveSales > 0 &&
    (stockStatus === 'LOW_STOCK' || stockStatus === 'WARNING' || stockStatus === 'OUT_OF_STOCK') &&
    profitMarginPct != null &&
    profitMarginPct < OPERATION_ADVICE_RULES.lowProfitMarginPct
  ) {
    return {
      priority: 'P1',
      action: 'RAISE_PRICE',
      title: '建议涨价',
      reason: '销量表现较好，但库存偏紧且毛利率偏低，可考虑小幅涨价。',
      tags: ['销量较好', '库存偏紧', '毛利偏低'],
      metrics,
    };
  }

  if (
    stock > 0 &&
    sales30 === 0 &&
    (productClass === 'CLEARANCE' || productClass === 'NORMAL')
  ) {
    return {
      priority: 'P2',
      action: 'LOWER_PRICE',
      title: '建议降价',
      reason: '当前有库存但近期销量弱，可测试降价提升转化。',
      tags: withProfitDataTag(input, ['有库存', '近期无销量', '降价测试']),
      metrics,
    };
  }

  if (
    profitMarginPct != null &&
    profitMarginPct >= OPERATION_ADVICE_RULES.goodProfitMarginPct &&
    (stockStatus === 'SAFE' || stockStatus === 'OVERSTOCK') &&
    (productClass === 'POTENTIAL' || productClass === 'NORMAL') &&
    sales30 > 0
  ) {
    return {
      priority: 'P2',
      action: 'ADVERTISE',
      title: '加广告',
      reason: '毛利空间较好且库存充足，可小预算测试广告放量。',
      tags: ['毛利较好', '库存充足', '小预算测试'],
      metrics,
    };
  }

  if (
    profitMarginPct != null &&
    profitMarginPct >= OPERATION_ADVICE_RULES.goodProfitMarginPct &&
    stock > 0 &&
    sales30 === 0 &&
    productClass !== 'HOT'
  ) {
    return {
      priority: 'P2',
      action: 'JOIN_CAMPAIGN',
      title: '参加活动',
      reason: '库存充足且毛利允许，可报名平台活动测试转化。',
      tags: ['毛利允许', '有库存', '活动测试'],
      metrics,
    };
  }

  return {
    priority: 'P3',
    action: 'OBSERVE',
    title: '观察即可',
    reason: '暂无明显运营动作，持续观察销售、库存和毛利变化。',
    tags: withProfitDataTag(input, ['持续观察']),
    metrics,
  };
}
