import { prisma } from '../lib/prisma';
import { getEmagCredentials, type EmagCredentials } from './emagClient';
import { readProductOffers } from './emagProduct';
import { normalizeEmagProduct, normalizeVatId, resolveKnownVatRate } from './emagProductNormalizer';

const VAT_BACKFILL_ITEMS_PER_PAGE = 50;
const VAT_BACKFILL_MAX_LIMIT_PER_SHOP = 500;
const VAT_BACKFILL_PAGE_TIMEOUT_MS = 180_000;
const VAT_BACKFILL_SHOP_DELAY_MS = 800;
const VAT_BACKFILL_PAGE_DELAY_MS = 350;
const VAT_BACKFILL_MAX_RETRIES = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type VatBackfillItemStatus = 'PLANNED' | 'UPDATED' | 'SKIPPED' | 'FAILED';

export type VatBackfillItem = {
  storeProductId: number;
  sku: string | null;
  emagOfferId: string | null;
  oldVatId: number | null;
  newVatId: number | null;
  oldVatRate: number | null;
  newVatRate: number | null;
  status: VatBackfillItemStatus;
  message?: string;
};

export type VatBackfillShopResult = {
  shopId: number;
  shopName?: string | null;
  scanned: number;
  planned: number;
  updated: number;
  skipped: number;
  failed: number;
  unknownVatIds: number[];
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
): StoreProductVatMatch | null {
  const extId = numericString(normalized.emagOfferId ?? raw.id);
  if (extId) {
    const byOfferId = candidates.find((item) => item.emagOfferId === extId);
    if (byOfferId) return byOfferId;
  }

  if (normalized.pnk) {
    const byPnk = candidates.find((item) => item.pnk === normalized.pnk);
    if (byPnk) return byPnk;
  }

  const skuKeys = [normalized.sku, normalized.vendorSku]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  for (const key of skuKeys) {
    const bySku = candidates.find((item) => item.sku === key || item.vendorSku === key);
    if (bySku) return bySku;
  }

  return null;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) < 0.000001;
}

async function runVatBackfillForShop(params: {
  shop: { id: number; shopName?: string | null };
  dryRun: boolean;
  limit: number;
}): Promise<VatBackfillShopResult> {
  const { shop, dryRun } = params;
  const limit = Math.max(1, Math.min(params.limit, VAT_BACKFILL_MAX_LIMIT_PER_SHOP));
  const creds = await getEmagCredentials(shop.id);

  const result: VatBackfillShopResult = {
    shopId: shop.id,
    shopName: shop.shopName ?? null,
    scanned: 0,
    planned: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    unknownVatIds: [],
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

  let page = 1;
  while (result.scanned < limit) {
    const batch = await readProductOffersWithRetry(creds, {
      currentPage: page,
      itemsPerPage: Math.min(VAT_BACKFILL_ITEMS_PER_PAGE, limit - result.scanned),
    });
    if (batch.length === 0) break;

    for (const raw of batch) {
      if (result.scanned >= limit) break;
      result.scanned++;
      try {
        const normalized = normalizeEmagProduct(raw, creds.region, { logOutput: false });
        const rawVatId = raw.vat_id ?? raw.vatId;
        const newVatId = normalizeVatId(rawVatId);
        const newVatRate = resolveKnownVatRate(newVatId, raw.vat_rate ?? raw.vatRate);

        const match = resolveStoreProductMatch(normalized, raw, storeProducts);
        if (!match) {
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

        if (dryRun) {
          result.planned++;
          result.items.push({
            storeProductId: match.id,
            sku: match.sku,
            emagOfferId: match.emagOfferId,
            oldVatId: match.vatId,
            newVatId,
            oldVatRate,
            newVatRate,
            status: 'PLANNED',
          });
          continue;
        }

        const oldVatId = match.vatId;
        await prisma.storeProduct.update({
          where: { id: match.id },
          data: {
            ...(newVatId !== null ? { vatId: newVatId } : {}),
            ...(newVatRate !== null ? { vatRate: newVatRate } : {}),
          },
        });
        match.vatId = newVatId ?? match.vatId;
        match.vatRate = newVatRate ?? match.vatRate;
        result.updated++;
        result.items.push({
          storeProductId: match.id,
          sku: match.sku,
          emagOfferId: match.emagOfferId,
          oldVatId,
          newVatId,
          oldVatRate,
          newVatRate,
          status: 'UPDATED',
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

    if (batch.length < VAT_BACKFILL_ITEMS_PER_PAGE) break;
    page++;
    await sleep(VAT_BACKFILL_PAGE_DELAY_MS);
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
  for (const shop of shops) {
    results.push(await runVatBackfillForShop({
      shop,
      dryRun,
      limit: allShops ? limitPerShop : limit,
    }));
    if (allShops) await sleep(VAT_BACKFILL_SHOP_DELAY_MS);
  }

  return { dryRun, allShops, shops: results };
}
