#!/usr/bin/env npx ts-node
/**
 * 强制同步单笔平台订单
 * 用法: npx ts-node scripts/sync-order-by-id.ts [orderId] [shopId]
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import { getFirstEmagShopId } from '../src/services/emagClient';
import { syncPlatformOrderById } from '../src/services/platformOrderSync';

async function main() {
  const orderId = parseInt(process.argv[2] || '479375012', 10);
  let shopId = parseInt(process.argv[3] || '0', 10);
  if (!shopId || isNaN(shopId)) {
    const first = await getFirstEmagShopId();
    shopId = first ?? 1;
    console.log(`未指定 shopId，使用: ${shopId}`);
  }
  console.log(`\n=== 强制同步订单 ${orderId} ===\n`);

  const result = await syncPlatformOrderById(shopId, orderId);

  if (!result.ok) {
    console.error('同步失败:', result.error);
    process.exit(1);
  }

  console.log('同步成功');
  console.log('  订单总额(含税):', result.total);
  console.log('  状态:', result.status_text);
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
