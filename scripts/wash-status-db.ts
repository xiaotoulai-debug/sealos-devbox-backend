#!/usr/bin/env npx ts-node
/**
 * 数据库大清洗：强制修正 statusText
 * status=4 → 已完成, status=0 → 已取消
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { prisma } from '../src/lib/prisma';

async function main() {
  console.log('\n=== 数据库大清洗 ===\n');

  const r4 = await prisma.platformOrder.updateMany({
    where: { status: 4 },
    data: { statusText: '已完成' },
  });
  console.log(`Updated finalized orders count: ${r4.count}`);

  const r0 = await prisma.platformOrder.updateMany({
    where: { status: 0 },
    data: { statusText: '已取消' },
  });
  console.log(`Updated cancelled orders count: ${r0.count}`);

  console.log('\n洗牌完成。\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
