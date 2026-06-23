#!/usr/bin/env npx ts-node
/**
 * 一次性修复：将 status=4 且 statusText='已取消' 的订单更正为 statusText='已完成'
 * [cite: 1343, 1347] 4=已完成(Finalized) 0=已取消
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { prisma } from '../src/lib/prisma';
import { getFirstEmagShopId } from '../src/services/emagClient';
import { syncPlatformOrderById } from '../src/services/platformOrderSync';

async function main() {
  console.log('\n=== 修复状态映射错误（status=4 应为已完成）===\n');

  const toFix = await prisma.platformOrder.findMany({
    where: { status: 4, statusText: '已取消' },
    select: { id: true, emagOrderId: true, shopId: true },
  });

  console.log(`找到 ${toFix.length} 条需修复的订单（status=4 但 statusText=已取消）`);

  if (toFix.length > 0) {
    const result = await prisma.platformOrder.updateMany({
      where: { status: 4, statusText: '已取消' },
      data: { statusText: '已完成' },
    });
    console.log(`已修复 ${result.count} 条\n`);
  } else {
    console.log('无需修复\n');
  }

  console.log('=== 验证订单 480702441 ===');
  let shopId = 1;
  try {
    const first = await getFirstEmagShopId();
    shopId = first ?? 1;
  } catch {}
  const syncResult = await syncPlatformOrderById(shopId, 480702441);
  if (syncResult.ok) {
    console.log(`订单 480702441 状态文本: ${syncResult.status_text}`);
    if (syncResult.status_text !== '已完成') {
      console.error('错误: 期望「已完成」，实际:', syncResult.status_text);
      process.exit(1);
    }
  } else {
    const row = await prisma.platformOrder.findFirst({
      where: { emagOrderId: 480702441 },
    });
    if (row) {
      console.log(`订单 480702441 状态文本: ${row.statusText}`);
      if (row.statusText !== '已完成') {
        console.error('错误: 期望「已完成」，实际:', row.statusText);
        process.exit(1);
      }
    } else {
      console.error('订单 480702441 不存在，同步失败:', syncResult.error);
      process.exit(1);
    }
  }

  console.log('\n修复完成，数据库旧数据已更正。\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
