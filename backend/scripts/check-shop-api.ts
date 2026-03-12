#!/usr/bin/env npx tsx
/**
 * 模拟 GET /api/shops 返回结构，验证 region 是否在数据中
 * 执行：cd backend && npx tsx scripts/check-shop-api.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';

async function main() {
  const shops = await prisma.shopAuthorization.findMany({ orderBy: { createdAt: 'desc' } });
  const safe = shops.map((s) => {
    const region = s.platform.toLowerCase() === 'emag' && s.region == null ? 'RO' : s.region;
    return {
      id: s.id,
      platform: s.platform,
      shopName: s.shopName,
      region,
      status: s.status,
      isSandbox: s.isSandbox,
    };
  });
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GET /api/shops 返回数据样例（含 region）');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(JSON.stringify(safe, null, 2));
  console.log('\n═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
