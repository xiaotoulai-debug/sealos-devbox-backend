import { prisma } from '../src/lib/prisma';
import {
  createInventorySnapshotsForAllShops,
  createInventorySnapshotsForShop,
  type InventorySnapshotSummary,
} from '../src/services/storeProductInventorySnapshot';

const shouldFix = process.argv.includes('--fix');
const shopArg = process.argv.find((arg) => arg.startsWith('--shopId='));
const dateArg = process.argv.find((arg) => arg.startsWith('--date='));
const shopId = shopArg ? Number(shopArg.split('=')[1]) : undefined;
const snapshotDate = dateArg ? new Date(`${dateArg.split('=')[1]}T00:00:00.000Z`) : undefined;

function printSummary(summary: InventorySnapshotSummary) {
  console.log(
    `[InventorySnapshot] shopId=${summary.shopId} date=${summary.snapshotDate} ` +
    `mode=${summary.dryRun ? 'DRY_RUN' : 'FIX'} scanned=${summary.scanned} planned=${summary.planned} ` +
    `create=${summary.created} update=${summary.updated}`,
  );
  if (summary.samples.length > 0) {
    console.log('[InventorySnapshot] samples:', summary.samples.map((s) =>
      `#${s.storeProductId}/${s.sku ?? 'no-sku'} stock=${s.platformStock} transit=${s.inTransitStock} sales30=${s.sales30} comp=${s.comprehensiveSales} existed=${s.existed}`,
    ).join(' | '));
  }
}

async function main() {
  const dryRun = !shouldFix;
  if (shopArg && (!Number.isInteger(shopId) || shopId! <= 0)) {
    throw new Error(`shopId 无效：${shopArg}`);
  }
  if (dateArg && Number.isNaN(snapshotDate?.getTime())) {
    throw new Error(`date 无效：${dateArg}，格式应为 YYYY-MM-DD`);
  }

  console.log(
    `[InventorySnapshot] mode=${dryRun ? 'DRY_RUN' : 'FIX'}` +
    `${shopId ? ` shopId=${shopId}` : ' all shops'}` +
    `${dateArg ? ` date=${dateArg.split('=')[1]}` : ''}`,
  );

  if (shopId) {
    const summary = await createInventorySnapshotsForShop(shopId, { dryRun, snapshotDate });
    printSummary(summary);
    return;
  }

  const summaries = await createInventorySnapshotsForAllShops({ dryRun, snapshotDate });
  for (const summary of summaries) {
    printSummary(summary);
  }
  console.log(
    `[InventorySnapshot] total shops=${summaries.length} scanned=${summaries.reduce((s, x) => s + x.scanned, 0)} ` +
    `planned=${summaries.reduce((s, x) => s + x.planned, 0)} create=${summaries.reduce((s, x) => s + x.created, 0)} update=${summaries.reduce((s, x) => s + x.updated, 0)}`,
  );
}

main()
  .catch((err) => {
    console.error('[InventorySnapshot] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
