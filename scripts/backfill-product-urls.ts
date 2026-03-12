/**
 * 补齐 product_url 脚本
 * 用法: npm run backfill:product-urls
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { backfillProductUrls } from '../src/services/storeProductSync';

async function main() {
  const result = await backfillProductUrls();
  const nullCount = await prisma.storeProduct.count({ where: { productUrl: null } });
  const total = await prisma.storeProduct.count();
  console.log('');
  console.log('[backfill-product-urls] 完成');
  console.log(`  已补齐: ${result.updated}`);
  console.log(`  product_url 为 null 剩余: ${nullCount}/${total}`);
  console.log(`  product_url 已填充: ${total - nullCount}/${total}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
