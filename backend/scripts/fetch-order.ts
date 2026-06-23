#!/usr/bin/env npx ts-node
/**
 * 拉取平台订单详情并打印解析后的 JSON
 * 用法: npx ts-node scripts/fetch-order.ts [orderId] [shopId]
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { getEmagCredentials, getFirstEmagShopId } from '../src/services/emagClient';
import { readOrders, mapOrderForDisplay } from '../src/services/emagOrder';

async function main() {
  const orderId = parseInt(process.argv[2] || '475766038', 10);
  let shopId = parseInt(process.argv[3] || '0', 10);
  if (!shopId || isNaN(shopId)) {
    const first = await getFirstEmagShopId();
    shopId = first ?? 1;
    console.log(`未指定 shopId，使用首个 eMAG 店铺: ${shopId}`);
  }
  console.log(`\n=== 拉取订单 ${orderId} (shopId=${shopId}) ===\n`);

  const creds = await getEmagCredentials(shopId);
  const readResult = await readOrders(creds, { id: orderId });

  if (readResult.isError) {
    console.error('eMAG API 错误:', readResult.messages);
    process.exit(1);
  }

  const raw = readResult.results;
  const orders = Array.isArray(raw) ? raw : [];
  const order = orders[0];
  if (!order) {
    console.error('订单不存在或未返回');
    process.exit(1);
  }

  const mapped = mapOrderForDisplay(order);
  console.log('--- 解析后的 JSON ---');
  console.log(JSON.stringify(mapped, null, 2));
  console.log('\n--- 校验 ---');
  const nameOk = mapped.customer?.name != null && mapped.customer.name !== '';
  const productNameOk = mapped.products?.some((p) => p.product_name != null && p.product_name !== '');
  console.log(`customer.name 非空: ${nameOk} (${mapped.customer?.name ?? 'null'})`);
  console.log(`至少一个 product_name 非空: ${productNameOk}`);
  if (mapped.products?.length) {
    mapped.products.forEach((p, i) => {
      console.log(`  [${i}] product_name=${p.product_name ?? 'null'}, pnk=${p.pnk ?? 'null'}, sku=${p.sku ?? 'null'}`);
    });
  }
  process.exit(nameOk && productNameOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
