import { prisma } from '../lib/prisma';
import {
  releaseShopPriceSlot,
  releaseStoreProductPriceLock,
  tryAcquireShopPriceSlot,
  tryAcquireStoreProductPriceLock,
} from '../lib/priceLocks';
import { DEFAULT_COMMISSION_RATE } from '../config/commissionMap';
import { guessCommissionRate } from '../utils/commissionMatcher';
import { emagApiCall, getEmagCredentials } from './emagClient';
import { isOfferSellable } from './emagBuyBox';
import { readProductOffers } from './emagProduct';
import { loadExchangeRateMap } from './exchangeRateSync';
import { calcHeadFreightCny } from './freightCalculator';
import {
  createPriceAdjustmentLog,
  markPriceAdjustmentFailed,
  markPriceAdjustmentPendingVerify,
  markPriceAdjustmentSkipped,
  markPriceAdjustmentSuccess,
  mergeSaveAndReadBackEmagResponse,
} from './priceAdjustmentLogs';
import { recalcProfitForStoreProducts } from './profitCalculator';
import {
  calculateCostStatus,
  calculateMinPrices,
  DEFAULT_PRICE_STRATEGY,
  estimateProfitAfterPrice,
  roundPrice,
  type CostStatus,
} from './priceProtection';
import { PRICE_ERROR_CODES, PRICE_ERROR_MESSAGES, type PriceErrorCode } from './priceErrors';

export interface BuildPriceUpdatePayloadInput {
  emagOfferId: string | number;
  newSalePriceExVat: number;
  vatId?: number | null;
}

export interface PriceUpdatePayloadItem {
  id: number;
  sale_price: number;
  vat_id?: number;
}

type FreshOfferForPriceCheck = {
  storeProductId: number;
  shopId: number;
  pnk: string | null;
  emagOfferId: string | null;
  currentSalePriceExVat: number | null;
  currency: string | null;
  status: number | null;
  validationStatus: string | null;
  offerValidationStatus?: unknown;
  stock: number | null;
  buyButtonRank?: number | null;
  bestOfferSalePrice?: number | null;
  mainOfferPrice?: number | null;
  numberOfOffers?: number | null;
  vatId?: number | null;
  vatRate?: number | null;
  raw?: unknown;
};

type Eligibility = {
  code: PriceErrorCode | 'OK';
  message: string;
};

export type PriceActionEligibility = Eligibility & {
  canChangePrice: boolean;
};

export type GrabCartEligibility = Eligibility & {
  canGrab: boolean;
};

type PriceStrategy = {
  targetMinMarginPct: number;
  safetyBufferPct: number;
  grabStep: number;
  defaultVatRate: number | null;
  defaultCommissionRate: number | null;
  returnLossRate: number | null;
  manualPriceAllowEstimatedCost: boolean;
  grabCartAllowEstimatedCost: boolean;
  isPriceChangePaused: boolean;
  isGrabCartPaused: boolean;
};

type PriceContext = {
  storeProduct: {
    id: number;
    shopId: number;
    pnk: string;
    name: string;
    mappedInventorySku: string | null;
    emagOfferId: string | null;
    salePrice: number;
    currency: string | null;
    stock: number;
    status: number;
    validationStatus: string | null;
    emagLinkType: string | null;
    buyBoxStatus: string | null;
    buyButtonRank: number | null;
    commissionRate: number | null;
    vatId: number | null;
    vatRate: number | null;
    manualMinPrice: number | null;
  };
  fresh: FreshOfferForPriceCheck;
  strategy: PriceStrategy;
  cost: ReturnType<typeof calculateCostStatus>;
  minPrices: ReturnType<typeof calculateMinPrices>;
  returnLossRate: number;
  rawLocalCost: {
    purchaseCost: number | null;
    logisticsCost: number | null;
    commissionRate: number | null;
    vatRate: number | null;
  };
};

export type PricePreviewResult = {
  priceActionEligibility: PriceActionEligibility;
  currentSalePriceExVat: number | null;
  newSalePriceExVat: number;
  newSalePriceIncVat: number | null;
  currency: string | null;
  vatRate: number | null;
  hardFloorPrice: number | null;
  suggestedMinPrice: number | null;
  manualMinPrice: number | null;
  finalMinPrice: number | null;
  estimatedProfitAfter: number | null;
  profitMarginPctAfter: number | null;
  costStatus: CostStatus;
  costWarnings: string[];
  payloadPreview: PriceUpdatePayloadItem[] | null;
  warnings: string[];
};

export type GrabCartPreviewResult = {
  grabCartEligibility: GrabCartEligibility;
  currentSalePriceExVat: number | null;
  cartPriceRaw: unknown;
  cartPriceIncludesVat: boolean | null;
  cartPriceExVat: number | null;
  grabStep: number;
  suggestedGrabPriceExVat: number | null;
  currency: string | null;
  vatRate: number | null;
  hardFloorPrice: number | null;
  suggestedMinPrice: number | null;
  manualMinPrice: number | null;
  finalMinPrice: number | null;
  estimatedProfitAfter: number | null;
  profitMarginPctAfter: number | null;
  costStatus: CostStatus;
  costWarnings: string[];
  warnings: string[];
};

const FORBIDDEN_PRICE_PAYLOAD_FIELDS = new Set([
  'name',
  'description',
  'images',
  'category_id',
  'characteristics',
  'documentation',
]);

/** Phase 1-B1 默认关闭真实 eMAG 写请求；后续真实测试需老板单独授权后再开启。 */
const ALLOW_EMAG_PRICE_WRITE = false;

const READBACK_MAX_ATTEMPTS = 3;
const READBACK_RETRY_INTERVAL_MS = 5000;
const READBACK_PRICE_TOLERANCE = 0.005;

const ALLOWED_PRICE_PAYLOAD_KEYS = new Set(['id', 'sale_price', 'vat_id']);

const DRY_RUN_ONLY_MESSAGE = '当前处于 Phase 1-B1 安全模式，未发送 eMAG 写请求，未真实改价';

const GRAB_CART_PRICE_TOLERANCE = 0.005;

export type PriceWriteStatus = 'SUCCESS' | 'FAILED' | 'PENDING_VERIFY' | 'DRY_RUN_ONLY';

export type ReadBackStatus = 'CONFIRMED' | 'UNCONFIRMED' | 'READBACK_FAILED';

export type PriceReadBackResult = {
  readBackStatus: ReadBackStatus;
  readBackPrice: number | null;
  readBackAt: string;
  readBackAttempts: number;
  readBackWarning: string | null;
  targetPrice: number;
  filterUsed: 'id' | 'part_number_key' | 'sku' | null;
  priceFieldUsed: 'sale_price';
};

export type PriceExecuteResult = {
  status: PriceExecuteResultStatus;
  code: PriceErrorCode | 'OK' | 'DRY_RUN_ONLY' | 'SKIPPED';
  message: string;
  storeProductId: number;
  shopId: number;
  logId?: number;
  oldSalePriceExVat?: number | null;
  newSalePriceExVat?: number | null;
  emagOfferId?: string | null;
  payloadPreview?: PriceUpdatePayloadItem[] | null;
  profitRecalculated?: boolean;
  profitRecalcWarning?: string | null;
  readBackStatus?: ReadBackStatus | null;
  readBackPrice?: number | null;
  readBackWarning?: string | null;
  noEmagWriteExecuted: boolean;
};

export type PriceExecuteResultStatus = 'SUCCESS' | 'FAILED' | 'PENDING_VERIFY' | 'DRY_RUN_ONLY' | 'SKIPPED' | 'BLOCKED';

// 与 profitCalculator 的 FBE 冷启动兜底保持业务口径一致。
const DEFAULT_FBE_CNY = 7;

function toPositiveInteger(value: string | number | null | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function pickFirstOfferResult(results: unknown): Record<string, unknown> | null {
  if (Array.isArray(results)) {
    return (results.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined) ?? null;
  }
  if (results && typeof results === 'object') {
    const obj = results as Record<string, unknown>;
    const items = obj.items ?? obj.results;
    if (Array.isArray(items)) {
      return (items.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined) ?? null;
    }
    return obj;
  }
  return null;
}

function findForbiddenFields(value: unknown, path = 'payload'): string[] {
  if (!value || typeof value !== 'object') return [];
  const errors: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...findForbiddenFields(item, `${path}[${index}]`));
    });
    return errors;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PRICE_PAYLOAD_FIELDS.has(key)) {
      errors.push(`${path}.${key} 不允许出现在价格 payload 中`);
    }
    errors.push(...findForbiddenFields(child, `${path}.${key}`));
  }
  return errors;
}

function eligibility(canChangePrice: boolean, code: PriceErrorCode | 'OK', message?: string): PriceActionEligibility {
  return { canChangePrice, code, message: message ?? (code === 'OK' ? '允许手动改价' : PRICE_ERROR_MESSAGES[code]) };
}

function grabEligibility(canGrab: boolean, code: PriceErrorCode | 'OK', message?: string): GrabCartEligibility {
  return { canGrab, code, message: message ?? (code === 'OK' ? '允许生成抢购物车建议价' : PRICE_ERROR_MESSAGES[code]) };
}

function normalizeLinkType(value: string | null | undefined): 'SELF_BUILT' | 'RESELL' | 'OWN_BRAND_RESELL' | 'UNKNOWN' {
  return value === 'SELF_BUILT' || value === 'RESELL' || value === 'OWN_BRAND_RESELL' ? value : 'UNKNOWN';
}

function resolveVatRate(input: {
  storeProductVatRate: number | null;
  rawVatRate: number | null;
  localProductVat: number | null;
  strategyDefaultVatRate: number | null;
}): { vatRate: number | null; isEstimatedVat: boolean } {
  if (input.storeProductVatRate != null && input.storeProductVatRate > 0) return { vatRate: input.storeProductVatRate, isEstimatedVat: false };
  if (input.rawVatRate != null && input.rawVatRate > 0) return { vatRate: input.rawVatRate, isEstimatedVat: false };
  if (input.localProductVat != null && input.localProductVat > 0) return { vatRate: input.localProductVat / 100, isEstimatedVat: false };
  if (input.strategyDefaultVatRate != null && input.strategyDefaultVatRate > 0) return { vatRate: input.strategyDefaultVatRate, isEstimatedVat: true };
  return { vatRate: null, isEstimatedVat: false };
}

function costBlockCode(costStatus: CostStatus): PriceErrorCode {
  if (costStatus === 'MISSING_COMMISSION') return PRICE_ERROR_CODES.MISSING_COMMISSION;
  if (costStatus === 'MISSING_LOGISTICS') return PRICE_ERROR_CODES.MISSING_LOGISTICS;
  if (costStatus === 'MISSING_VAT') return PRICE_ERROR_CODES.MISSING_VAT;
  return PRICE_ERROR_CODES.MISSING_COST;
}

function basePreviewFields(context: PriceContext) {
  return {
    currentSalePriceExVat: context.fresh.currentSalePriceExVat,
    currency: context.fresh.currency ?? context.storeProduct.currency,
    vatRate: context.rawLocalCost.vatRate,
    hardFloorPrice: context.minPrices.hardFloorPrice,
    suggestedMinPrice: context.minPrices.suggestedMinPrice,
    manualMinPrice: context.minPrices.manualMinPrice,
    finalMinPrice: context.minPrices.finalMinPrice,
    costStatus: context.cost.costStatus,
    costWarnings: context.cost.warnings,
  };
}

export function buildProductOfferPriceUpdatePayload(input: BuildPriceUpdatePayloadInput): PriceUpdatePayloadItem[] {
  const id = toPositiveInteger(input.emagOfferId);
  if (!id) throw new Error('emagOfferId 必须是 eMAG product_offer/read 返回的正整数 id');

  const salePrice = toFiniteNumber(input.newSalePriceExVat);
  if (salePrice == null || salePrice <= 0) throw new Error('newSalePriceExVat 必须是大于 0 的不含 VAT 价格');

  const payloadItem: PriceUpdatePayloadItem = {
    id,
    sale_price: roundPrice(salePrice),
  };

  const vatId = input.vatId == null ? null : toPositiveInteger(input.vatId);
  if (vatId) payloadItem.vat_id = vatId;

  return [payloadItem];
}

export function validatePriceUpdatePayload(payload: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Array.isArray(payload) || payload.length === 0) {
    errors.push('payload 必须是非空数组');
    return { ok: false, errors };
  }

  payload.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`payload[${index}] 必须是对象`);
      return;
    }

    const row = item as Record<string, unknown>;
    const keys = Object.keys(row);
    for (const key of keys) {
      if (!ALLOWED_PRICE_PAYLOAD_KEYS.has(key)) {
        errors.push(`payload[${index}] 包含不允许的字段 ${key}`);
      }
    }

    if (!toPositiveInteger(row.id as string | number | null | undefined)) {
      errors.push(`payload[${index}].id 必须是 eMAG offer 正整数 id`);
    }

    const salePrice = toFiniteNumber(row.sale_price);
    if (salePrice == null || salePrice <= 0) {
      errors.push(`payload[${index}].sale_price 必须是大于 0 的不含 VAT 价格`);
    }

    if (row.vat_id != null && !toPositiveInteger(row.vat_id as string | number)) {
      errors.push(`payload[${index}].vat_id 如存在必须是正整数`);
    }
  });

  errors.push(...findForbiddenFields(payload));

  return { ok: errors.length === 0, errors };
}

function normalizeReason(reason: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof reason !== 'string') {
    return { ok: false, message: PRICE_ERROR_MESSAGES.REASON_REQUIRED };
  }
  const trimmed = reason.trim();
  if (trimmed.length < 5 || trimmed.length > 500) {
    return { ok: false, message: '执行原因必填，长度需在 5-500 字之间' };
  }
  return { ok: true, value: trimmed };
}

function buildBlockedExecuteResult(params: {
  storeProductId: number;
  shopId: number;
  code: PriceErrorCode | 'OK' | 'DRY_RUN_ONLY' | 'SKIPPED';
  message: string;
  status?: PriceExecuteResultStatus;
  logId?: number;
  oldSalePriceExVat?: number | null;
  newSalePriceExVat?: number | null;
  emagOfferId?: string | null;
  payloadPreview?: PriceUpdatePayloadItem[] | null;
}): PriceExecuteResult {
  return {
    status: params.status ?? 'BLOCKED',
    code: params.code,
    message: params.message,
    storeProductId: params.storeProductId,
    shopId: params.shopId,
    logId: params.logId,
    oldSalePriceExVat: params.oldSalePriceExVat,
    newSalePriceExVat: params.newSalePriceExVat,
    emagOfferId: params.emagOfferId,
    payloadPreview: params.payloadPreview ?? null,
    profitRecalculated: false,
    profitRecalcWarning: null,
    noEmagWriteExecuted: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPriceMatch(target: number, actual: number, tolerance = READBACK_PRICE_TOLERANCE): boolean {
  return Math.abs(actual - target) <= tolerance;
}

export async function readBackOfferSalePrice(params: {
  shopId: number;
  emagOfferId?: string | number | null;
  pnk?: string | null;
  sku?: string | null;
}): Promise<{
  salePrice: number | null;
  filterUsed: 'id' | 'part_number_key' | 'sku' | null;
  rawId?: unknown;
  pnk?: string | null;
}> {
  type FilterAttempt = {
    filter: Record<string, unknown>;
    filterUsed: 'id' | 'part_number_key' | 'sku';
  };

  const attempts: FilterAttempt[] = [];
  const offerId = toPositiveInteger(params.emagOfferId ?? null);
  if (offerId) attempts.push({ filter: { id: offerId }, filterUsed: 'id' });
  if (params.pnk?.trim()) attempts.push({ filter: { part_number_key: params.pnk.trim() }, filterUsed: 'part_number_key' });
  if (params.sku?.trim()) attempts.push({ filter: { part_number: params.sku.trim() }, filterUsed: 'sku' });

  if (attempts.length === 0) {
    return { salePrice: null, filterUsed: null };
  }

  const creds = await getEmagCredentials(params.shopId);

  for (const attempt of attempts) {
    try {
      const res = await readProductOffers(creds, attempt.filter, { timeout: 60_000, requireProxy: true });
      if (res.isError) continue;
      const raw = pickFirstOfferResult(res.results);
      if (!raw) continue;
      const salePrice = toFiniteNumber(raw.sale_price ?? raw.salePrice);
      if (salePrice == null) continue;
      return {
        salePrice,
        filterUsed: attempt.filterUsed,
        rawId: raw.id,
        pnk: typeof raw.part_number_key === 'string' ? raw.part_number_key : null,
      };
    } catch {
      continue;
    }
  }

  return { salePrice: null, filterUsed: null };
}

export async function performPriceReadBackWithRetry(params: {
  shopId: number;
  emagOfferId?: string | number | null;
  pnk?: string | null;
  sku?: string | null;
  targetPrice: number;
}): Promise<PriceReadBackResult> {
  const targetPrice = roundPrice(params.targetPrice);
  let lastReadPrice: number | null = null;
  let lastFilterUsed: 'id' | 'part_number_key' | 'sku' | null = null;

  for (let attempt = 1; attempt <= READBACK_MAX_ATTEMPTS; attempt += 1) {
    const readResult = await readBackOfferSalePrice({
      shopId: params.shopId,
      emagOfferId: params.emagOfferId,
      pnk: params.pnk,
      sku: params.sku,
    });

    if (readResult.salePrice != null) {
      lastReadPrice = readResult.salePrice;
      lastFilterUsed = readResult.filterUsed;
      if (isPriceMatch(targetPrice, readResult.salePrice)) {
        return {
          readBackStatus: 'CONFIRMED',
          readBackPrice: readResult.salePrice,
          readBackAt: new Date().toISOString(),
          readBackAttempts: attempt,
          readBackWarning: null,
          targetPrice,
          filterUsed: readResult.filterUsed,
          priceFieldUsed: 'sale_price',
        };
      }
    }

    if (attempt < READBACK_MAX_ATTEMPTS) {
      await sleep(READBACK_RETRY_INTERVAL_MS);
    }
  }

  if (lastReadPrice != null) {
    return {
      readBackStatus: 'UNCONFIRMED',
      readBackPrice: lastReadPrice,
      readBackAt: new Date().toISOString(),
      readBackAttempts: READBACK_MAX_ATTEMPTS,
      readBackWarning: `readBack sale_price=${lastReadPrice} 与目标价 ${targetPrice} 不一致，可能为 eMAG read 传播延迟`,
      targetPrice,
      filterUsed: lastFilterUsed,
      priceFieldUsed: 'sale_price',
    };
  }

  return {
    readBackStatus: 'READBACK_FAILED',
    readBackPrice: null,
    readBackAt: new Date().toISOString(),
    readBackAttempts: READBACK_MAX_ATTEMPTS,
    readBackWarning: 'readBack 读取失败或未返回 sale_price，请稍后人工或 sync 对账',
    targetPrice,
    filterUsed: null,
    priceFieldUsed: 'sale_price',
  };
}

export async function updateProductOfferPrice(params: {
  shopId: number;
  storeProductId: number;
  payload: PriceUpdatePayloadItem[];
}): Promise<{
  ok: boolean;
  status: PriceWriteStatus;
  rawResponse?: unknown;
  errorMessage?: string;
}> {
  const validation = validatePriceUpdatePayload(params.payload);
  if (!validation.ok) {
    return {
      ok: false,
      status: 'FAILED',
      errorMessage: validation.errors.join('; '),
    };
  }

  if (!ALLOW_EMAG_PRICE_WRITE) {
    return {
      ok: false,
      status: 'DRY_RUN_ONLY',
      errorMessage: DRY_RUN_ONLY_MESSAGE,
    };
  }

  try {
    const creds = await getEmagCredentials(params.shopId);
    const response = await emagApiCall(creds, 'product_offer', 'save', params.payload, {
      timeout: 60_000,
      requireProxy: true,
    });

    if (response.isError) {
      const message = response.messages?.join('; ') ?? 'eMAG 改价失败';
      return {
        ok: false,
        status: 'FAILED',
        rawResponse: response,
        errorMessage: message,
      };
    }

    return {
      ok: true,
      status: 'SUCCESS',
      rawResponse: response,
    };
  } catch (err: any) {
    const code = err?.code ?? '';
    const message = err?.message ?? 'eMAG 改价请求失败';
    const isPendingVerify = code === 'EMAG_PROXY_REQUIRED'
      || /timeout|ECONNRESET|ETIMEDOUT|ECONNABORTED|socket hang up|状态不明/i.test(message);

    if (isPendingVerify) {
      return {
        ok: false,
        status: 'PENDING_VERIFY',
        errorMessage: message,
      };
    }

    return {
      ok: false,
      status: 'FAILED',
      errorMessage: message,
    };
  }
}

export async function executePriceChange(params: {
  shopId: number;
  storeProductId: number;
  newSalePriceExVat: number;
  reason: string;
  operatorUserId?: number | null;
}): Promise<PriceExecuteResult> {
  const reasonResult = normalizeReason(params.reason);
  if (!reasonResult.ok) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.REASON_REQUIRED,
      message: reasonResult.message,
    });
  }

  const newSalePrice = toFiniteNumber(params.newSalePriceExVat);
  if (newSalePrice == null || newSalePrice <= 0) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.INVALID_PRICE,
      message: PRICE_ERROR_MESSAGES.INVALID_PRICE,
    });
  }

  if (!tryAcquireStoreProductPriceLock(params.storeProductId)) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.PRICE_LOCKED,
      message: PRICE_ERROR_MESSAGES.PRICE_LOCKED,
    });
  }

  if (!tryAcquireShopPriceSlot(params.shopId)) {
    releaseStoreProductPriceLock(params.storeProductId);
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.PRICE_LOCKED,
      message: PRICE_ERROR_MESSAGES.PRICE_LOCKED,
    });
  }

  let logId: number | undefined;

  try {
    const preview = await buildPricePreview({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
      newSalePriceExVat: newSalePrice,
    });

    if (!preview.priceActionEligibility.canChangePrice) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: preview.priceActionEligibility.code,
        message: preview.priceActionEligibility.message,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        payloadPreview: preview.payloadPreview,
      });
    }

    if (preview.finalMinPrice != null && newSalePrice < preview.finalMinPrice) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.BELOW_FINAL_MIN_PRICE,
        message: PRICE_ERROR_MESSAGES.BELOW_FINAL_MIN_PRICE,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        payloadPreview: preview.payloadPreview,
      });
    }

    const payload = preview.payloadPreview;
    if (!payload) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.MISSING_EMAG_OFFER_ID,
        message: PRICE_ERROR_MESSAGES.MISSING_EMAG_OFFER_ID,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
      });
    }

    const validation = validatePriceUpdatePayload(payload);
    if (!validation.ok) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.EMAG_PRICE_UPDATE_FAILED,
        message: validation.errors.join('; '),
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        payloadPreview: payload,
      });
    }

    const log = await createPriceAdjustmentLog({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
      pnk: null,
      mode: 'MANUAL_PRICE_CHANGE',
      oldSalePriceExVat: preview.currentSalePriceExVat,
      newSalePriceExVat: newSalePrice,
      currency: preview.currency,
      vatRate: preview.vatRate,
      hardFloorPrice: preview.hardFloorPrice,
      suggestedMinPrice: preview.suggestedMinPrice,
      manualMinPrice: preview.manualMinPrice,
      finalMinPrice: preview.finalMinPrice,
      estimatedProfitAfter: preview.estimatedProfitAfter,
      profitMarginPctAfter: preview.profitMarginPctAfter,
      reason: reasonResult.value,
      operatorUserId: params.operatorUserId ?? null,
      emagRequestPayload: payload,
      status: 'PROCESSING',
    });
    logId = log.id;

    const writeResult = await updateProductOfferPrice({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
      payload,
    });

    if (writeResult.status === 'DRY_RUN_ONLY') {
      await markPriceAdjustmentSkipped(logId, {
        errorMessage: writeResult.errorMessage ?? DRY_RUN_ONLY_MESSAGE,
      });
      return {
        status: 'SKIPPED',
        code: 'DRY_RUN_ONLY',
        message: `${writeResult.errorMessage ?? DRY_RUN_ONLY_MESSAGE}；no eMAG write executed`,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        emagOfferId: payload[0]?.id != null ? String(payload[0].id) : null,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    if (writeResult.status === 'FAILED') {
      await markPriceAdjustmentFailed(logId, {
        emagResponse: writeResult.rawResponse,
        errorMessage: writeResult.errorMessage,
      });
      return {
        status: 'FAILED',
        code: PRICE_ERROR_CODES.EMAG_PRICE_UPDATE_FAILED,
        message: writeResult.errorMessage ?? PRICE_ERROR_MESSAGES.EMAG_PRICE_UPDATE_FAILED,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    if (writeResult.status === 'PENDING_VERIFY') {
      await markPriceAdjustmentPendingVerify(logId, {
        emagResponse: writeResult.rawResponse,
        errorMessage: writeResult.errorMessage,
      });
      return {
        status: 'PENDING_VERIFY',
        code: PRICE_ERROR_CODES.PENDING_VERIFY,
        message: writeResult.errorMessage ?? PRICE_ERROR_MESSAGES.PENDING_VERIFY,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: newSalePrice,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    const context = await loadPriceContext({ shopId: params.shopId, storeProductId: params.storeProductId });
    const vatId = context?.storeProduct.vatId ?? payload[0]?.vat_id ?? null;
    const vatRate = context?.rawLocalCost.vatRate ?? preview.vatRate ?? null;

    await prisma.$transaction([
      prisma.storeProduct.update({
        where: { id: params.storeProductId },
        data: {
          salePrice: newSalePrice,
          vatId,
          vatRate,
          lastPriceAdjustedAt: new Date(),
          lastPriceAdjustmentMode: 'MANUAL_PRICE_CHANGE',
        },
      }),
    ]);

    const readBack = await performPriceReadBackWithRetry({
      shopId: params.shopId,
      emagOfferId: payload[0]?.id ?? context?.storeProduct.emagOfferId,
      pnk: context?.storeProduct.pnk ?? null,
      sku: (await prisma.storeProduct.findUnique({
        where: { id: params.storeProductId },
        select: { sku: true },
      }))?.sku ?? null,
      targetPrice: newSalePrice,
    });

    const emagResponseForLog = mergeSaveAndReadBackEmagResponse(writeResult.rawResponse, readBack);

    await markPriceAdjustmentSuccess(logId, {
      emagResponse: emagResponseForLog,
      estimatedProfitAfter: preview.estimatedProfitAfter,
      profitMarginPctAfter: preview.profitMarginPctAfter,
    });

    let profitRecalculated = false;
    let profitRecalcWarning: string | null = null;
    try {
      const updatedCount = await recalcProfitForStoreProducts([params.storeProductId]);
      profitRecalculated = updatedCount > 0;
      if (updatedCount === 0) profitRecalcWarning = '单品利润重算未更新任何记录';
    } catch (err: any) {
      profitRecalcWarning = err?.message ?? '单品利润重算失败';
      console.error('[executePriceChange] profit recalc failed:', profitRecalcWarning);
    }

    const successMessage = readBack.readBackStatus === 'CONFIRMED'
      ? 'price execute success'
      : `price execute success; ${readBack.readBackWarning ?? 'readBack 未确认'}`;

    return {
      status: 'SUCCESS',
      code: 'OK',
      message: successMessage,
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      logId,
      oldSalePriceExVat: preview.currentSalePriceExVat,
      newSalePriceExVat: newSalePrice,
      emagOfferId: payload[0]?.id != null ? String(payload[0].id) : null,
      payloadPreview: payload,
      profitRecalculated,
      profitRecalcWarning,
      readBackStatus: readBack.readBackStatus,
      readBackPrice: readBack.readBackPrice,
      readBackWarning: readBack.readBackWarning,
      noEmagWriteExecuted: false,
    };
  } catch (err: any) {
    if (logId) {
      try {
        await markPriceAdjustmentFailed(logId, {
          errorMessage: err?.message ?? 'executePriceChange 执行失败',
        });
      } catch (logErr: any) {
        console.error('[executePriceChange] failed to mark log FAILED:', logErr?.message ?? logErr);
      }
    }
    throw err;
  } finally {
    releaseStoreProductPriceLock(params.storeProductId);
    releaseShopPriceSlot(params.shopId);
  }
}

export async function executeGrabCartPriceChange(params: {
  shopId: number;
  storeProductId: number;
  confirmedPriceExVat: number;
  reason: string;
  operatorUserId?: number | null;
}): Promise<PriceExecuteResult> {
  const reasonResult = normalizeReason(params.reason);
  if (!reasonResult.ok) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.REASON_REQUIRED,
      message: reasonResult.message,
    });
  }

  const confirmedPrice = toFiniteNumber(params.confirmedPriceExVat);
  if (confirmedPrice == null || confirmedPrice <= 0) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.INVALID_PRICE,
      message: PRICE_ERROR_MESSAGES.INVALID_PRICE,
    });
  }

  if (!tryAcquireStoreProductPriceLock(params.storeProductId)) {
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.PRICE_LOCKED,
      message: PRICE_ERROR_MESSAGES.PRICE_LOCKED,
    });
  }

  if (!tryAcquireShopPriceSlot(params.shopId)) {
    releaseStoreProductPriceLock(params.storeProductId);
    return buildBlockedExecuteResult({
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      code: PRICE_ERROR_CODES.PRICE_LOCKED,
      message: PRICE_ERROR_MESSAGES.PRICE_LOCKED,
    });
  }

  let logId: number | undefined;

  try {
    const preview = await buildGrabCartPreview({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
    });

    if (preview.grabCartEligibility.code === PRICE_ERROR_CODES.ALREADY_WON) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.ALREADY_WON,
        message: preview.grabCartEligibility.message,
        status: 'SKIPPED',
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
      });
    }

    if (!preview.grabCartEligibility.canGrab) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: preview.grabCartEligibility.code,
        message: preview.grabCartEligibility.message,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
      });
    }

    const suggestedPrice = preview.suggestedGrabPriceExVat;
    if (suggestedPrice == null || Math.abs(confirmedPrice - suggestedPrice) > GRAB_CART_PRICE_TOLERANCE) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.CONFIRMED_PRICE_MISMATCH,
        message: PRICE_ERROR_MESSAGES.CONFIRMED_PRICE_MISMATCH,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
      });
    }

    if (preview.finalMinPrice != null && confirmedPrice < preview.finalMinPrice) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.BELOW_FINAL_MIN_PRICE,
        message: PRICE_ERROR_MESSAGES.BELOW_FINAL_MIN_PRICE,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
      });
    }

    const context = await loadPriceContext({ shopId: params.shopId, storeProductId: params.storeProductId });
    if (!context?.fresh.emagOfferId) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.MISSING_EMAG_OFFER_ID,
        message: PRICE_ERROR_MESSAGES.MISSING_EMAG_OFFER_ID,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
      });
    }

    const payload = buildProductOfferPriceUpdatePayload({
      emagOfferId: context.fresh.emagOfferId,
      newSalePriceExVat: confirmedPrice,
      vatId: context.storeProduct.vatId,
    });

    const validation = validatePriceUpdatePayload(payload);
    if (!validation.ok) {
      return buildBlockedExecuteResult({
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        code: PRICE_ERROR_CODES.EMAG_PRICE_UPDATE_FAILED,
        message: validation.errors.join('; '),
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
        payloadPreview: payload,
      });
    }

    const log = await createPriceAdjustmentLog({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
      pnk: context.storeProduct.pnk,
      mode: 'GRAB_CART_MANUAL',
      oldSalePriceExVat: preview.currentSalePriceExVat,
      newSalePriceExVat: confirmedPrice,
      currency: preview.currency,
      cartPriceRaw: preview.cartPriceRaw,
      cartPriceExVat: preview.cartPriceExVat,
      vatRate: preview.vatRate,
      hardFloorPrice: preview.hardFloorPrice,
      suggestedMinPrice: preview.suggestedMinPrice,
      manualMinPrice: preview.manualMinPrice,
      finalMinPrice: preview.finalMinPrice,
      estimatedProfitAfter: preview.estimatedProfitAfter,
      profitMarginPctAfter: preview.profitMarginPctAfter,
      reason: reasonResult.value,
      operatorUserId: params.operatorUserId ?? null,
      emagRequestPayload: payload,
      status: 'PROCESSING',
    });
    logId = log.id;

    const writeResult = await updateProductOfferPrice({
      shopId: params.shopId,
      storeProductId: params.storeProductId,
      payload,
    });

    if (writeResult.status === 'DRY_RUN_ONLY') {
      await markPriceAdjustmentSkipped(logId, {
        errorMessage: writeResult.errorMessage ?? DRY_RUN_ONLY_MESSAGE,
      });
      return {
        status: 'SKIPPED',
        code: 'DRY_RUN_ONLY',
        message: `${writeResult.errorMessage ?? DRY_RUN_ONLY_MESSAGE}；no eMAG write executed`,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
        emagOfferId: context.fresh.emagOfferId,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    if (writeResult.status === 'FAILED') {
      await markPriceAdjustmentFailed(logId, {
        emagResponse: writeResult.rawResponse,
        errorMessage: writeResult.errorMessage,
      });
      return {
        status: 'FAILED',
        code: PRICE_ERROR_CODES.EMAG_PRICE_UPDATE_FAILED,
        message: writeResult.errorMessage ?? PRICE_ERROR_MESSAGES.EMAG_PRICE_UPDATE_FAILED,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    if (writeResult.status === 'PENDING_VERIFY') {
      await markPriceAdjustmentPendingVerify(logId, {
        emagResponse: writeResult.rawResponse,
        errorMessage: writeResult.errorMessage,
      });
      return {
        status: 'PENDING_VERIFY',
        code: PRICE_ERROR_CODES.PENDING_VERIFY,
        message: writeResult.errorMessage ?? PRICE_ERROR_MESSAGES.PENDING_VERIFY,
        storeProductId: params.storeProductId,
        shopId: params.shopId,
        logId,
        oldSalePriceExVat: preview.currentSalePriceExVat,
        newSalePriceExVat: confirmedPrice,
        payloadPreview: payload,
        profitRecalculated: false,
        profitRecalcWarning: null,
        noEmagWriteExecuted: true,
      };
    }

    const vatId = context.storeProduct.vatId ?? payload[0]?.vat_id ?? null;
    const vatRate = context.rawLocalCost.vatRate ?? preview.vatRate ?? null;

    await prisma.$transaction([
      prisma.storeProduct.update({
        where: { id: params.storeProductId },
        data: {
          salePrice: confirmedPrice,
          vatId,
          vatRate,
          lastPriceAdjustedAt: new Date(),
          lastPriceAdjustmentMode: 'GRAB_CART_MANUAL',
        },
      }),
    ]);

    await markPriceAdjustmentSuccess(logId, {
      emagResponse: writeResult.rawResponse,
      estimatedProfitAfter: preview.estimatedProfitAfter,
      profitMarginPctAfter: preview.profitMarginPctAfter,
    });

    let profitRecalculated = false;
    let profitRecalcWarning: string | null = null;
    try {
      const updatedCount = await recalcProfitForStoreProducts([params.storeProductId]);
      profitRecalculated = updatedCount > 0;
      if (updatedCount === 0) profitRecalcWarning = '单品利润重算未更新任何记录';
    } catch (err: any) {
      profitRecalcWarning = err?.message ?? '单品利润重算失败';
      console.error('[executeGrabCartPriceChange] profit recalc failed:', profitRecalcWarning);
    }

    return {
      status: 'SUCCESS',
      code: 'OK',
      message: 'grab-cart execute success',
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      logId,
      oldSalePriceExVat: preview.currentSalePriceExVat,
      newSalePriceExVat: confirmedPrice,
      emagOfferId: context.fresh.emagOfferId,
      payloadPreview: payload,
      profitRecalculated,
      profitRecalcWarning,
      noEmagWriteExecuted: false,
    };
  } catch (err: any) {
    if (logId) {
      try {
        await markPriceAdjustmentFailed(logId, {
          errorMessage: err?.message ?? 'executeGrabCartPriceChange 执行失败',
        });
      } catch (logErr: any) {
        console.error('[executeGrabCartPriceChange] failed to mark log FAILED:', logErr?.message ?? logErr);
      }
    }
    throw err;
  } finally {
    releaseStoreProductPriceLock(params.storeProductId);
    releaseShopPriceSlot(params.shopId);
  }
}

export async function readFreshProductOfferForPriceCheck(params: {
  shopId: number;
  storeProductId: number;
}): Promise<FreshOfferForPriceCheck> {
  const storeProduct = await prisma.storeProduct.findFirst({
    where: { id: params.storeProductId, shopId: params.shopId, isArchived: false },
    select: {
      id: true,
      shopId: true,
      pnk: true,
      emagOfferId: true,
      salePrice: true,
      currency: true,
      vatId: true,
      vatRate: true,
      status: true,
      validationStatus: true,
      offerValidationStatus: true,
      stock: true,
      buyButtonRank: true,
      bestOfferSalePrice: true,
      mainOfferPrice: true,
      numberOfOffers: true,
    },
  });

  if (!storeProduct) {
    throw new Error('StoreProduct 不存在、已归档或不属于指定 shopId');
  }

  const base: FreshOfferForPriceCheck = {
    storeProductId: storeProduct.id,
    shopId: storeProduct.shopId,
    pnk: storeProduct.pnk ?? null,
    emagOfferId: storeProduct.emagOfferId ?? null,
    currentSalePriceExVat: storeProduct.salePrice != null ? Number(storeProduct.salePrice) : null,
    currency: storeProduct.currency ?? null,
    status: storeProduct.status ?? null,
    validationStatus: storeProduct.validationStatus ?? null,
    offerValidationStatus: storeProduct.offerValidationStatus ?? undefined,
    stock: storeProduct.stock ?? null,
    buyButtonRank: storeProduct.buyButtonRank ?? null,
    bestOfferSalePrice: storeProduct.bestOfferSalePrice != null ? Number(storeProduct.bestOfferSalePrice) : null,
    mainOfferPrice: storeProduct.mainOfferPrice != null ? Number(storeProduct.mainOfferPrice) : null,
    numberOfOffers: storeProduct.numberOfOffers ?? null,
    vatId: storeProduct.vatId ?? null,
    vatRate: storeProduct.vatRate != null ? Number(storeProduct.vatRate) : null,
  };

  const filters: Record<string, unknown> = {};
  const offerId = toPositiveInteger(storeProduct.emagOfferId ?? null);
  if (offerId) {
    filters.id = offerId;
  } else if (storeProduct.pnk) {
    filters.part_number_key = storeProduct.pnk;
  } else {
    return base;
  }

  const creds = await getEmagCredentials(params.shopId);
  const res = await readProductOffers(creds, filters, { timeout: 60_000, requireProxy: true });

  if (res.isError) {
    throw new Error(`product_offer/read 读取失败：${res.messages?.join('; ') ?? 'eMAG 返回错误'}`);
  }

  const raw = pickFirstOfferResult(res.results);
  if (!raw) return base;

  const currentSalePriceExVat = toFiniteNumber(raw.sale_price ?? raw.salePrice) ?? base.currentSalePriceExVat;
  const status = toFiniteNumber(raw.status) ?? base.status;
  const stock = toFiniteNumber(raw.general_stock ?? raw.estimated_stock ?? raw.stock) ?? base.stock;

  return {
    ...base,
    emagOfferId: raw.id != null ? String(raw.id) : base.emagOfferId,
    currentSalePriceExVat,
    currency: typeof raw.currency === 'string'
      ? raw.currency
      : typeof raw.currency_type === 'string'
        ? raw.currency_type
        : base.currency,
    status,
    validationStatus: typeof raw.validation_status === 'string' ? raw.validation_status : base.validationStatus,
    offerValidationStatus: raw.offer_validation_status ?? base.offerValidationStatus,
    stock,
    buyButtonRank: toFiniteNumber(raw.buy_button_rank ?? raw.buyButtonRank) ?? base.buyButtonRank ?? null,
    bestOfferSalePrice: toFiniteNumber(raw.best_offer_sale_price ?? raw.bestOfferSalePrice) ?? base.bestOfferSalePrice ?? null,
    mainOfferPrice: toFiniteNumber(raw.main_offer_price ?? raw.mainOfferPrice) ?? base.mainOfferPrice ?? null,
    numberOfOffers: toFiniteNumber(raw.number_of_offers ?? raw.numberOfOffers) ?? base.numberOfOffers ?? null,
    vatId: toPositiveInteger(raw.vat_id as string | number | null | undefined) ?? base.vatId ?? null,
    vatRate: toFiniteNumber(raw.vat_rate ?? raw.vatRate) ?? base.vatRate ?? null,
    raw,
  };
}

export async function loadPriceContext(params: { shopId: number; storeProductId: number }): Promise<PriceContext | null> {
  const storeProduct = await prisma.storeProduct.findFirst({
    where: { id: params.storeProductId, shopId: params.shopId, isArchived: false },
    select: {
      id: true,
      shopId: true,
      pnk: true,
      name: true,
      mappedInventorySku: true,
      emagOfferId: true,
      salePrice: true,
      currency: true,
      vatId: true,
      vatRate: true,
      stock: true,
      status: true,
      validationStatus: true,
      emagLinkType: true,
      buyBoxStatus: true,
      buyButtonRank: true,
      commissionRate: true,
      manualMinPrice: true,
    },
  });

  if (!storeProduct) return null;

  const [fresh, strategyConfig, rateMap] = await Promise.all([
    readFreshProductOfferForPriceCheck(params),
    prisma.storePriceStrategyConfig.findUnique({ where: { shopId: params.shopId } }),
    loadExchangeRateMap(),
  ]);

  const strategy: PriceStrategy = {
    targetMinMarginPct: strategyConfig?.targetMinMarginPct != null ? Number(strategyConfig.targetMinMarginPct) : DEFAULT_PRICE_STRATEGY.targetMinMarginPct,
    safetyBufferPct: strategyConfig?.safetyBufferPct != null ? Number(strategyConfig.safetyBufferPct) : DEFAULT_PRICE_STRATEGY.safetyBufferPct,
    grabStep: strategyConfig?.grabStep != null ? Number(strategyConfig.grabStep) : DEFAULT_PRICE_STRATEGY.grabStep,
    defaultVatRate: strategyConfig?.defaultVatRate != null ? Number(strategyConfig.defaultVatRate) : null,
    defaultCommissionRate: strategyConfig?.defaultCommissionRate != null ? Number(strategyConfig.defaultCommissionRate) : null,
    returnLossRate: strategyConfig?.returnLossRate != null ? Number(strategyConfig.returnLossRate) : null,
    manualPriceAllowEstimatedCost: strategyConfig?.manualPriceAllowEstimatedCost ?? DEFAULT_PRICE_STRATEGY.manualPriceAllowEstimatedCost,
    grabCartAllowEstimatedCost: strategyConfig?.grabCartAllowEstimatedCost ?? DEFAULT_PRICE_STRATEGY.grabCartAllowEstimatedCost,
    isPriceChangePaused: strategyConfig?.isPriceChangePaused ?? false,
    isGrabCartPaused: strategyConfig?.isGrabCartPaused ?? false,
  };

  const localProduct = storeProduct.mappedInventorySku
    ? await prisma.product.findFirst({
        where: { sku: storeProduct.mappedInventorySku },
        select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true, category: true, returnLossRate: true, vat: true },
      })
    : await prisma.product.findFirst({
        where: { pnk: storeProduct.pnk },
        select: { sku: true, pnk: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true, category: true, returnLossRate: true, vat: true },
      });

  const currency = fresh.currency ?? storeProduct.currency ?? 'RON';
  const cnyToLocal = rateMap.get(`CNY→${currency}`) ?? null;
  const purchasePriceCny = localProduct?.purchasePrice != null ? Number(localProduct.purchasePrice) : null;
  const purchaseCost = purchasePriceCny != null && cnyToLocal != null ? purchasePriceCny * cnyToLocal : null;
  const hasWeight = localProduct?.actualWeight != null && Number(localProduct.actualWeight) > 0;
  const hasVolume = Boolean(localProduct?.length && localProduct?.width && localProduct?.height)
    && Number(localProduct?.length) > 0
    && Number(localProduct?.width) > 0
    && Number(localProduct?.height) > 0;
  const headFreightCny = localProduct
    ? calcHeadFreightCny(
        localProduct.length ? Number(localProduct.length) : null,
        localProduct.width ? Number(localProduct.width) : null,
        localProduct.height ? Number(localProduct.height) : null,
        localProduct.actualWeight ? Number(localProduct.actualWeight) : null,
      )
    : null;
  const headFreightLocal = headFreightCny != null && cnyToLocal != null ? headFreightCny * cnyToLocal : null;
  const fbeLocal = localProduct?.fbeFee != null
    ? Number(localProduct.fbeFee)
    : cnyToLocal != null
      ? DEFAULT_FBE_CNY * cnyToLocal
      : null;
  const logisticsCost = headFreightLocal != null && fbeLocal != null ? headFreightLocal + fbeLocal : null;

  let commissionRate = storeProduct.commissionRate != null ? Number(storeProduct.commissionRate) : null;
  let isEstimatedCommission = false;
  if (commissionRate == null && localProduct) {
    const guessed = guessCommissionRate(storeProduct.name, localProduct.category ?? null);
    if (guessed != null) {
      commissionRate = guessed;
      isEstimatedCommission = true;
    }
  }
  if (commissionRate == null && strategy.defaultCommissionRate != null) {
    commissionRate = strategy.defaultCommissionRate;
    isEstimatedCommission = true;
  }
  if (commissionRate == null) {
    commissionRate = DEFAULT_COMMISSION_RATE;
    isEstimatedCommission = true;
  }

  const vatResolution = resolveVatRate({
    storeProductVatRate: storeProduct.vatRate != null ? Number(storeProduct.vatRate) : null,
    rawVatRate: fresh.vatRate ?? null,
    localProductVat: localProduct?.vat ?? null,
    strategyDefaultVatRate: strategy.defaultVatRate,
  });

  const cost = calculateCostStatus({
    purchaseCost,
    logisticsCost,
    commissionRate,
    vatRate: vatResolution.vatRate,
    hasAnyLogisticsDimension: hasWeight || hasVolume,
    hasCompleteLogisticsDimensions: hasWeight && hasVolume,
    isEstimatedLogistics: headFreightCny == null ? false : !(hasWeight && hasVolume),
    isEstimatedFbeFee: localProduct?.fbeFee == null,
    isEstimatedCommission,
    isEstimatedVat: vatResolution.isEstimatedVat,
  });

  const returnLossRate = strategy.returnLossRate ?? localProduct?.returnLossRate ?? 0;
  const minPrices = calculateMinPrices({
    purchaseCost: cost.purchaseCost,
    logisticsCost: cost.logisticsCost,
    commissionRate: cost.commissionRate,
    returnLossRate,
    safetyBufferPct: strategy.safetyBufferPct,
    targetMinMarginPct: strategy.targetMinMarginPct,
    manualMinPrice: storeProduct.manualMinPrice != null ? Number(storeProduct.manualMinPrice) : null,
  });

  return {
    storeProduct: {
      id: storeProduct.id,
      shopId: storeProduct.shopId,
      pnk: storeProduct.pnk,
      name: storeProduct.name,
      mappedInventorySku: storeProduct.mappedInventorySku,
      emagOfferId: storeProduct.emagOfferId,
      salePrice: Number(storeProduct.salePrice),
      currency: storeProduct.currency,
      stock: storeProduct.stock,
      status: storeProduct.status,
      validationStatus: storeProduct.validationStatus,
      emagLinkType: storeProduct.emagLinkType,
      buyBoxStatus: storeProduct.buyBoxStatus,
      buyButtonRank: storeProduct.buyButtonRank,
      commissionRate,
      vatId: fresh.vatId ?? storeProduct.vatId ?? null,
      vatRate: vatResolution.vatRate,
      manualMinPrice: storeProduct.manualMinPrice != null ? Number(storeProduct.manualMinPrice) : null,
    },
    fresh,
    strategy,
    cost,
    minPrices,
    returnLossRate,
    rawLocalCost: {
      purchaseCost,
      logisticsCost,
      commissionRate,
      vatRate: vatResolution.vatRate,
    },
  };
}

export function resolveCartPriceExVat(raw: unknown, vatRate: number | null): {
  cartPriceRaw: unknown;
  cartPriceIncludesVat: boolean | null;
  cartPriceExVat: number | null;
  blockCode?: PriceErrorCode;
  warnings: string[];
} {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const cartPriceRaw = obj.best_offer_sale_price ?? obj.bestOfferSalePrice ?? obj.main_offer_price ?? obj.mainOfferPrice ?? null;
  const price = toFiniteNumber(cartPriceRaw);
  if (price == null || price <= 0) {
    return { cartPriceRaw, cartPriceIncludesVat: null, cartPriceExVat: null, blockCode: PRICE_ERROR_CODES.MISSING_CART_PRICE, warnings: ['缺少购物车参考价'] };
  }

  const includesVat = toBooleanOrNull(
    obj.cart_price_includes_vat ??
    obj.price_includes_vat ??
    obj.best_offer_price_includes_vat ??
    obj.includes_vat ??
    null,
  );
  if (includesVat == null) {
    return {
      cartPriceRaw,
      cartPriceIncludesVat: null,
      cartPriceExVat: null,
      blockCode: PRICE_ERROR_CODES.CART_PRICE_TAX_MODE_UNKNOWN,
      warnings: ['无法确认购物车参考价是否含 VAT'],
    };
  }
  if (includesVat && (vatRate == null || vatRate <= 0)) {
    return { cartPriceRaw, cartPriceIncludesVat: true, cartPriceExVat: null, blockCode: PRICE_ERROR_CODES.MISSING_VAT, warnings: ['购物车价含 VAT，但缺少 VAT 税率'] };
  }

  return {
    cartPriceRaw,
    cartPriceIncludesVat: includesVat,
    cartPriceExVat: includesVat ? roundPrice(price / (1 + (vatRate ?? 0))) : roundPrice(price),
    warnings: [],
  };
}

export async function buildPricePreview(params: {
  shopId: number;
  storeProductId: number;
  newSalePriceExVat: number;
}): Promise<PricePreviewResult> {
  const newSalePrice = toFiniteNumber(params.newSalePriceExVat);
  if (newSalePrice == null || newSalePrice <= 0) {
    return {
      priceActionEligibility: eligibility(false, PRICE_ERROR_CODES.INVALID_PRICE),
      currentSalePriceExVat: null,
      newSalePriceExVat: params.newSalePriceExVat,
      newSalePriceIncVat: null,
      currency: null,
      vatRate: null,
      hardFloorPrice: null,
      suggestedMinPrice: null,
      manualMinPrice: null,
      finalMinPrice: null,
      estimatedProfitAfter: null,
      profitMarginPctAfter: null,
      costStatus: 'MISSING_COST',
      costWarnings: [],
      payloadPreview: null,
      warnings: [],
    };
  }

  const context = await loadPriceContext({ shopId: params.shopId, storeProductId: params.storeProductId });
  if (!context) {
    return {
      priceActionEligibility: eligibility(false, PRICE_ERROR_CODES.STORE_PRODUCT_NOT_FOUND),
      currentSalePriceExVat: null,
      newSalePriceExVat: newSalePrice,
      newSalePriceIncVat: null,
      currency: null,
      vatRate: null,
      hardFloorPrice: null,
      suggestedMinPrice: null,
      manualMinPrice: null,
      finalMinPrice: null,
      estimatedProfitAfter: null,
      profitMarginPctAfter: null,
      costStatus: 'MISSING_COST',
      costWarnings: [],
      payloadPreview: null,
      warnings: [],
    };
  }

  let actionEligibility = eligibility(true, 'OK');
  const linkType = normalizeLinkType(context.storeProduct.emagLinkType);
  if (context.strategy.isPriceChangePaused) {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.PRICE_CHANGE_PAUSED);
  } else if (linkType === 'UNKNOWN') {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.LINK_TYPE_NOT_ALLOWED);
  } else if (!context.fresh.emagOfferId) {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.MISSING_EMAG_OFFER_ID);
  } else if (!isOfferSellable({ status: context.fresh.status, offerValidationStatus: context.fresh.offerValidationStatus })) {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.OFFER_NOT_SELLABLE);
  } else if (context.cost.costStatus !== 'COMPLETE' && context.cost.costStatus !== 'ESTIMATED') {
    actionEligibility = eligibility(false, costBlockCode(context.cost.costStatus));
  } else if (context.cost.costStatus === 'ESTIMATED' && !context.strategy.manualPriceAllowEstimatedCost) {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.MISSING_COST, '成本存在估算项，当前店铺策略不允许手动改价');
  } else if (context.minPrices.blockCode) {
    actionEligibility = eligibility(false, context.minPrices.blockCode, context.minPrices.warnings[0]);
  } else if (context.minPrices.finalMinPrice != null && newSalePrice < context.minPrices.finalMinPrice) {
    actionEligibility = eligibility(false, PRICE_ERROR_CODES.BELOW_FINAL_MIN_PRICE);
  }

  const profit = estimateProfitAfterPrice({
    salePriceExVat: newSalePrice,
    purchaseCost: context.rawLocalCost.purchaseCost,
    logisticsCost: context.rawLocalCost.logisticsCost,
    commissionRate: context.rawLocalCost.commissionRate,
    returnLossRate: context.returnLossRate,
  });
  const payloadPreview = context.fresh.emagOfferId
    ? buildProductOfferPriceUpdatePayload({ emagOfferId: context.fresh.emagOfferId, newSalePriceExVat: newSalePrice, vatId: context.storeProduct.vatId })
    : null;

  return {
    priceActionEligibility: actionEligibility,
    ...basePreviewFields(context),
    newSalePriceExVat: roundPrice(newSalePrice),
    newSalePriceIncVat: context.rawLocalCost.vatRate != null ? roundPrice(newSalePrice * (1 + context.rawLocalCost.vatRate)) : null,
    estimatedProfitAfter: profit.estimatedProfitAfter,
    profitMarginPctAfter: profit.profitMarginPctAfter,
    payloadPreview,
    warnings: [...context.minPrices.warnings],
  };
}

export async function buildGrabCartPreview(params: {
  shopId: number;
  storeProductId: number;
}): Promise<GrabCartPreviewResult> {
  const context = await loadPriceContext({ shopId: params.shopId, storeProductId: params.storeProductId });
  if (!context) {
    return {
      grabCartEligibility: grabEligibility(false, PRICE_ERROR_CODES.STORE_PRODUCT_NOT_FOUND),
      currentSalePriceExVat: null,
      cartPriceRaw: null,
      cartPriceIncludesVat: null,
      cartPriceExVat: null,
      grabStep: DEFAULT_PRICE_STRATEGY.grabStep,
      suggestedGrabPriceExVat: null,
      currency: null,
      vatRate: null,
      hardFloorPrice: null,
      suggestedMinPrice: null,
      manualMinPrice: null,
      finalMinPrice: null,
      estimatedProfitAfter: null,
      profitMarginPctAfter: null,
      costStatus: 'MISSING_COST',
      costWarnings: [],
      warnings: [],
    };
  }

  let grabCartEligibility = grabEligibility(true, 'OK');
  const linkType = normalizeLinkType(context.storeProduct.emagLinkType);
  const cart = resolveCartPriceExVat(context.fresh.raw, context.rawLocalCost.vatRate);
  const suggestedGrabPriceExVat = cart.cartPriceExVat != null ? roundPrice(cart.cartPriceExVat - context.strategy.grabStep) : null;
  const profit = suggestedGrabPriceExVat != null
    ? estimateProfitAfterPrice({
        salePriceExVat: suggestedGrabPriceExVat,
        purchaseCost: context.rawLocalCost.purchaseCost,
        logisticsCost: context.rawLocalCost.logisticsCost,
        commissionRate: context.rawLocalCost.commissionRate,
        returnLossRate: context.returnLossRate,
      })
    : { estimatedProfitAfter: null, profitMarginPctAfter: null };

  if (context.strategy.isGrabCartPaused) {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.GRAB_CART_PAUSED);
  } else if (linkType !== 'RESELL') {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.LINK_TYPE_NOT_ALLOWED);
  } else if ((context.fresh.stock ?? 0) <= 0) {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.OUT_OF_STOCK);
  } else if (!isOfferSellable({ status: context.fresh.status, offerValidationStatus: context.fresh.offerValidationStatus, stock: context.fresh.stock })) {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.OFFER_NOT_SELLABLE);
  } else if (context.fresh.buyButtonRank === 1 || context.storeProduct.buyBoxStatus === 'WON') {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.ALREADY_WON);
  } else if (cart.blockCode) {
    grabCartEligibility = grabEligibility(false, cart.blockCode, cart.warnings[0]);
  } else if (context.cost.costStatus !== 'COMPLETE' && !context.strategy.grabCartAllowEstimatedCost) {
    grabCartEligibility = grabEligibility(false, costBlockCode(context.cost.costStatus), '成本资料不完整，当前店铺策略不允许抢购物车');
  } else if (context.minPrices.blockCode) {
    grabCartEligibility = grabEligibility(false, context.minPrices.blockCode, context.minPrices.warnings[0]);
  } else if (suggestedGrabPriceExVat == null || suggestedGrabPriceExVat <= 0) {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.INVALID_PRICE);
  } else if (context.minPrices.finalMinPrice != null && suggestedGrabPriceExVat < context.minPrices.finalMinPrice) {
    grabCartEligibility = grabEligibility(false, PRICE_ERROR_CODES.BELOW_FINAL_MIN_PRICE);
  }

  return {
    grabCartEligibility,
    ...basePreviewFields(context),
    cartPriceRaw: cart.cartPriceRaw,
    cartPriceIncludesVat: cart.cartPriceIncludesVat,
    cartPriceExVat: cart.cartPriceExVat,
    grabStep: context.strategy.grabStep,
    suggestedGrabPriceExVat,
    estimatedProfitAfter: profit.estimatedProfitAfter,
    profitMarginPctAfter: profit.profitMarginPctAfter,
    warnings: [...context.minPrices.warnings, ...cart.warnings],
  };
}

export async function dryRunBuildPriceUpdate(params: {
  shopId: number;
  storeProductId: number;
  newSalePriceExVat: number;
}): Promise<{
  ok: boolean;
  message: string;
  storeProductId: number;
  shopId: number;
  pnk: string | null;
  emagOfferId: string | null;
  currentSalePriceExVat: number | null;
  newSalePriceExVat: number;
  payload: unknown;
  warnings: string[];
}> {
  const newSalePrice = toFiniteNumber(params.newSalePriceExVat);
  if (newSalePrice == null || newSalePrice <= 0) {
    return {
      ok: false,
      message: 'newSalePriceExVat 必须是大于 0 的不含 VAT 价格',
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      pnk: null,
      emagOfferId: null,
      currentSalePriceExVat: null,
      newSalePriceExVat: params.newSalePriceExVat,
      payload: null,
      warnings: ['本接口为 dry-run，不会发送 eMAG 改价请求'],
    };
  }

  const fresh = await readFreshProductOfferForPriceCheck({
    shopId: params.shopId,
    storeProductId: params.storeProductId,
  });

  const warnings = ['本接口为 dry-run，不会发送 eMAG 改价请求'];
  if (!fresh.emagOfferId) {
    return {
      ok: false,
      message: '缺少 eMAG offer id，无法构造 product_offer/save 最小改价 payload',
      storeProductId: fresh.storeProductId,
      shopId: fresh.shopId,
      pnk: fresh.pnk,
      emagOfferId: fresh.emagOfferId,
      currentSalePriceExVat: fresh.currentSalePriceExVat,
      newSalePriceExVat: newSalePrice,
      payload: null,
      warnings,
    };
  }

  if (!fresh.vatId) {
    warnings.push('缺少 vat_id，dry-run payload 将不带 vat_id；真实改价前必须确认 eMAG 是否要求 vat_id');
  }

  const payload = buildProductOfferPriceUpdatePayload({
    emagOfferId: fresh.emagOfferId,
    newSalePriceExVat: newSalePrice,
    vatId: fresh.vatId,
  });
  const validation = validatePriceUpdatePayload(payload);

  return {
    ok: validation.ok,
    message: validation.ok
      ? 'dry-run payload generated, no eMAG write executed'
      : `dry-run payload 校验失败：${validation.errors.join('; ')}`,
    storeProductId: fresh.storeProductId,
    shopId: fresh.shopId,
    pnk: fresh.pnk,
    emagOfferId: fresh.emagOfferId,
    currentSalePriceExVat: fresh.currentSalePriceExVat,
    newSalePriceExVat: newSalePrice,
    payload,
    warnings: validation.ok ? warnings : [...warnings, ...validation.errors],
  };
}
