/**
 * 脏数据清洗脚本：重置 vendor_sku 映射错误的 StoreProduct 记录
 *
 * 背景：
 *   emagProductNormalizer.ts 历史 Bug：将 raw.part_number（eMAG 平台编码）误用为
 *   vendorSku（卖家自有 SKU）。正确来源应为 raw.ext_part_number。
 *   受影响的记录表现为 vendor_sku 具有 eMAG PNK 格式（D 开头 + BM 结尾）。
 *
 * 执行条件：
 *   1. 必须在 emagProductNormalizer.ts 的 Bug 已修复（vendorSku 改为读 ext_part_number）之后运行
 *   2. ECS 代理可用（脚本将触发产品全量重同步）
 *
 * 执行方式：npx tsx scripts/clean-dirty-vendor-sku.ts
 *
 * 安全机制：
 *   - DRY_RUN=true 时只报告，不修改任何数据（默认开启）
 *   - 设置环境变量 DRY_RUN=false 后才实际执行清洗
 */

import { prisma } from '../src/lib/prisma';
import { syncStoreProducts } from '../src/services/storeProductSync';
import { getEmagCredentials } from '../src/services/emagClient';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const SHOP_ID = 5;

async function main() {
  console.log(`=== vendor_sku 脏数据清洗脚本 (DRY_RUN=${DRY_RUN}) ===\n`);

  // ── Step 1：扫描当前脏数据清单 ───────────────────────────────────────────────
  console.log('► 步骤1：扫描 vendor_sku 为 PNK 格式的疑似脏数据...');
  const dirtyRecords = await prisma.$queryRaw<Array<{
    id: number; pnk: string; vendor_sku: string; sku: string; ean: string | null; name: string;
  }>>`
    SELECT id, pnk, vendor_sku, sku, ean, name
    FROM store_products
    WHERE shop_id = ${SHOP_ID}
      AND vendor_sku ~ '^D[A-Z0-9]{6,8}BM$'
      AND vendor_sku != pnk
    ORDER BY id
  `;

  if (dirtyRecords.length === 0) {
    console.log('✅ 未发现脏数据，数据库状态良好！');
    return;
  }

  console.log(`发现 ${dirtyRecords.length} 条脏数据：`);
  dirtyRecords.forEach((r) => {
    console.log(`  [${r.id}] PNK=${r.pnk}  vendor_sku=${r.vendor_sku}（应改为正确的卖家 SKU）  名称: ${r.name.slice(0, 40)}`);
  });

  if (DRY_RUN) {
    console.log(`\n⚠️  DRY_RUN 模式：以上 ${dirtyRecords.length} 条记录未被修改。`);
    console.log('   执行实际清洗请运行：DRY_RUN=false npx tsx scripts/clean-dirty-vendor-sku.ts');
    return;
  }

  // ── Step 2（仅 DRY_RUN=false 时执行）：触发全量重同步，由修复后的 normalizer 自动覆盖 ──
  console.log('\n► 步骤2：触发 shopId=5 全量重同步（使用修复后的 normalizer）...');
  console.log('   同步将通过 storeProductSync.ts 逐页拉取并 upsert，自动覆盖错误 vendor_sku。\n');

  const creds = await getEmagCredentials(SHOP_ID);
  const result = await syncStoreProducts(creds);

  console.log('\n=== 清洗同步完成 ===');
  console.log(`  拉取: ${result.totalFetched} 条`);
  console.log(`  入库: ${result.upserted} 条`);
  console.log(`  错误: ${result.errors.length} 条`);

  // ── Step 3：验证脏数据是否已清除 ─────────────────────────────────────────────
  console.log('\n► 步骤3：验证脏数据残留...');
  const remaining = await prisma.$queryRaw<Array<{ pnk: string; vendor_sku: string }>>`
    SELECT pnk, vendor_sku
    FROM store_products
    WHERE shop_id = ${SHOP_ID}
      AND vendor_sku ~ '^D[A-Z0-9]{6,8}BM$'
      AND vendor_sku != pnk
  `;

  if (remaining.length === 0) {
    console.log('✅ 脏数据已全部清除！');
  } else {
    console.log(`⚠️  仍有 ${remaining.length} 条未清除（可能因代理抖动未同步到对应页）：`);
    remaining.forEach((r) => console.log(`  PNK=${r.pnk}  vendor_sku=${r.vendor_sku}`));
    console.log('   建议代理稳定后再次运行本脚本。');
  }

  // ── Step 4：验证 DKWY832BM 是否已修正 ────────────────────────────────────────
  const check = await prisma.storeProduct.findFirst({
    where: { shopId: SHOP_ID, pnk: 'DKWY832BM' },
    select: { pnk: true, sku: true, vendorSku: true },
  });
  console.log('\n► DKWY832BM 最终状态：', JSON.stringify(check));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
