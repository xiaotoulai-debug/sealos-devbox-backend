#!/usr/bin/env npx ts-node
/**
 * 店铺产品同步脚本 — 直接调用同步逻辑并打印到终端
 * 用法: npx ts-node scripts/sync-store-products.ts [shopId]
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { getEmagCredentials } from '../src/services/emagClient';
import { syncStoreProducts } from '../src/services/storeProductSync';

async function main() {
  const shopId = parseInt(process.argv[2] || '1', 10);
  console.log(`\n=== 开始同步店铺 ${shopId} 的产品 ===\n`);
  const creds = await getEmagCredentials(shopId);
  const result = await syncStoreProducts(creds);
  console.log(`\n=== 同步完成 ===`);
  console.log(`总拉取: ${result.totalFetched}, 已写入: ${result.upserted}`);
  console.log(`已驳回数量: ${result.rejectedCount}`);
  if (result.eanImagesRecovered !== undefined) {
    console.log(`EAN 补全找回图片: ${result.eanImagesRecovered} 张`);
  }
  if (result.rejectedReasons.length > 0) {
    console.log(`\n抓到的驳回原因:`);
    result.rejectedReasons.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  }
  if (result.rejectedSample) {
    console.log(`\n驳回产品示例: PNK=${result.rejectedSample.pnk}`);
    console.log(`  docErrors: ${result.rejectedSample.docErrors}`);
  }
  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
