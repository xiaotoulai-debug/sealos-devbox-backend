import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';
import { readProductOffers } from './emagProduct';

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
  raw?: unknown;
};

const FORBIDDEN_PRICE_PAYLOAD_FIELDS = new Set([
  'name',
  'description',
  'images',
  'category_id',
  'characteristics',
  'documentation',
]);

function toPositiveInteger(value: string | number | null | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
      errors.push(`${path}.${key} 不允许出现在价格 dry-run payload 中`);
    }
    errors.push(...findForbiddenFields(child, `${path}.${key}`));
  }
  return errors;
}

export function buildProductOfferPriceUpdatePayload(input: BuildPriceUpdatePayloadInput): PriceUpdatePayloadItem[] {
  const id = toPositiveInteger(input.emagOfferId);
  if (!id) throw new Error('emagOfferId 必须是 eMAG product_offer/read 返回的正整数 id');

  const salePrice = toFiniteNumber(input.newSalePriceExVat);
  if (salePrice == null || salePrice <= 0) throw new Error('newSalePriceExVat 必须是大于 0 的不含 VAT 价格');

  const payloadItem: PriceUpdatePayloadItem = {
    id,
    sale_price: Math.round(salePrice * 10000) / 10000,
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
      status: true,
      validationStatus: true,
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
    stock: storeProduct.stock ?? null,
    buyButtonRank: storeProduct.buyButtonRank ?? null,
    bestOfferSalePrice: storeProduct.bestOfferSalePrice != null ? Number(storeProduct.bestOfferSalePrice) : null,
    mainOfferPrice: storeProduct.mainOfferPrice != null ? Number(storeProduct.mainOfferPrice) : null,
    numberOfOffers: storeProduct.numberOfOffers ?? null,
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
    offerValidationStatus: raw.offer_validation_status ?? undefined,
    stock,
    buyButtonRank: toFiniteNumber(raw.buy_button_rank ?? raw.buyButtonRank) ?? base.buyButtonRank ?? null,
    bestOfferSalePrice: toFiniteNumber(raw.best_offer_sale_price ?? raw.bestOfferSalePrice) ?? base.bestOfferSalePrice ?? null,
    mainOfferPrice: toFiniteNumber(raw.main_offer_price ?? raw.mainOfferPrice) ?? base.mainOfferPrice ?? null,
    numberOfOffers: toFiniteNumber(raw.number_of_offers ?? raw.numberOfOffers) ?? base.numberOfOffers ?? null,
    vatId: toPositiveInteger(raw.vat_id as string | number | null | undefined),
    raw,
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
