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
  normalizeOwnershipDisplay,
  type EmagLinkType,
  type LinkTypeReason,
} from '../src/services/emagLinkType';

const PAGE_SIZE = 20;
const PAGE_DELAY_MS = 1000;
const PRODUCT_OFFER_TIMEOUT = 180_000;

const shopArg = process.argv.find((arg) => arg.startsWith('--shopId='));
const dryRunArg = process.argv.find((arg) => arg.startsWith('--dryRun='));
const allEmagShopsArg = process.argv.find((arg) => arg.startsWith('--allEmagShops='));
const fixMode = process.argv.includes('--fix');
const shopId = shopArg ? Number(shopArg.split('=')[1]) : undefined;
const allEmagShops = allEmagShopsArg ? allEmagShopsArg.split('=')[1] === 'true' : false;
const dryRun = dryRunArg ? dryRunArg.split('=')[1] !== 'false' : !fixMode;

type ChangeSample = {
  pnk: string;
  sku: string | null;
  brand: string | null;
  ownership: 1 | 2 | null;
  oldLinkType: string | null;
  newLinkType: EmagLinkType;
  reason: LinkTypeReason | null;
};

type TransitionStats = {
  selfBuiltToResell: number;
  selfBuiltToOwnBrandResell: number;
  selfBuiltToUnknown: number;
  selfBuiltToSelfBuilt: number;
  resellToOwnBrandResell: number;
  resellToResell: number;
  resellToSelfBuilt: number;
  resellToUnknown: number;
  unknownToResell: number;
  unknownToOwnBrandResell: number;
  unknownToSelfBuilt: number;
  unknownToUnknown: number;
  toUnknown: number;
  anyChange: number;
};

type BackfillSummary = {
  shopId: number;
  shopName: string;
  region: string;
  scanned: number;
  updated: number;
  errors: string[];
  transitions: TransitionStats;
  changeSamples: ChangeSample[];
  samples: Array<{
    pnk: string;
    linkType: string;
    linkTypeReason: LinkTypeReason | null;
    brand: string | null;
    numberOfOffers: number | null;
    offerCompetitionType: string;
    tips: string[];
  }>;
};

function emptyTransitionStats(): TransitionStats {
  return {
    selfBuiltToResell: 0,
    selfBuiltToOwnBrandResell: 0,
    selfBuiltToUnknown: 0,
    selfBuiltToSelfBuilt: 0,
    resellToOwnBrandResell: 0,
    resellToResell: 0,
    resellToSelfBuilt: 0,
    resellToUnknown: 0,
    unknownToResell: 0,
    unknownToOwnBrandResell: 0,
    unknownToSelfBuilt: 0,
    unknownToUnknown: 0,
    toUnknown: 0,
    anyChange: 0,
  };
}

function normalizeOldLinkType(value: string | null | undefined): string {
  if (value === 'SELF_BUILT' || value === 'RESELL' || value === 'OWN_BRAND_RESELL' || value === 'UNKNOWN') return value;
  return value ?? 'NULL';
}

function recordTransition(stats: TransitionStats, oldRaw: string | null | undefined, newType: EmagLinkType): void {
  const oldType = normalizeOldLinkType(oldRaw);
  if (oldType === newType) return;
  stats.anyChange++;

  if (newType === 'UNKNOWN') stats.toUnknown++;

  if (oldType === 'SELF_BUILT' && newType === 'RESELL') stats.selfBuiltToResell++;
  else if (oldType === 'SELF_BUILT' && newType === 'OWN_BRAND_RESELL') stats.selfBuiltToOwnBrandResell++;
  else if (oldType === 'SELF_BUILT' && newType === 'UNKNOWN') stats.selfBuiltToUnknown++;
  else if (oldType === 'RESELL' && newType === 'OWN_BRAND_RESELL') stats.resellToOwnBrandResell++;
  else if (oldType === 'RESELL' && newType === 'SELF_BUILT') stats.resellToSelfBuilt++;
  else if (oldType === 'RESELL' && newType === 'UNKNOWN') stats.resellToUnknown++;
  else if (oldType === 'UNKNOWN' && newType === 'RESELL') stats.unknownToResell++;
  else if (oldType === 'UNKNOWN' && newType === 'OWN_BRAND_RESELL') stats.unknownToOwnBrandResell++;
  else if (oldType === 'UNKNOWN' && newType === 'SELF_BUILT') stats.unknownToSelfBuilt++;
}

function toJsonOwnership(value: unknown): Prisma.InputJsonValue {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

function buildUpdateData(shopId: number, region: EmagRegion, raw: Record<string, unknown>) {
  const np = normalizeEmagProduct(raw, region, { logOutput: false });
  if (!np.pnk) return null;

  const linkTypeResult = inferEmagLinkType({
    shopId,
    pnk: np.pnk,
    rawApiData: { ownership: np.ownership, brand: np.brand },
    publishLog: null,
  });
  const contentPermission = inferContentPermission(linkTypeResult.linkType);
  const offerCompetition = inferOfferCompetition({ numberOfOffers: np.numberOfOffers });
  const linkActionTips = inferLinkActionTips(linkTypeResult.linkType, offerCompetition.offerCompetitionType);
  const compactOfferMeta = {
    ownership: np.ownership,
    brand: np.brand,
    brandSource: np.brand ? 'API' as const : 'EMPTY' as const,
    linkTypeReason: linkTypeResult.linkTypeReason,
    numberOfOffers: np.numberOfOffers,
    bestOfferSalePrice: np.bestOfferSalePrice,
    mainOfferPrice: np.mainOfferPrice,
    buyButtonRank: np.buyButtonRank,
    partNumberKey: np.pnk,
  };

  return {
    pnk: np.pnk,
    sku: np.sku ?? np.vendorSku ?? null,
    brand: np.brand,
    ownership: normalizeOwnershipDisplay(np.ownership),
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
      linkTypeReason: linkTypeResult.linkTypeReason,
      brand: np.brand,
      numberOfOffers: offerCompetition.numberOfOffers,
      offerCompetitionType: offerCompetition.offerCompetitionType,
      tips: linkActionTips,
    },
    linkTypeResult,
  };
}

async function backfillShop(
  targetShopId: number,
  shopMeta: { shopName: string; region: string },
): Promise<BackfillSummary> {
  const creds = await getEmagCredentials(targetShopId);
  const existingRows = await prisma.storeProduct.findMany({
    where: { shopId: targetShopId, isArchived: false },
    select: { pnk: true, emagLinkType: true, sku: true, vendorSku: true },
  });
  const existingByPnk = new Map(existingRows.map((row) => [row.pnk, row]));

  const summary: BackfillSummary = {
    shopId: targetShopId,
    shopName: shopMeta.shopName,
    region: shopMeta.region,
    scanned: 0,
    updated: 0,
    errors: [],
    transitions: emptyTransitionStats(),
    changeSamples: [],
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

        const existing = existingByPnk.get(update.pnk);
        const oldLinkType = existing?.emagLinkType ?? null;
        recordTransition(summary.transitions, oldLinkType, update.linkTypeResult.linkType);

        if (
          summary.changeSamples.length < 5
          && oldLinkType !== update.linkTypeResult.linkType
        ) {
          summary.changeSamples.push({
            pnk: update.pnk,
            sku: update.sku ?? existing?.sku ?? existing?.vendorSku ?? null,
            brand: update.brand,
            ownership: update.ownership,
            oldLinkType,
            newLinkType: update.linkTypeResult.linkType,
            reason: update.linkTypeResult.linkTypeReason,
          });
        }

        if (summary.samples.length < 8) summary.samples.push(update.sample);

        if (!dryRun) {
          const result = await prisma.storeProduct.updateMany({
            where: { shopId: targetShopId, pnk: update.pnk, isArchived: false },
            data: update.data,
          });
          summary.updated += result.count;
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

function printDryRunReport(summary: BackfillSummary): void {
  const t = summary.transitions;
  console.log('\n=== EmagLinkType Backfill DRY-RUN 报告 ===');
  console.log(
    `shopId=${summary.shopId} shopName=${summary.shopName} region=${summary.region} ` +
    `scanned=${summary.scanned} errors=${summary.errors.length}`,
  );
  console.log(`SELF_BUILT → RESELL: ${t.selfBuiltToResell}`);
  console.log(`RESELL → OWN_BRAND_RESELL: ${t.resellToOwnBrandResell}`);
  console.log(`→ UNKNOWN（任意旧值）: ${t.toUnknown}`);
  console.log(`任意 linkType 变化总数: ${t.anyChange}`);
  console.log('\n--- 变化抽样（最多 5 条）---');
  console.log(JSON.stringify(summary.changeSamples, null, 2));
}

async function main() {
  if (shopArg && (!Number.isInteger(shopId) || shopId! <= 0)) {
    throw new Error(`shopId 无效：${shopArg}`);
  }
  if (shopId && allEmagShops) {
    throw new Error('不能同时指定 --shopId 与 --allEmagShops=true');
  }
  if (!shopId && !allEmagShops) {
    throw new Error('请指定 --shopId=xxx 或 --allEmagShops=true');
  }

  const shops = shopId
    ? await prisma.shopAuthorization.findMany({
        where: { id: shopId },
        select: { id: true, shopName: true, region: true },
      })
    : await prisma.shopAuthorization.findMany({
        where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
        select: { id: true, shopName: true, region: true },
        orderBy: { id: 'asc' },
      });

  if (shops.length === 0) {
    throw new Error(shopId ? `shopId=${shopId} 不存在` : '无 active eMAG 店铺');
  }

  console.log(
    `[EmagLinkType] mode=${dryRun ? 'DRY_RUN' : 'FIX'} shops=${shops.map((s) => s.id).join(',')}`,
  );

  const allSummaries: BackfillSummary[] = [];
  for (const shop of shops) {
    try {
      const summary = await backfillShop(shop.id, {
        shopName: shop.shopName,
        region: shop.region,
      });
      allSummaries.push(summary);
      console.log(
        `[EmagLinkType] shopId=${summary.shopId} shopName=${summary.shopName} region=${summary.region} ` +
        `scanned=${summary.scanned} updated=${summary.updated} errors=${summary.errors.length}`,
      );
      if (dryRun) {
        printDryRunReport(summary);
      }
      if (summary.errors.length > 0) {
        console.warn('[EmagLinkType] errors:', summary.errors.slice(0, 10).join(' | '));
      }
    } catch (err) {
      console.error(
        `[EmagLinkType] shopId=${shop.id} shopName=${shop.shopName} FAILED:`,
        err instanceof Error ? err.message : err,
      );
      allSummaries.push({
        shopId: shop.id,
        shopName: shop.shopName,
        region: shop.region,
        scanned: 0,
        updated: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        transitions: emptyTransitionStats(),
        changeSamples: [],
        samples: [],
      });
    }
  }

  console.log('\n=== EmagLinkType Backfill 汇总 ===');
  for (const s of allSummaries) {
    const t = s.transitions;
    console.log(
      JSON.stringify({
        shopId: s.shopId,
        shopName: s.shopName,
        region: s.region,
        scanned: s.scanned,
        updated: s.updated,
        selfBuiltToResell: t.selfBuiltToResell,
        resellToOwnBrandResell: t.resellToOwnBrandResell,
        toUnknown: t.toUnknown,
        anyChange: t.anyChange,
        errors: s.errors.length,
      }),
    );
  }

  const shopsWithErrors = allSummaries.filter((s) => s.errors.length > 0);
  if (!dryRun && shopsWithErrors.length > 0) {
    console.warn(
      `[EmagLinkType] 以下店铺存在错误: ${shopsWithErrors.map((s) => s.shopId).join(', ')}`,
    );
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
