import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import type { EmagRegion } from '../src/services/emagClient';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';
import { normalizeEmagProduct } from '../src/services/emagProductNormalizer';
import { inferBuyBoxStatus, type BuyBoxStatus } from '../src/services/emagBuyBox';

const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 1000;
const PRODUCT_OFFER_TIMEOUT = 180_000;

const shopArg = process.argv.find((arg) => arg.startsWith('--shopId='));
const dryRunArg = process.argv.find((arg) => arg.startsWith('--dryRun='));
const fixMode = process.argv.includes('--fix');
const shopId = shopArg ? Number(shopArg.split('=')[1]) : undefined;
const dryRun = dryRunArg ? dryRunArg.split('=')[1] !== 'false' : !fixMode;

type BackfillSummary = {
  shopId: number;
  scanned: number;
  updated: number;
  errors: string[];
  statusCounts: Record<BuyBoxStatus, number>;
  samples: Array<{
    pnk: string;
    buyBoxStatus: BuyBoxStatus;
    buyBoxRank: number | null;
    stock: number;
    numberOfOffers: number | null;
  }>;
};

function emptyStatusCounts(): Record<BuyBoxStatus, number> {
  return {
    WON: 0,
    LOST: 0,
    NO_ACTIVE_BUYBOX: 0,
    POSSIBLY_WON: 0,
    POSSIBLY_LOST: 0,
    UNKNOWN: 0,
  };
}

function buildUpdateData(region: EmagRegion, raw: Record<string, unknown>) {
  const np = normalizeEmagProduct(raw, region, { logOutput: false });
  if (!np.pnk) return null;

  const buyBoxResult = inferBuyBoxStatus({
    buyButtonRank: np.buyButtonRank,
    salePrice: np.salePrice,
    bestOfferSalePrice: np.bestOfferSalePrice,
    mainOfferPrice: np.mainOfferPrice,
    stock: np.stock,
    status: np.status,
    offerValidationStatus: np.offerValidationStatus,
    numberOfOffers: np.numberOfOffers,
  });
  const buyBoxMeta = {
    buyButtonRank: np.buyButtonRank,
    salePrice: np.salePrice,
    bestOfferSalePrice: np.bestOfferSalePrice,
    mainOfferPrice: np.mainOfferPrice,
    stock: np.stock,
    offerValidationStatus: np.offerValidationStatus,
    numberOfOffers: np.numberOfOffers,
    checkedAt: new Date().toISOString(),
  };

  return {
    pnk: np.pnk,
    data: {
      buyButtonRank: np.buyButtonRank,
      bestOfferSalePrice: np.bestOfferSalePrice,
      mainOfferPrice: np.mainOfferPrice,
      buyBoxStatus: buyBoxResult.buyBoxStatus,
      buyBoxStatusSource: buyBoxResult.buyBoxStatusSource,
      buyBoxStatusConfidence: buyBoxResult.buyBoxStatusConfidence,
      buyBoxRank: buyBoxResult.buyBoxRank,
      buyBoxActionTips: buyBoxResult.buyBoxActionTips as Prisma.InputJsonValue,
      buyBoxMeta: buyBoxMeta as Prisma.InputJsonValue,
    },
    sample: {
      pnk: np.pnk,
      buyBoxStatus: buyBoxResult.buyBoxStatus,
      buyBoxRank: buyBoxResult.buyBoxRank,
      stock: np.stock,
      numberOfOffers: np.numberOfOffers,
    },
  };
}

async function backfillShop(targetShopId: number): Promise<BackfillSummary> {
  const creds = await getEmagCredentials(targetShopId);
  const summary: BackfillSummary = {
    shopId: targetShopId,
    scanned: 0,
    updated: 0,
    errors: [],
    statusCounts: emptyStatusCounts(),
    samples: [],
  };

  for (let page = 1; page <= 500; page++) {
    const res = await readProductOffers(
      creds,
      { currentPage: page, itemsPerPage: PAGE_SIZE },
      { timeout: PRODUCT_OFFER_TIMEOUT },
    );

    if (res.isError) {
      summary.errors.push(`page=${page}: ${res.messages?.join('; ') ?? 'eMAG API error'}`);
      break;
    }

    const raw = res.results as any;
    const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
    if (batch.length === 0) break;

    for (const item of batch) {
      const itemKey = item?.part_number_key ?? item?.part_number ?? item?.pnk ?? '(unknown)';
      try {
        const update = buildUpdateData(creds.region, item);
        if (!update) continue;
        summary.scanned++;
        summary.statusCounts[update.sample.buyBoxStatus]++;
        if (summary.samples.length < 10) summary.samples.push(update.sample);
        if (!dryRun) {
          await prisma.storeProduct.updateMany({
            where: { shopId: targetShopId, pnk: update.pnk, isArchived: false },
            data: update.data,
          });
          summary.updated++;
        }
      } catch (err) {
        summary.errors.push(`page=${page} item=${itemKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (batch.length < PAGE_SIZE) break;
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  }

  return summary;
}

async function main() {
  if (shopArg && (!Number.isInteger(shopId) || shopId! <= 0)) {
    throw new Error(`shopId 无效：${shopArg}`);
  }

  const shops = shopId
    ? [{ id: shopId }]
    : await prisma.shopAuthorization.findMany({
        where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });

  console.log(`[BuyBoxBackfill] mode=${dryRun ? 'DRY_RUN' : 'FIX'} shops=${shops.map((s) => s.id).join(',')}`);
  for (const shop of shops) {
    const summary = await backfillShop(shop.id);
    console.log(`[BuyBoxBackfill] shopId=${summary.shopId} scanned=${summary.scanned} updated=${summary.updated} errors=${summary.errors.length}`);
    console.log('[BuyBoxBackfill] statusCounts:', JSON.stringify(summary.statusCounts, null, 2));
    console.log('[BuyBoxBackfill] samples:', JSON.stringify(summary.samples, null, 2));
    if (summary.errors.length > 0) {
      console.warn('[BuyBoxBackfill] errors:', summary.errors.slice(0, 10).join(' | '));
    }
  }
}

main()
  .catch((err) => {
    console.error('[BuyBoxBackfill] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
