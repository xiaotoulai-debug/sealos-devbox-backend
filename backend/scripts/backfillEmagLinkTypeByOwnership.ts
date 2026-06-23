import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import {
  buildLinkTypeUpdateFromOwnership,
  type OfferCompetitionType,
} from '../src/services/emagLinkType';

const shopArg = process.argv.find((arg) => arg.startsWith('--shopId='));
const dryRunArg = process.argv.find((arg) => arg.startsWith('--dryRun='));
const shopId = shopArg ? Number(shopArg.split('=')[1]) : undefined;
const dryRun = dryRunArg ? dryRunArg.split('=')[1] !== 'false' : true;

type ShopStats = {
  scanned: number;
  toSelfBuilt: number;
  toResell: number;
  toUnknown: number;
  unchanged: number;
  updated: number;
  errors: number;
};

function normalizeCompetitionType(value: string | null | undefined): OfferCompetitionType {
  return value === 'NO_ACTIVE_COMPETITION' || value === 'EXCLUSIVE' || value === 'COMPETITIVE' || value === 'UNKNOWN'
    ? value
    : 'UNKNOWN';
}

async function main() {
  if (shopArg && (!Number.isInteger(shopId) || shopId! <= 0)) {
    throw new Error(`shopId 无效：${shopArg}`);
  }

  const rows = await prisma.storeProduct.findMany({
    where: {
      isArchived: false,
      ...(shopId ? { shopId } : {}),
    },
    select: {
      id: true,
      shopId: true,
      pnk: true,
      sku: true,
      vendorSku: true,
      ean: true,
      emagLinkType: true,
      emagLinkTypeSource: true,
      emagLinkTypeConfidence: true,
      contentPermission: true,
      emagOwnership: true,
      offerCompetitionType: true,
    },
    orderBy: [{ shopId: 'asc' }, { pnk: 'asc' }, { id: 'asc' }],
  });

  const shopStats = new Map<number, ShopStats>();
  const samples: Array<Record<string, unknown>> = [];

  const ensureStats = (targetShopId: number): ShopStats => {
    const existing = shopStats.get(targetShopId);
    if (existing) return existing;
    const created: ShopStats = {
      scanned: 0,
      toSelfBuilt: 0,
      toResell: 0,
      toUnknown: 0,
      unchanged: 0,
      updated: 0,
      errors: 0,
    };
    shopStats.set(targetShopId, created);
    return created;
  };

  let errors = 0;

  for (const row of rows) {
    const stats = ensureStats(row.shopId);
    stats.scanned++;

    const next = buildLinkTypeUpdateFromOwnership(
      row.shopId,
      row.pnk,
      row.emagOwnership,
      normalizeCompetitionType(row.offerCompetitionType),
    );

    const unchanged =
      next.emagLinkType === row.emagLinkType &&
      next.emagLinkTypeSource === row.emagLinkTypeSource &&
      next.emagLinkTypeConfidence === row.emagLinkTypeConfidence &&
      next.contentPermission === row.contentPermission;
    if (unchanged) {
      stats.unchanged++;
      continue;
    }

    if (next.emagLinkType === 'SELF_BUILT') stats.toSelfBuilt++;
    else if (next.emagLinkType === 'RESELL') stats.toResell++;
    else stats.toUnknown++;

    if (samples.length < 20 && next.emagLinkType !== row.emagLinkType) {
      samples.push({
        shopId: row.shopId,
        pnk: row.pnk,
        sku: row.sku,
        vendorSku: row.vendorSku,
        ean: row.ean,
        ownership: row.emagOwnership,
        from: row.emagLinkType,
        to: next.emagLinkType,
        fromSource: row.emagLinkTypeSource,
        toSource: next.emagLinkTypeSource,
      });
    }

    if (dryRun) continue;

    try {
      await prisma.storeProduct.update({
        where: { id: row.id },
        data: {
          emagLinkType: next.emagLinkType,
          emagLinkTypeSource: next.emagLinkTypeSource,
          emagLinkTypeConfidence: next.emagLinkTypeConfidence,
          contentPermission: next.contentPermission,
          linkActionTips: next.linkActionTips as Prisma.InputJsonValue,
        },
      });
      stats.updated++;
    } catch (err) {
      stats.errors++;
      errors++;
      console.error(
        `[BackfillOwnership] shopId=${row.shopId} pnk=${row.pnk} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const totals = [...shopStats.values()].reduce(
    (acc, item) => ({
      scanned: acc.scanned + item.scanned,
      toSelfBuilt: acc.toSelfBuilt + item.toSelfBuilt,
      toResell: acc.toResell + item.toResell,
      toUnknown: acc.toUnknown + item.toUnknown,
      unchanged: acc.unchanged + item.unchanged,
      updated: acc.updated + item.updated,
      errors: acc.errors + item.errors,
    }),
    { scanned: 0, toSelfBuilt: 0, toResell: 0, toUnknown: 0, unchanged: 0, updated: 0, errors: 0 },
  );

  console.log(`[BackfillOwnership] mode=${dryRun ? 'DRY_RUN' : 'FIX'} shopId=${shopId ?? 'ALL'}`);
  console.log('[BackfillOwnership] totals:', JSON.stringify(totals, null, 2));
  console.log('[BackfillOwnership] byShop:', JSON.stringify(Object.fromEntries(shopStats), null, 2));
  console.log('[BackfillOwnership] samples:', JSON.stringify(samples, null, 2));
  if (errors > 0) console.warn(`[BackfillOwnership] errors=${errors}`);
}

main()
  .catch((err) => {
    console.error('[BackfillOwnership] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
