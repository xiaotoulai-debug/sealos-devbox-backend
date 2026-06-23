/**
 * 手动触发 shopId=5（跨境A店 RO）全量产品同步
 * 执行后将写入最新产品数据（含新格式 EAN 归一化）
 */
import { prisma } from '../src/lib/prisma';
import { syncStoreProducts } from '../src/services/storeProductSync';
import { getEmagCredentials } from '../src/services/emagClient';

const SHOP_ID = 5;

async function main() {
  console.log(`\n[手动同步] 开始对 shopId=${SHOP_ID}（跨境A店 RO）执行全量产品同步...`);
  console.log('[手动同步] 不传 modifiedAfter，强制全量拉取所有产品\n');

  const creds = await getEmagCredentials(SHOP_ID);
  console.log(`[手动同步] 获取到凭证: region=${creds.region} username=${creds.username.replace(/(.{3}).*(@.*)/, '$1***$2')}`);

  const result = await syncStoreProducts(creds); // 不传 modifiedAfter → 全量同步
  console.log('\n[手动同步] 完成！');
  console.log(`  upserted: ${result.upserted}`);
  console.log(`  skipped:  ${result.skipped ?? 'N/A'}`);
  console.log(`  errors:   ${result.errors ?? 0}`);

  // 验证目标 EAN 是否已入库或更新
  const ean = '0786188447478';
  const eanShort = ean.replace(/^0+/, '');
  const found = await prisma.storeProduct.findMany({
    where: { OR: [{ ean }, { ean: eanShort }] },
    select: { id: true, pnk: true, ean: true, name: true, shopId: true, syncedAt: true },
  });
  console.log(`\n[EAN 验证] 搜索 ${ean} (含短格式):`, found.length > 0 ? `✅ 找到 ${found.length} 条` : '❌ 仍未找到（可能该产品已下架）');
  found.forEach(r => {
    console.log(`  pnk=${r.pnk} ean="${r.ean}" shopId=${r.shopId} syncedAt=${r.syncedAt}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
