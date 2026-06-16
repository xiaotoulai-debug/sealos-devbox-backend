import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

const MAX_JSON_BYTES = 20 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 2000;

const SENSITIVE_KEY_PATTERN = /authorization|password|token|cookie|secret/i;

export type PriceAdjustmentMode = 'MANUAL_PRICE_CHANGE' | 'GRAB_CART_MANUAL';
export type PriceAdjustmentStatus = 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'PENDING_VERIFY' | 'SKIPPED';

export type PriceAdjustmentPayloadItem = {
  id: number;
  sale_price: number;
  vat_id?: number;
};

export type CreatePriceAdjustmentLogInput = {
  shopId: number;
  storeProductId: number;
  pnk?: string | null;
  mode: PriceAdjustmentMode;
  oldSalePriceExVat?: number | null;
  newSalePriceExVat: number;
  currency?: string | null;
  cartPriceRaw?: unknown;
  cartPriceExVat?: number | null;
  vatRate?: number | null;
  hardFloorPrice?: number | null;
  suggestedMinPrice?: number | null;
  manualMinPrice?: number | null;
  finalMinPrice?: number | null;
  estimatedProfitAfter?: number | null;
  profitMarginPctAfter?: number | null;
  reason: string;
  operatorUserId?: number | null;
  emagRequestPayload?: PriceAdjustmentPayloadItem[] | null;
  status?: PriceAdjustmentStatus;
};

function toDecimal(value: number | null | undefined): Prisma.Decimal | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Prisma.Decimal(value);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeValue(child, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function sanitizePricePayload(payload: PriceAdjustmentPayloadItem[] | null | undefined): PriceAdjustmentPayloadItem[] | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  return payload.map((item) => {
    const row: PriceAdjustmentPayloadItem = {
      id: item.id,
      sale_price: item.sale_price,
    };
    if (item.vat_id != null) row.vat_id = item.vat_id;
    return row;
  });
}

export function sanitizeAndTruncateJson(value: unknown): Prisma.InputJsonValue {
  const sanitized = sanitizeValue(value);
  let serialized = JSON.stringify(sanitized ?? null);
  if (serialized.length <= MAX_JSON_BYTES) {
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  }
  const truncatedPayload = {
    truncated: true,
    preview: serialized.slice(0, MAX_JSON_BYTES),
  };
  serialized = JSON.stringify(truncatedPayload);
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function truncateErrorMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...[truncated]`
    : message;
}

export async function createPriceAdjustmentLog(input: CreatePriceAdjustmentLogInput) {
  return prisma.storeProductPriceAdjustmentLog.create({
    data: {
      shopId: input.shopId,
      storeProductId: input.storeProductId,
      pnk: input.pnk ?? null,
      mode: input.mode,
      oldSalePriceExVat: toDecimal(input.oldSalePriceExVat),
      newSalePriceExVat: toDecimal(input.newSalePriceExVat) ?? new Prisma.Decimal(0),
      currency: input.currency ?? null,
      cartPriceRaw: input.cartPriceRaw != null ? sanitizeAndTruncateJson(input.cartPriceRaw) : undefined,
      cartPriceExVat: toDecimal(input.cartPriceExVat),
      vatRate: toDecimal(input.vatRate),
      hardFloorPrice: toDecimal(input.hardFloorPrice),
      suggestedMinPrice: toDecimal(input.suggestedMinPrice),
      manualMinPrice: toDecimal(input.manualMinPrice),
      finalMinPrice: toDecimal(input.finalMinPrice),
      estimatedProfitAfter: toDecimal(input.estimatedProfitAfter),
      profitMarginPctAfter: toDecimal(input.profitMarginPctAfter),
      reason: input.reason,
      operatorUserId: input.operatorUserId ?? null,
      emagRequestPayload: input.emagRequestPayload
        ? sanitizeAndTruncateJson(sanitizePricePayload(input.emagRequestPayload))
        : undefined,
      status: input.status ?? 'PROCESSING',
    },
  });
}

export async function markPriceAdjustmentSuccess(
  logId: number,
  input: {
    emagResponse?: unknown;
    estimatedProfitAfter?: number | null;
    profitMarginPctAfter?: number | null;
  },
): Promise<void> {
  await prisma.storeProductPriceAdjustmentLog.update({
    where: { id: logId },
    data: {
      status: 'SUCCESS',
      errorMessage: null,
      emagResponse: input.emagResponse != null ? sanitizeAndTruncateJson(input.emagResponse) : undefined,
      estimatedProfitAfter: input.estimatedProfitAfter != null ? toDecimal(input.estimatedProfitAfter) : undefined,
      profitMarginPctAfter: input.profitMarginPctAfter != null ? toDecimal(input.profitMarginPctAfter) : undefined,
    },
  });
}

export async function markPriceAdjustmentFailed(
  logId: number,
  input: { emagResponse?: unknown; errorMessage?: string | null },
): Promise<void> {
  await prisma.storeProductPriceAdjustmentLog.update({
    where: { id: logId },
    data: {
      status: 'FAILED',
      emagResponse: input.emagResponse != null ? sanitizeAndTruncateJson(input.emagResponse) : undefined,
      errorMessage: truncateErrorMessage(input.errorMessage),
    },
  });
}

export async function markPriceAdjustmentPendingVerify(
  logId: number,
  input: { emagResponse?: unknown; errorMessage?: string | null },
): Promise<void> {
  await prisma.storeProductPriceAdjustmentLog.update({
    where: { id: logId },
    data: {
      status: 'PENDING_VERIFY',
      emagResponse: input.emagResponse != null ? sanitizeAndTruncateJson(input.emagResponse) : undefined,
      errorMessage: truncateErrorMessage(input.errorMessage),
    },
  });
}

export async function markPriceAdjustmentSkipped(
  logId: number,
  input: { emagResponse?: unknown; errorMessage?: string | null },
): Promise<void> {
  await prisma.storeProductPriceAdjustmentLog.update({
    where: { id: logId },
    data: {
      status: 'SKIPPED',
      emagResponse: input.emagResponse != null ? sanitizeAndTruncateJson(input.emagResponse) : undefined,
      errorMessage: truncateErrorMessage(input.errorMessage ?? '未发送 eMAG 写请求，未真实改价'),
    },
  });
}
