import { prisma } from '../lib/prisma';
import { emagApiCall, getEmagCredentials, type EmagCredentials } from './emagClient';
import { readProductOffers } from './emagProduct';
import { normalizeEmagProduct, normalizeVatId, normalizeVatRate, resolveKnownVatRate } from './emagProductNormalizer';

const VAT_BACKFILL_ITEMS_PER_PAGE = 50;
const VAT_BACKFILL_MAX_LIMIT_PER_SHOP = 5_000;
const VAT_BACKFILL_PAGE_TIMEOUT_MS = 180_000;
const VAT_BACKFILL_SHOP_DELAY_MS = 800;
const VAT_BACKFILL_PAGE_DELAY_MS = 350;
const VAT_BACKFILL_MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type VatReadStatus = 'SUCCESS' | 'FAILED';
type VatMatchSource = 'EMAG_OFFER_ID' | 'PNK' | 'SKU';

export type VatBackfillItemStatus = 'PLANNED' | 'UPDATED' | 'SKIPPED' | 'FAILED' | 'SKIPPED_DUPLICATE' | 'FAILED_AMBIGUOUS';

export type VatBackfillItem = {
  storeProductId: number;
  sku: string | null;
  emagOfferId: string | null;
  selectedOfferId?: string | null;
  selectedMatchSource?: VatMatchSource;
  duplicateOfferIds?: string[];
  oldVatId: number | null;
  newVatId: number | null;
  oldVatRate: number | null;
  newVatRate: number | null;
  status: VatBackfillItemStatus;
  message?: string;
};

export type VatBackfillDuplicateMatch = {
  storeProductId: number;
  selectedOfferId: string | null;
  selectedMatchSource: VatMatchSource;
  duplicateOfferIds: string[];
  duplicateMatchSource: VatMatchSource;
  duplicateVatId: number | null;
  duplicateVatRate: number | null;
  message: string;
};

export type VatBackfillAmbiguousMatch = {
  storeProductId: number;
  selectedOfferId: string | null;
  selectedMatchSource: VatMatchSource;
  selectedVatId: number | null;
  selectedVatRate: number | null;
  conflictingOfferIds: string[];
  conflictingMatchSource: VatMatchSource;
  conflictingVatId: number | null;
  conflictingVatRate: number | null;
  message: string;
};

export type VatBackfillShopResult = {
  shopId: number;
  shopName?: string | null;
  vatReadStatus: VatReadStatus;
  vatReadError?: string | null;
  scanned: number;
  pagesRead: number;
  reachedLimit: boolean;
  planned: number;
  updated: number;
  skipped: number;
  failed: number;
  unknownVatIds: number[];
  duplicateMatchCount: number;
  duplicateMatches: VatBackfillDuplicateMatch[];
  ambiguousMatchCount: number;
  ambiguousMatches: VatBackfillAmbiguousMatch[];
  items: VatBackfillItem[];
};

export type VatBackfillResult = {
  dryRun: boolean;
  allShops: boolean;
  shops: VatBackfillShopResult[];
};

type StoreProductVatMatch = {
  id: number;
  sku: string | null;
  vendorSku: string | null;
  pnk: string;
  emagOfferId: string | null;
  vatId: number | null;
  vatRate: unknown;
};

type VatReadResult = {
  status: VatReadStatus;
  rates: Map<number, number>;
  error?: string | null;
};

type StoreProductVatMatchResult = {
  match: StoreProductVatMatch;
  source: VatMatchSource;
  priority: number;
};

type VatBackfillCandidate = {
  match: StoreProductVatMatch;
  matchSource: VatMatchSource;
  matchPriority: number;
  sku: string | null;
  emagOfferId: string | null;
  oldVatId: number | null;
  newVatId: number | null;
  oldVatRate: number | null;
  newVatRate: number | null;
};

function extractOfferBatch(results: unknown): Record<string, unknown>[] {
  if (Array.isArray(results)) return results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  if (results && typeof results === 'object') {
    const obj = results as Record<string, unknown>;
    const items = obj.items ?? obj.results;
    if (Array.isArray(items)) return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  return [];
}

function numericString(value: unknown): string | null {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text : null;
}

function extractVatReadRows(results: unknown): Record<string, unknown>[] {
  if (Array.isArray(results)) return results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  if (results && typeof results === 'object') {
    const obj = results as Record<string, unknown>;
    const items = obj.items ?? obj.results ?? obj.vats ?? obj.vat;
    if (Array.isArray(items)) return items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }
  return [];
}

async function fetchVatRatesForCredentials(creds: EmagCredentials): Promise<VatReadResult> {
  try {
    const res = await emagApiCall(creds, 'vat', 'read', {}, { timeout: 60_000 });
    if (res.isError) {
      return {
        status: 'FAILED',
        rates: new Map(),
        error: res.messages?.join('; ') ?? JSON.stringify(res.errors ?? res).slice(0, 300),
      };
    }

    const rates = new Map<number, number>();
    for (const row of extractVatReadRows(res.results)) {
      const vatId = normalizeVatId(row.vat_id ?? row.vatId ?? row.id);
      const vatRate = normalizeVatRate(row.vat_rate ?? row.vatRate ?? row.rate);
      if (vatId !== null && vatRate !== null) rates.set(vatId, vatRate);
    }

    return { status: 'SUCCESS', rates, error: null };
  } catch (err: any) {
    return {
      status: 'FAILED',
      rates: new Map(),
      error: err?.message ?? String(err),
    };
  }
}

export async function fetchVatRatesForShop(shopId: number): Promise<Map<number, number>> {
  const creds = await getEmagCredentials(shopId);
  const result = await fetchVatRatesForCredentials(creds);
  return result.rates;
}

function resolveBackfillVatRate(params: {
  vatId: number | null;
  rawVatRate: unknown;
  shopVatRates: Map<number, number>;
}): number | null {
  const rawRate = normalizeVatRate(params.rawVatRate);
  if (rawRate !== null) return rawRate;
  if (params.vatId !== null && params.shopVatRates.has(params.vatId)) {
    return params.shopVatRates.get(params.vatId)!;
  }
  return resolveKnownVatRate(params.vatId, null);
}

async function readProductOffersWithRetry(
  creds: EmagCredentials,
  filters: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= VAT_BACKFILL_MAX_RETRIES; attempt++) {
    const res = await readProductOffers(creds, filters, { timeout: VAT_BACKFILL_PAGE_TIMEOUT_MS });
    if (!res.isError) return extractOfferBatch(res.results);

    lastError = res.messages?.join('; ') ?? JSON.stringify(res.errors ?? res).slice(0, 300);
    const retryable = /429|rate|timeout|temporar|5\d\d/i.test(lastError);
    if (!retryable || attempt === VAT_BACKFILL_MAX_RETRIES) {
      throw new Error(lastError || 'product_offer/read 返回错误');
    }
    await sleep(1000 * Math.pow(3, attempt));
  }
  throw new Error(lastError || 'product_offer/read 重试失败');
}

function resolveStoreProductMatch(
  normalized: ReturnType<typeof normalizeEmagProduct>,
  raw: Record<string, unknown>,
  candidates: StoreProductVatMatch[],
): StoreProductVatMatchResult | null {
  const extId = numericString(normalized.emagOfferId ?? raw.id);
  if (extId) {
    const byOfferId = candidates.find((item) => item.emagOfferId === extId);
    if (byOfferId) return { match: byOfferId, source: 'EMAG_OFFER_ID', priority: 3 };
  }

  if (normalized.pnk) {
    const byPnk = candidates.find((item) => item.pnk === normalized.pnk);
    if (byPnk) return { match: byPnk, source: 'PNK', priority: 2 };
  }

  const skuKeys = [normalized.sku, normalized.vendorSku]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  for (const key of skuKeys) {
    const bySku = candidates.find((item) => item.sku === key || item.vendorSku === key);
    if (bySku) return { match: bySku, source: 'SKU', priority: 1 };
  }

  return null;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) < 0.000001;
}

function sameVatCandidate(left: VatBackfillCandidate, right: VatBackfillCandidate): boolean {
  return left.newVatId === right.newVatId && sameNullableNumber(left.newVatRate, right.newVatRate);
}

function buildVatBackfillItem(
  candidate: VatBackfillCandidate,
  status: VatBackfillItemStatus,
  message?: string,
): VatBackfillItem {
  return {
    storeProductId: candidate.match.id,
    sku: candidate.match.sku,
    emagOfferId: candidate.match.emagOfferId,
    selectedOfferId: candidate.emagOfferId,
    selectedMatchSource: candidate.matchSource,
    oldVatId: candidate.oldVatId,
    newVatId: candidate.newVatId,
    oldVatRate: candidate.oldVatRate,
    newVatRate: candidate.newVatRate,
    status,
    ...(message ? { message } : {}),
  };
}

function buildDuplicateMatch(
  selected: VatBackfillCandidate,
  duplicate: VatBackfillCandidate,
  message: string,
): VatBackfillDuplicateMatch {
  return {
    storeProductId: selected.match.id,
    selectedOfferId: selected.emagOfferId,
    selectedMatchSource: selected.matchSource,
    duplicateOfferIds: [duplicate.emagOfferId].filter((value): value is string => !!value),
    duplicateMatchSource: duplicate.matchSource,
    duplicateVatId: duplicate.newVatId,
    duplicateVatRate: duplicate.newVatRate,
    message,
  };
}

function buildAmbiguousMatch(
  selected: VatBackfillCandidate,
  conflicting: VatBackfillCandidate,
): VatBackfillAmbiguousMatch {
  return {
    storeProductId: selected.match.id,
    selectedOfferId: selected.emagOfferId,
    selectedMatchSource: selected.matchSource,
    selectedVatId: selected.newVatId,
    selectedVatRate: selected.newVatRate,
    conflictingOfferIds: [conflicting.emagOfferId].filter((value): value is string => !!value),
    conflictingMatchSource: conflicting.matchSource,
    conflictingVatId: conflicting.newVatId,
    conflictingVatRate: conflicting.newVatRate,
    message: '同优先级重复匹配返回了不一致的 VAT 数据',
  };
}

async function runVatBackfillForShop(params: {
  shop: { id: number; shopName?: string | null };
  dryRun: boolean;
  limit: number;
  vatReadCache: Map<number, Promise<VatReadResult>>;
}): Promise<VatBackfillShopResult> {
  const { shop, dryRun } = params;
  const limit = Math.max(1, Math.min(params.limit, VAT_BACKFILL_MAX_LIMIT_PER_SHOP));
  const creds = await getEmagCredentials(shop.id);
  let vatReadPromise = params.vatReadCache.get(shop.id);
  if (!vatReadPromise) {
    vatReadPromise = fetchVatRatesForCredentials(creds);
    params.vatReadCache.set(shop.id, vatReadPromise);
  }
  const vatRead = await vatReadPromise;

  const result: VatBackfillShopResult = {
    shopId: shop.id,
    shopName: shop.shopName ?? null,
    vatReadStatus: vatRead.status,
    vatReadError: vatRead.error ?? null,
    scanned: 0,
    pagesRead: 0,
    reachedLimit: false,
    planned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    unknownVatIds: [],
    duplicateMatchCount: 0,
    duplicateMatches: [],
    ambiguousMatchCount: 0,
    ambiguousMatches: [],
    items: [],
  };

  const storeProducts = await prisma.storeProduct.findMany({
    where: { shopId: shop.id, isArchived: false },
    select: {
      id: true,
      sku: true,
      vendorSku: true,
      pnk: true,
      emagOfferId: true,
      vatId: true,
      vatRate: true,
    },
  });

  const updateCandidates: VatBackfillCandidate[] = [];
  let page = 1;
  while (result.scanned < limit) {
    const batch = await readProductOffersWithRetry(creds, {
      currentPage: page,
      itemsPerPage: Math.min(VAT_BACKFILL_ITEMS_PER_PAGE, limit - result.scanned),
    });
    result.pagesRead++;
    if (batch.length === 0) break;

    for (const raw of batch) {
      if (result.scanned >= limit) break;
      result.scanned++;
      try {
        const normalized = normalizeEmagProduct(raw, creds.region, { logOutput: false });
        const rawVatId = raw.vat_id ?? raw.vatId;
        const newVatId = normalizeVatId(rawVatId);
        const newVatRate = resolveBackfillVatRate({
          vatId: newVatId,
          rawVatRate: raw.vat_rate ?? raw.vatRate,
          shopVatRates: vatRead.rates,
        });

        const matchResult = resolveStoreProductMatch(normalized, raw, storeProducts);
        if (!matchResult) {
          result.failed++;
          result.items.push({
            storeProductId: 0,
            sku: normalized.sku,
            emagOfferId: normalized.emagOfferId,
            oldVatId: null,
            newVatId,
            oldVatRate: null,
            newVatRate,
            status: 'FAILED',
            message: '未找到匹配的 StoreProduct',
          });
          continue;
        }
        const { match, source, priority } = matchResult;

        if (newVatId !== null && newVatRate === null && !result.unknownVatIds.includes(newVatId)) {
          result.unknownVatIds.push(newVatId);
        }

        const oldVatRate = match.vatRate != null ? Number(match.vatRate) : null;
        const hasNewValue = newVatId !== null || newVatRate !== null;
        if (!hasNewValue) {
          result.skipped++;
          result.items.push({
            storeProductId: match.id,
            sku: match.sku,
            emagOfferId: match.emagOfferId,
            oldVatId: match.vatId,
            newVatId,
            oldVatRate,
            newVatRate,
            status: 'SKIPPED',
            message: 'eMAG 未返回 vat_id / vat_rate',
          });
          continue;
        }

        const unchanged = (newVatId === null || match.vatId === newVatId)
          && (newVatRate === null || sameNullableNumber(oldVatRate, newVatRate));
        if (unchanged) {
          result.skipped++;
          result.items.push({
            storeProductId: match.id,
            sku: match.sku,
            emagOfferId: match.emagOfferId,
            oldVatId: match.vatId,
            newVatId,
            oldVatRate,
            newVatRate,
            status: 'SKIPPED',
            message: 'VAT 数据已是最新',
          });
          continue;
        }

        updateCandidates.push({
          match,
          matchSource: source,
          matchPriority: priority,
          sku: normalized.sku,
          emagOfferId: normalized.emagOfferId ?? numericString(raw.id),
          oldVatId: match.vatId,
          newVatId,
          oldVatRate,
          newVatRate,
        });
      } catch (err: any) {
        result.failed++;
        result.items.push({
          storeProductId: 0,
          sku: null,
          emagOfferId: null,
          oldVatId: null,
          newVatId: null,
          oldVatRate: null,
          newVatRate: null,
          status: 'FAILED',
          message: err?.message ?? String(err),
        });
      }
    }

    if (result.scanned >= limit) {
      result.reachedLimit = true;
      break;
    }
    if (batch.length < VAT_BACKFILL_ITEMS_PER_PAGE) break;
    page++;
    await sleep(VAT_BACKFILL_PAGE_DELAY_MS);
  }

  const selectedByStoreProductId = new Map<number, VatBackfillCandidate>();
  const ambiguousByStoreProductId = new Map<number, VatBackfillAmbiguousMatch>();
  const duplicates: Array<{ selected: VatBackfillCandidate; duplicate: VatBackfillCandidate; message: string }> = [];

  for (const candidate of updateCandidates) {
    const storeProductId = candidate.match.id;
    const ambiguous = ambiguousByStoreProductId.get(storeProductId);
    if (ambiguous) {
      ambiguous.conflictingOfferIds.push(...[candidate.emagOfferId].filter((value): value is string => !!value));
      continue;
    }

    const selected = selectedByStoreProductId.get(storeProductId);
    if (!selected) {
      selectedByStoreProductId.set(storeProductId, candidate);
      continue;
    }

    if (candidate.matchPriority > selected.matchPriority) {
      selectedByStoreProductId.set(storeProductId, candidate);
      duplicates.push({
        selected: candidate,
        duplicate: selected,
        message: '更高优先级匹配替换了此前候选',
      });
      continue;
    }

    if (candidate.matchPriority < selected.matchPriority) {
      duplicates.push({
        selected,
        duplicate: candidate,
        message: '低优先级重复匹配已跳过',
      });
      continue;
    }

    if (sameVatCandidate(selected, candidate)) {
      duplicates.push({
        selected,
        duplicate: candidate,
        message: '同优先级重复匹配 VAT 完全一致，保留首个候选',
      });
      continue;
    }

    selectedByStoreProductId.delete(storeProductId);
    ambiguousByStoreProductId.set(storeProductId, buildAmbiguousMatch(selected, candidate));
  }

  for (const duplicate of duplicates) {
    result.skipped++;
    result.duplicateMatches.push(buildDuplicateMatch(duplicate.selected, duplicate.duplicate, duplicate.message));
    result.items.push({
      ...buildVatBackfillItem(duplicate.duplicate, 'SKIPPED_DUPLICATE', duplicate.message),
      selectedOfferId: duplicate.selected.emagOfferId,
      selectedMatchSource: duplicate.selected.matchSource,
      duplicateOfferIds: [duplicate.duplicate.emagOfferId].filter((value): value is string => !!value),
    });
  }
  result.duplicateMatchCount = result.duplicateMatches.length;

  for (const ambiguous of ambiguousByStoreProductId.values()) {
    result.failed++;
    result.ambiguousMatches.push(ambiguous);
    result.items.push({
      storeProductId: ambiguous.storeProductId,
      sku: null,
      emagOfferId: ambiguous.selectedOfferId,
      selectedOfferId: ambiguous.selectedOfferId,
      selectedMatchSource: ambiguous.selectedMatchSource,
      duplicateOfferIds: ambiguous.conflictingOfferIds,
      oldVatId: null,
      newVatId: ambiguous.conflictingVatId,
      oldVatRate: null,
      newVatRate: ambiguous.conflictingVatRate,
      status: 'FAILED_AMBIGUOUS',
      message: ambiguous.message,
    });
  }
  result.ambiguousMatchCount = result.ambiguousMatches.length;

  if (!dryRun && result.ambiguousMatchCount > 0) {
    return result;
  }

  for (const candidate of selectedByStoreProductId.values()) {
    if (dryRun) {
      result.planned++;
      result.items.push(buildVatBackfillItem(candidate, 'PLANNED'));
      continue;
    }

    const oldVatId = candidate.match.vatId;
    await prisma.storeProduct.update({
      where: { id: candidate.match.id },
      data: {
        ...(candidate.newVatId !== null ? { vatId: candidate.newVatId } : {}),
        ...(candidate.newVatRate !== null ? { vatRate: candidate.newVatRate } : {}),
      },
    });
    candidate.match.vatId = candidate.newVatId ?? candidate.match.vatId;
    candidate.match.vatRate = candidate.newVatRate ?? candidate.match.vatRate;
    result.updated++;
    result.items.push({
      ...buildVatBackfillItem(candidate, 'UPDATED'),
      oldVatId,
    });
  }

  return result;
}

export async function backfillVatData(params: {
  shopId?: number;
  allShops?: boolean;
  dryRun?: boolean;
  limit?: number;
  limitPerShop?: number;
}): Promise<VatBackfillResult> {
  const dryRun = params.dryRun !== false;
  const allShops = params.allShops === true;
  const limit = Math.max(1, Math.min(params.limit ?? params.limitPerShop ?? 100, VAT_BACKFILL_MAX_LIMIT_PER_SHOP));
  const limitPerShop = Math.max(1, Math.min(params.limitPerShop ?? params.limit ?? 100, VAT_BACKFILL_MAX_LIMIT_PER_SHOP));

  const shops = allShops
    ? await prisma.shopAuthorization.findMany({
        where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
        select: { id: true, shopName: true },
        orderBy: { id: 'asc' },
      })
    : await prisma.shopAuthorization.findMany({
        where: { id: params.shopId, platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
        select: { id: true, shopName: true },
      });

  if (!allShops && shops.length === 0) {
    throw new Error('未找到指定 eMAG 店铺');
  }

  const results: VatBackfillShopResult[] = [];
  const vatReadCache = new Map<number, Promise<VatReadResult>>();
  for (const shop of shops) {
    results.push(await runVatBackfillForShop({
      shop,
      dryRun,
      limit: allShops ? limitPerShop : limit,
      vatReadCache,
    }));
    if (allShops) await sleep(VAT_BACKFILL_SHOP_DELAY_MS);
  }

  return { dryRun, allShops, shops: results };
}
