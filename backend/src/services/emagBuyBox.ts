export type BuyBoxStatus =
  | 'WON'
  | 'LOST'
  | 'UNKNOWN'
  | 'NO_ACTIVE_BUYBOX'
  | 'POSSIBLY_WON'
  | 'POSSIBLY_LOST';

export type BuyBoxStatusSource = 'BUY_BUTTON_RANK' | 'PRICE_HEURISTIC' | 'OFFER_STATE' | 'UNKNOWN';
export type BuyBoxStatusConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type BuyBoxInferenceInput = {
  buyButtonRank?: unknown;
  salePrice?: unknown;
  bestOfferSalePrice?: unknown;
  mainOfferPrice?: unknown;
  stock?: unknown;
  status?: unknown;
  offerValidationStatus?: unknown;
  numberOfOffers?: unknown;
};

export type BuyBoxInferenceResult = {
  buyBoxStatus: BuyBoxStatus;
  buyBoxStatusLabel: string;
  buyBoxStatusSource: BuyBoxStatusSource;
  buyBoxStatusConfidence: BuyBoxStatusConfidence;
  buyBoxRank: number | null;
  buyBoxActionTips: string[];
};

export const BUY_BOX_STATUS_LABELS: Record<BuyBoxStatus, string> = {
  WON: '购物车已抢到',
  LOST: '未抢购物车',
  UNKNOWN: '购物车未知',
  NO_ACTIVE_BUYBOX: '无有效购物车',
  POSSIBLY_WON: '疑似抢到购物车',
  POSSIBLY_LOST: '疑似未抢购物车',
};

const BUY_BOX_ACTION_TIPS: Record<BuyBoxStatus, string[]> = {
  WON: ['保持价格', '稳定库存', '保持排名'],
  LOST: ['检查售价', '优化配送', '调整库存', '争取购物车'],
  NO_ACTIVE_BUYBOX: ['检查库存', '恢复报价', '确认商品状态'],
  UNKNOWN: ['人工核查', '打开前台链接', '等待接口字段'],
  POSSIBLY_WON: ['人工核查', '保持价格', '观察前台'],
  POSSIBLY_LOST: ['人工核查', '检查售价', '对比竞品报价'],
};

function toNullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getValidationValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const current = getValidationValue(item);
      if (current != null) return current;
    }
    return null;
  }

  if (typeof value === 'object' && value) {
    return (value as any).value ?? (value as any).status ?? (value as any).code ?? null;
  }

  return value;
}

export function normalizeBuyButtonRank(value: unknown): number | null {
  const rank = toNullableNumber(value);
  if (rank == null || rank <= 0) return null;
  return Math.trunc(rank);
}

export function isOfferSellable(input: BuyBoxInferenceInput): boolean {
  const status = toNullableNumber(input.status);
  if (status === 0) return false;

  const validationValue = getValidationValue(input.offerValidationStatus);
  if (validationValue === 0 || validationValue === '0' || validationValue === 8 || validationValue === '8') {
    return false;
  }

  const validationText = typeof input.offerValidationStatus === 'string'
    ? input.offerValidationStatus.toLowerCase()
    : typeof input.offerValidationStatus === 'object' && input.offerValidationStatus
      ? String((input.offerValidationStatus as any).description ?? '').toLowerCase()
      : '';

  if (validationText.includes('not saleable') || validationText.includes('inactive') || validationText.includes('rejected')) {
    return false;
  }

  return true;
}

function isSamePrice(left: unknown, right: unknown): boolean {
  const l = toNullableNumber(left);
  const r = toNullableNumber(right);
  if (l == null || r == null) return false;
  return Math.abs(l - r) < 0.005;
}

export function inferBuyBoxActionTips(status: BuyBoxStatus): string[] {
  return BUY_BOX_ACTION_TIPS[status];
}

function result(
  buyBoxStatus: BuyBoxStatus,
  buyBoxStatusSource: BuyBoxStatusSource,
  buyBoxStatusConfidence: BuyBoxStatusConfidence,
  buyBoxRank: number | null,
): BuyBoxInferenceResult {
  return {
    buyBoxStatus,
    buyBoxStatusLabel: BUY_BOX_STATUS_LABELS[buyBoxStatus],
    buyBoxStatusSource,
    buyBoxStatusConfidence,
    buyBoxRank,
    buyBoxActionTips: inferBuyBoxActionTips(buyBoxStatus),
  };
}

export function inferBuyBoxStatus(input: BuyBoxInferenceInput): BuyBoxInferenceResult {
  const rank = normalizeBuyButtonRank(input.buyButtonRank);
  const stock = toNullableNumber(input.stock) ?? 0;

  if (!isOfferSellable(input) || stock <= 0) {
    return result('NO_ACTIVE_BUYBOX', 'OFFER_STATE', 'HIGH', rank);
  }

  if (rank === 1) {
    return result('WON', 'BUY_BUTTON_RANK', 'HIGH', 1);
  }

  if (rank != null && rank > 1) {
    return result('LOST', 'BUY_BUTTON_RANK', 'HIGH', rank);
  }

  if (isSamePrice(input.salePrice, input.bestOfferSalePrice)) {
    return result('POSSIBLY_WON', 'PRICE_HEURISTIC', 'LOW', null);
  }

  const numberOfOffers = toNullableNumber(input.numberOfOffers);
  if (numberOfOffers != null && numberOfOffers > 1 && !isSamePrice(input.salePrice, input.bestOfferSalePrice)) {
    return result('POSSIBLY_LOST', 'PRICE_HEURISTIC', 'LOW', null);
  }

  return result('UNKNOWN', 'UNKNOWN', 'LOW', null);
}
