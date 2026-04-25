/**
 * CLI 直接同步 shopId=5（跨境A店 RO），绕过产品锁
 */
import { prisma } from '../src/lib/prisma';
import { getEmagCredentials } from '../src/services/emagClient';
import { syncStoreProducts } from '../src/services/storeProductSync';

async function main() {
  const SHOP_ID = 5;
  console.log(`[CLI] 直接触发 shopId=${SHOP_ID} 全量产品同步（绕过锁）...`);

  const creds = await getEmagCredentials(SHOP_ID);
  console.log(`[CLI] 凭证获取成功: ${creds.username} @ ${creds.baseUrl}`);

  const result = await syncStoreProducts(creds);
  console.log('[CLI] 同步结果:', JSON.stringify(result, null, 2));

  // 验证 EAN
  const check = await prisma.storeProduct.findMany({
    where: { ean: { contains: '786188704609' } },
    select: { pnk: true, ean: true, shopId: true },
  });
  console.log('\n=== 同步后 EAN 786188704609 验证 ===');
  if (check.length > 0) {
    console.log('✅ 找到记录:', JSON.stringify(check));
  } else {
    console.log('⚠️  仍未找到，该 EAN 可能在 eMAG 侧未归属 shopId=5，或产品已下架');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
