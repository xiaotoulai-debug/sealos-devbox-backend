import { PRICE_ERROR_CODES, type PriceErrorCode } from './priceErrors';

export type CostStatus =
  | 'COMPLETE'
  | 'ESTIMATED'
  | 'MISSING_COST'
  | 'MISSING_COMMISSION'
  | 'MISSING_LOGISTICS'
  | 'MISSING_VAT';

export const DEFAULT_PRICE_STRATEGY = {
  targetMinMarginPct: 0.10,
  safetyBufferPct: 0.02,
  grabStep: 0.1,
  manualPriceAllowEstimatedCost: true,
  grabCartAllowEstimatedCost: false,
};

export interface CalculateMinPricesInput {
  purchaseCost: number | null;
  logisticsCost: number | null;
  otherFixedCost?: number | null;
  commissionRate: number | null;
  returnLossRate?: number | null;
  safetyBufferPct?: number | null;
  targetMinMarginPct?: number | null;
  manualMinPrice?: number | null;
}

export interface CalculateMinPricesResult {
  hardFloorPrice: number | null;
  suggestedMinPrice: number | null;
  manualMinPrice: number | null;
  finalMinPrice: number | null;
  warnings: string[];
  blockCode?: PriceErrorCode;
}

export interface CalculateCostStatusInput {
  purchaseCost: number | null;
  logisticsCost: number | null;
  commissionRate: number | null;
  vatRate: number | null;
  hasAnyLogisticsDimension?: boolean;
  hasCompleteLogisticsDimensions?: boolean;
  isEstimatedLogistics?: boolean;
  isEstimatedFbeFee?: boolean;
  isEstimatedCommission?: boolean;
  isEstimatedVat?: boolean;
}

export interface CalculateCostStatusResult {
  costStatus: CostStatus;
  warnings: string[];
  purchaseCost: number | null;
  logisticsCost: number | null;
  commissionRate: number | null;
  vatRate: number | null;
}

function toFiniteOrNull(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Number.isFinite(value) ? value : null;
}

export function roundPrice(value: number, digits = 4): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export function calculateMinPrices(input: CalculateMinPricesInput): CalculateMinPricesResult {
  const warnings: string[] = [];
  const purchaseCost = toFiniteOrNull(input.purchaseCost);
  const logisticsCost = toFiniteOrNull(input.logisticsCost);
  const commissionRate = toFiniteOrNull(input.commissionRate);
  const returnLossRate = toFiniteOrNull(input.returnLossRate) ?? 0;
  const safetyBufferPct = toFiniteOrNull(input.safetyBufferPct) ?? DEFAULT_PRICE_STRATEGY.safetyBufferPct;
  const targetMinMarginPct = toFiniteOrNull(input.targetMinMarginPct) ?? DEFAULT_PRICE_STRATEGY.targetMinMarginPct;
  const manualMinPrice = toFiniteOrNull(input.manualMinPrice);
  const otherFixedCost = toFiniteOrNull(input.otherFixedCost) ?? 0;

  if (purchaseCost == null || purchaseCost < 0) {
    return { hardFloorPrice: null, suggestedMinPrice: null, manualMinPrice, finalMinPrice: null, warnings: ['缺少采购成本'], blockCode: PRICE_ERROR_CODES.MISSING_COST };
  }
  if (logisticsCost == null || logisticsCost < 0) {
    return { hardFloorPrice: null, suggestedMinPrice: null, manualMinPrice, finalMinPrice: null, warnings: ['缺少物流成本'], blockCode: PRICE_ERROR_CODES.MISSING_LOGISTICS };
  }
  if (commissionRate == null || commissionRate < 0) {
    return { hardFloorPrice: null, suggestedMinPrice: null, manualMinPrice, finalMinPrice: null, warnings: ['缺少佣金率'], blockCode: PRICE_ERROR_CODES.MISSING_COMMISSION };
  }

  const fixedCost = purchaseCost + logisticsCost + otherFixedCost;
  const hardFloorDenominator = 1 - commissionRate - returnLossRate - safetyBufferPct;
  const suggestedDenominator = hardFloorDenominator - targetMinMarginPct;

  if (hardFloorDenominator <= 0 || suggestedDenominator <= 0) {
    return {
      hardFloorPrice: null,
      suggestedMinPrice: null,
      manualMinPrice,
      finalMinPrice: null,
      warnings: ['价格保护分母小于等于 0，请检查佣金率、退货损耗率、安全缓冲和目标毛利率'],
      blockCode: PRICE_ERROR_CODES.BELOW_HARD_FLOOR,
    };
  }

  const hardFloorPrice = roundPrice(fixedCost / hardFloorDenominator);
  const suggestedMinPrice = roundPrice(fixedCost / suggestedDenominator);

  if (manualMinPrice != null && manualMinPrice < hardFloorPrice) {
    return {
      hardFloorPrice,
      suggestedMinPrice,
      manualMinPrice,
      finalMinPrice: null,
      warnings: [`手动最低保护价 ${manualMinPrice} 低于硬底价 ${hardFloorPrice}`],
      blockCode: PRICE_ERROR_CODES.BELOW_HARD_FLOOR,
    };
  }

  const finalMinPrice = roundPrice(Math.max(hardFloorPrice, suggestedMinPrice, manualMinPrice ?? 0));
  return { hardFloorPrice, suggestedMinPrice, manualMinPrice, finalMinPrice, warnings };
}

export function calculateCostStatus(input: CalculateCostStatusInput): CalculateCostStatusResult {
  const warnings: string[] = [];
  const purchaseCost = toFiniteOrNull(input.purchaseCost);
  const logisticsCost = toFiniteOrNull(input.logisticsCost);
  const commissionRate = toFiniteOrNull(input.commissionRate);
  const vatRate = toFiniteOrNull(input.vatRate);

  if (purchaseCost == null || purchaseCost <= 0) {
    return { costStatus: 'MISSING_COST', warnings: ['缺少采购成本'], purchaseCost, logisticsCost, commissionRate, vatRate };
  }
  if (commissionRate == null || commissionRate < 0) {
    return { costStatus: 'MISSING_COMMISSION', warnings: ['缺少佣金率'], purchaseCost, logisticsCost, commissionRate, vatRate };
  }
  if (vatRate == null || vatRate <= 0) {
    return { costStatus: 'MISSING_VAT', warnings: ['无法确认 VAT 税率'], purchaseCost, logisticsCost, commissionRate, vatRate };
  }
  if (logisticsCost == null || logisticsCost < 0 || input.hasAnyLogisticsDimension === false) {
    return { costStatus: 'MISSING_LOGISTICS', warnings: ['缺少重量和体积信息，无法计算物流成本'], purchaseCost, logisticsCost, commissionRate, vatRate };
  }

  if (input.hasCompleteLogisticsDimensions === false) warnings.push('重量或体积信息不完整，物流成本为估算');
  if (input.isEstimatedLogistics) warnings.push('物流成本使用估算值');
  if (input.isEstimatedFbeFee) warnings.push('FBE 费用使用默认值估算');
  if (input.isEstimatedCommission) warnings.push('佣金率来自字典或默认配置');
  if (input.isEstimatedVat) warnings.push('VAT 税率来自默认配置');

  return {
    costStatus: warnings.length > 0 ? 'ESTIMATED' : 'COMPLETE',
    warnings,
    purchaseCost,
    logisticsCost,
    commissionRate,
    vatRate,
  };
}

export function estimateProfitAfterPrice(input: {
  salePriceExVat: number;
  purchaseCost: number | null;
  logisticsCost: number | null;
  commissionRate: number | null;
  returnLossRate?: number | null;
  otherFixedCost?: number | null;
}): { estimatedProfitAfter: number | null; profitMarginPctAfter: number | null } {
  const salePrice = toFiniteOrNull(input.salePriceExVat);
  const purchaseCost = toFiniteOrNull(input.purchaseCost);
  const logisticsCost = toFiniteOrNull(input.logisticsCost);
  const commissionRate = toFiniteOrNull(input.commissionRate);
  if (salePrice == null || salePrice <= 0 || purchaseCost == null || logisticsCost == null || commissionRate == null) {
    return { estimatedProfitAfter: null, profitMarginPctAfter: null };
  }

  const returnLossRate = toFiniteOrNull(input.returnLossRate) ?? 0;
  const otherFixedCost = toFiniteOrNull(input.otherFixedCost) ?? 0;
  const profit = salePrice * (1 - commissionRate - returnLossRate) - purchaseCost - logisticsCost - otherFixedCost;
  return {
    estimatedProfitAfter: roundPrice(profit),
    profitMarginPctAfter: salePrice > 0 ? roundPrice((profit / salePrice) * 100) : null,
  };
}
