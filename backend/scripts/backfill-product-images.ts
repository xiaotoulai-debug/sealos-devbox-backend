/**
 * 平台产品图片补货脚本
 *
 * 遍历 main_image 为空或占位图的产品，从 eMAG API 重新获取并更新：
 * 1. product_offer/read: main_url、images 数组、description HTML
 * 2. documentation/find_by_eans: EAN 文档 product_image
 *
 * 过滤: 跳过 logo、emag-placeholder、temporary-images、.svg
 * 输出: SKU: D9MSJJ3BM -> Image: https://...jpg
 *
 * 用法: npx tsx scripts/backfill-product-images.ts
 */

import 'dotenv/config';
import { backfillProductImages } from '../src/services/storeProductSync';

async function main() {
  console.log('[backfill-product-images] 开始批量补齐 main_image...\n');
  const result = await backfillProductImages();
  console.log('\n[backfill-product-images] 完成');
  console.log(`  已更新: ${result.updated}/${result.total}`);
  if (result.errors.length > 0) {
    console.log(`  错误: ${result.errors.join('; ')}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
