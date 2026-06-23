import type { EmagLinkType } from './emagLinkType';
import type { BuyBoxStatus } from './emagBuyBox';
import {
  generateOperationAdvices,
  OPERATION_ADVICE_ENGINE_RULES,
  type OperationAdvice,
  type OperationAction,
  type OperationPriority,
  type StoreProductAdviceInput,
} from './operationAdviceEngine';

export type {
  OperationAdvice,
  OperationAction,
  OperationPriority,
  StoreProductAdviceInput,
};

export { generateOperationAdvices };

/** @deprecated 兼容旧引用，阈值以 v2 引擎为准 */
export const OPERATION_ADVICE_RULES = {
  lowProfitMarginPct: OPERATION_ADVICE_ENGINE_RULES.lowProfitMarginPct,
  goodProfitMarginPct: 25,
  lowStockDays: 30,
  warningStockDays: 60,
  overstockDays: 120,
  clearanceStockThreshold: OPERATION_ADVICE_ENGINE_RULES.clearanceStockThreshold,
} as const;

export type BuildOperationAdviceInput = Omit<StoreProductAdviceInput, 'linkType' | 'buyBoxStatus'> & {
  sales60?: number;
  sales90: number;
  sales180: number;
  lastOrderAt: Date | null;
  daysSinceLastOrder: number | null;
  linkType?: EmagLinkType;
  buyBoxStatus?: BuyBoxStatus;
};

function toEngineInput(input: BuildOperationAdviceInput): StoreProductAdviceInput {
  return {
    productClass: input.productClass,
    newProductStage: input.newProductStage,
    replenishmentStage: input.replenishmentStage,
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
    comprehensiveSales: input.comprehensiveSales,
    replenishReferenceDailySales: input.replenishReferenceDailySales,
    targetStock: input.targetStock,
    coverageStock: input.coverageStock,
    suggestAmount: input.suggestAmount,
    estimatedProfit: input.estimatedProfit,
    profitMarginPct: input.profitMarginPct,
    price: input.price,
    linkType: input.linkType ?? 'UNKNOWN',
    buyBoxStatus: input.buyBoxStatus ?? 'UNKNOWN',
    numberOfOffers: input.numberOfOffers,
    daysSinceSynced: input.daysSinceSynced,
  };
}

/** 薄包装：返回多条建议中的第一条（兼容旧单条调用方） */
export function buildOperationAdvice(input: BuildOperationAdviceInput): OperationAdvice {
  return generateOperationAdvices(toEngineInput(input))[0];
}
