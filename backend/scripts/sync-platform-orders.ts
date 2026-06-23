#!/usr/bin/env npx ts-node
/**
 * 平台订单全量同步脚本
 * 全状态(1,2,3,4,5)、31天分批、强制以 eMAG 为准覆盖
 * 用法: npx tsx scripts/sync-platform-orders.ts [--incremental]
 *   --incremental  仅拉取过去 24 小时（增量）
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { syncAllPlatformOrders } from '../src/services/platformOrderSync';
import { prisma } from '../src/lib/prisma';

async function main() {
  const incremental = process.argv.includes('--incremental');
  const mode = incremental ? '增量(24h)' : '全量(365天)';
  console.log(`\n=== 开始平台订单同步 [${mode}] ===\n`);

  const results = await syncAllPlatformOrders(incremental);

  console.log('\n=== 同步结果 ===');
  const allOrderIds: number[] = [];
  results.forEach((r) => {
    console.log(`  shop ${r.shopId}: 拉取 ${r.totalFetched} 条, 入库 ${r.totalUpserted} 条`);
    console.log(`    订单ID: [${r.orderIds.join(', ')}]`);
    allOrderIds.push(...r.orderIds);
  });
  const total = results.reduce((s, r) => s + r.totalUpserted, 0);
  console.log(`\n合计同步: ${total} 条订单`);
  console.log(`\n最近一次同步抓到的订单 ID 列表: [${allOrderIds.join(', ')}]`);

  const dbCount = await prisma.platformOrder.count();
  console.log(`\n数据库当前总数: ${dbCount} 条\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
