import { prisma } from '../src/lib/prisma';
import {
  PRODUCT_CLASSES,
  recalcProductClassForAllShops,
  recalcProductClassForShop,
  type ProductClassRecalcSummary,
} from '../src/services/productClassification';

const shouldFix = process.argv.includes('--fix');
const shopArg = process.argv.find((arg) => arg.startsWith('--shopId='));
const shopId = shopArg ? Number(shopArg.split('=')[1]) : undefined;

function printSummary(summary: ProductClassRecalcSummary) {
  console.log(`[ProductClass] shopId=${summary.shopId ?? 'ALL'} mode=${summary.dryRun ? 'DRY_RUN' : 'FIX'} scanned=${summary.scanned} pendingOrUpdated=${summary.updated}`);
  console.log('[ProductClass] counts:', JSON.stringify(summary.counts));
  for (const cls of PRODUCT_CLASSES) {
    const samples = summary.samples[cls];
    if (samples.length === 0) continue;
    console.log(
      `[ProductClass] sample ${cls}: ` +
      samples.map((s) => `#${s.id}/${s.sku ?? s.pnk} ${s.before ?? 'null'}->${s.after}`).join(', '),
    );
  }
}

async function main() {
  const dryRun = !shouldFix;
  console.log(`[ProductClass] mode=${dryRun ? 'DRY_RUN' : 'FIX'}${shopId ? ` shopId=${shopId}` : ' all shops'}`);
  if (shopArg && (!Number.isInteger(shopId) || shopId! <= 0)) {
    throw new Error(`shopId 无效：${shopArg}`);
  }

  if (shopId) {
    const summary = await recalcProductClassForShop(shopId, { dryRun });
    printSummary(summary);
    return;
  }

  const summaries = await recalcProductClassForAllShops({ dryRun });
  for (const summary of summaries) {
    printSummary(summary);
  }
  const totalScanned = summaries.reduce((sum, s) => sum + s.scanned, 0);
  const totalUpdated = summaries.reduce((sum, s) => sum + s.updated, 0);
  console.log(`[ProductClass] total shops=${summaries.length} scanned=${totalScanned} pendingOrUpdated=${totalUpdated}`);
}

main()
  .catch((err) => {
    console.error('[ProductClass] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
