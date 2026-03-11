#!/usr/bin/env npx ts-node
/**
 * 数据库状态文本洗牌：按 status 码强制修正 status_text
 * [cite: 1342-1348] 4=已完成 0=已取消
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('\n=== 数据库状态文本洗牌 ===\n');

  const r4 = await prisma.platformOrder.updateMany({
    where: { status: 4 },
    data: { statusText: '已完成' },
  });
  console.log(`status=4 → 已完成: 更新 ${r4.count} 条`);

  const r0 = await prisma.platformOrder.updateMany({
    where: { status: 0 },
    data: { statusText: '已取消' },
  });
  console.log(`status=0 → 已取消: 更新 ${r0.count} 条`);

  const r1 = await prisma.platformOrder.updateMany({
    where: { status: 1 },
    data: { statusText: '新订单' },
  });
  console.log(`status=1 → 新订单: 更新 ${r1.count} 条`);

  const r2 = await prisma.platformOrder.updateMany({
    where: { status: 2 },
    data: { statusText: '处理中' },
  });
  console.log(`status=2 → 处理中: 更新 ${r2.count} 条`);

  const r3 = await prisma.platformOrder.updateMany({
    where: { status: 3 },
    data: { statusText: '已准备' },
  });
  console.log(`status=3 → 已准备: 更新 ${r3.count} 条`);

  const r5 = await prisma.platformOrder.updateMany({
    where: { status: 5 },
    data: { statusText: '已退货' },
  });
  console.log(`status=5 → 已退货: 更新 ${r5.count} 条`);

  console.log('\n洗牌完成。\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
