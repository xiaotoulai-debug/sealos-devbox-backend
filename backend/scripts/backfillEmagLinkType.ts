import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import type { EmagRegion } from '../src/services/emagClient';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';
import { normalizeEmagProduct } from '../src/services/emagProductNormalizer';
import {
  inferContentPermission,
  inferEmagLinkType,
  inferLinkActionTips,
  inferOfferCompetition,
} from '../src/services/emagLinkType';

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
  samples: Array<{
    pnk: string;
    linkType: string;
    numberOfOffers: number | null;
    offerCompetitionType: string;
    tips: string[];
  }>;
};

function toJsonOwnership(value: unknown): Prisma.InputJsonValue {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

function buildUpdateData(shopId: number, region: EmagRegion, raw: Record<string, unknown>) {
  const np = normalizeEmagProduct(raw, region, { logOutput: false });
  if (!np.pnk) return null;

  const linkTypeResult = inferEmagLinkType({
    shopId,
    pnk: np.pnk,
    rawApiData: { ownership: np.ownership },
    publishLog: null,
  });
  const contentPermission = inferContentPermission(linkTypeResult.linkType);
  const offerCompetition = inferOfferCompetition({ numberOfOffers: np.numberOfOffers });
  const linkActionTips = inferLinkActionTips(linkTypeResult.linkType, offerCompetition.offerCompetitionType);
  const compactOfferMeta = {
    ownership: np.ownership,
    numberOfOffers: np.numberOfOffers,
    bestOfferSalePrice: np.bestOfferSalePrice,
    mainOfferPrice: np.mainOfferPrice,
    buyButtonRank: np.buyButtonRank,
    partNumberKey: np.pnk,
  };

  return {
    pnk: np.pnk,
    data: {
      emagLinkType: linkTypeResult.linkType,
      emagLinkTypeSource: linkTypeResult.linkTypeSource,
      emagLinkTypeConfidence: linkTypeResult.linkTypeConfidence,
      emagOwnership: toJsonOwnership(np.ownership),
      contentPermission: contentPermission.contentPermission,
      numberOfOffers: offerCompetition.numberOfOffers,
      offerCompetitionType: offerCompetition.offerCompetitionType,
      buyButtonRank: np.buyButtonRank,
      bestOfferSalePrice: np.bestOfferSalePrice,
      mainOfferPrice: np.mainOfferPrice,
      linkActionTips: linkActionTips as Prisma.InputJsonValue,
      emagOfferMeta: compactOfferMeta as Prisma.InputJsonValue,
    },
    sample: {
      pnk: np.pnk,
      linkType: linkTypeResult.linkType,
      numberOfOffers: offerCompetition.numberOfOffers,
      offerCompetitionType: offerCompetition.offerCompetitionType,
      tips: linkActionTips,
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
      try {
        const update = buildUpdateData(targetShopId, creds.region, item);
        if (!update) continue;
        summary.scanned++;
        if (summary.samples.length < 8) summary.samples.push(update.sample);
        if (!dryRun) {
          await prisma.storeProduct.updateMany({
            where: { shopId: targetShopId, pnk: update.pnk, isArchived: false },
            data: update.data,
          });
          summary.updated++;
        }
      } catch (err) {
        summary.errors.push(`page=${page}: ${err instanceof Error ? err.message : String(err)}`);
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

  console.log(`[EmagLinkType] mode=${dryRun ? 'DRY_RUN' : 'FIX'} shops=${shops.map((s) => s.id).join(',')}`);
  for (const shop of shops) {
    const summary = await backfillShop(shop.id);
    console.log(`[EmagLinkType] shopId=${summary.shopId} scanned=${summary.scanned} updated=${summary.updated} errors=${summary.errors.length}`);
    console.log('[EmagLinkType] samples:', JSON.stringify(summary.samples, null, 2));
    if (summary.errors.length > 0) {
      console.warn('[EmagLinkType] errors:', summary.errors.slice(0, 10).join(' | '));
    }
  }
}

main()
  .catch((err) => {
    console.error('[EmagLinkType] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
