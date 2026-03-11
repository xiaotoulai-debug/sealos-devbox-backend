#!/usr/bin/env npx ts-node
/**
 * 平台订单全量同步脚本
 * 用法: npx ts-node scripts/sync-platform-orders.ts
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { syncAllPlatformOrders } from '../src/services/platformOrderSync';

async function main() {
  console.log('\n=== 开始平台订单全量同步 ===\n');
  const results = await syncAllPlatformOrders();
  const total = results.reduce((s, r) => s + r.totalUpserted, 0);
  console.log('\n=== 同步结果 ===');
  results.forEach((r) => console.log(`  shop ${r.shopId}: 拉取 ${r.totalFetched} 条, 入库 ${r.totalUpserted} 条`));
  console.log(`\n合计同步: ${total} 条订单`);

  const { prisma } = await import('../src/lib/prisma');
  const dbCount = await prisma.platformOrder.count();
  console.log(`数据库当前总数: ${dbCount} 条\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
