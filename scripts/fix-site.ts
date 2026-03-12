#!/usr/bin/env npx tsx
/**
 * 硬核修复：将 eMAG 店铺空 region 更新为 RO
 *
 * 执行：cd backend && npx tsx scripts/fix-site.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  硬核修复：shop_authorizations.region 空值 → RO');
  console.log('═══════════════════════════════════════════════════════════\n');

  const result = await prisma.shopAuthorization.updateMany({
    where: {
      platform: { equals: 'emag', mode: 'insensitive' },
      region: null,
    },
    data: { region: 'RO' },
  });

  console.log(`✓ 已更新 ${result.count} 条记录\n`);

  // 验证
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' } },
    select: { id: true, shopName: true, platform: true, region: true },
  });
  console.log('当前 eMAG 店铺:');
  shops.forEach((s) => console.log(`  id=${s.id}  ${s.shopName}  region=${s.region ?? 'NULL'}`));
  console.log('\n═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
