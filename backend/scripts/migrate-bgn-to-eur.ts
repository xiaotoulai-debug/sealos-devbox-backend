#!/usr/bin/env npx tsx
/**
 * 历史数据迁移：将 BGN 货币更新为 EUR（保加利亚 2026 年加入欧元区）
 *
 * 执行：cd backend && npx tsx scripts/migrate-bgn-to-eur.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BGN → EUR 货币迁移（保加利亚 2026 年加入欧元区）');
  console.log('═══════════════════════════════════════════════════════════\n');

  const [storeProducts, platformOrders] = await Promise.all([
    prisma.storeProduct.updateMany({ where: { currency: 'BGN' }, data: { currency: 'EUR' } }),
    prisma.platformOrder.updateMany({ where: { currency: 'BGN' }, data: { currency: 'EUR' } }),
  ]);

  console.log(`✓ StoreProduct: 已更新 ${storeProducts.count} 条 (BGN → EUR)`);
  console.log(`✓ PlatformOrder: 已更新 ${platformOrders.count} 条 (BGN → EUR)`);
  console.log('\n═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('迁移失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
