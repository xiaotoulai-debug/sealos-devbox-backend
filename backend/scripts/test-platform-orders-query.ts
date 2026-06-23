#!/usr/bin/env npx tsx
/**
 * 测试多店聚合查询返回格式
 * 执行：cd backend && npx tsx scripts/test-platform-orders-query.ts
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { prisma } from '../src/lib/prisma';

async function main() {
  const shopIds = [1];
  const [total, rows] = await Promise.all([
    prisma.platformOrder.count({ where: { shopId: { in: shopIds } } }),
    prisma.platformOrder.findMany({
      where: { shopId: { in: shopIds } },
      orderBy: { orderTime: 'desc' },
      take: 2,
      include: { shop: { select: { region: true } } },
    }),
  ]);

  const list = rows.map((r) => {
    const statusNum = r.status != null ? Number(r.status) : 0;
    const region = (r.shop?.region ?? 'RO') as string;
    const totalPrice = Number(r.total) ?? 0;
    const currency = r.currency ?? 'RON';
    return {
      emag_order_id: r.emagOrderId,
      id: r.emagOrderId,
      shop_id: r.shopId,
      region,
      status: statusNum,
      status_text: statusNum === 4 ? '已完成' : statusNum === 1 ? '新订单' : `状态${statusNum}`,
      total: totalPrice,
      total_price: totalPrice,
      currency,
      orderTime: r.orderTime.toISOString().slice(0, 19).replace('T', ' '),
    };
  });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  平台订单多店聚合查询 — 返回样本');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('total:', total);
  console.log('样本对象:');
  console.log(JSON.stringify(list[0] ?? {}, null, 2));
  console.log('\n═══════════════════════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
