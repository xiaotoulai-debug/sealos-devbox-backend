#!/usr/bin/env npx tsx
/**
 * 历史数据迁移：将 eMAG 店铺空 region 更新为 RO
 *
 * 执行：cd backend && npx tsx scripts/migrate-emag-region.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  eMAG 多站点历史数据迁移：region 空值 → RO');
  console.log('═══════════════════════════════════════════════════════════\n');

  // 1. 查询需要更新的记录
  const toUpdate = await prisma.shopAuthorization.findMany({
    where: {
      platform: { equals: 'emag', mode: 'insensitive' },
      region: null,
    },
    select: { id: true, shopName: true, platform: true },
  });

  if (toUpdate.length === 0) {
    console.log('✓ 无需更新：所有 eMAG 店铺均已设置 region\n');
  } else {
    const result = await prisma.shopAuthorization.updateMany({
      where: {
        platform: { equals: 'emag', mode: 'insensitive' },
        region: null,
      },
      data: { region: 'RO' },
    });
    console.log(`✓ 已更新 ${result.count} 条记录：region = 'RO'`);
    toUpdate.forEach((s) => console.log(`  - id=${s.id}  ${s.shopName}`));
    console.log('');
  }

  // 2. 验证：打印所有已授权店铺及站点
  const all = await prisma.shopAuthorization.findMany({
    where: { status: 'active' },
    select: { id: true, platform: true, shopName: true, region: true, isSandbox: true },
    orderBy: { id: 'asc' },
  });

  console.log('───────────────────────────────────────────────────────────');
  console.log('  已授权店铺列表（含站点标识）');
  console.log('───────────────────────────────────────────────────────────');
  const emagShops = all.filter((s) => s.platform.toLowerCase() === 'emag');
  if (emagShops.length === 0) {
    console.log('  （无 eMAG 店铺）');
  } else {
    emagShops.forEach((s) => {
      const region = s.region ?? 'RO（默认）';
      const sandbox = s.isSandbox ? ' [沙箱]' : '';
      console.log(`  id=${s.id}  ${s.shopName.padEnd(20)}  region=${region}${sandbox}`);
    });
  }
  console.log('───────────────────────────────────────────────────────────\n');

  const has跨境B店 = emagShops.some((s) => s.shopName.includes('跨境B店'));
  if (has跨境B店) {
    const b = emagShops.find((s) => s.shopName.includes('跨境B店'));
    console.log(`✓ 跨境B店 已关联到 region=${b?.region ?? 'RO'}\n`);
  } else {
    console.log('  （当前无名为「跨境B店」的店铺）\n');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  迁移完成');
  console.log('═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('迁移失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
