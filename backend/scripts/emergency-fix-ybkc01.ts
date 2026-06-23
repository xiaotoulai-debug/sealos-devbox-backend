import { prisma } from '../src/lib/prisma';

async function main() {
  // ─── 1. 查 YBKC01 所有历史采购单子单的 offerId ───────────────────
  const product = await prisma.product.findFirst({
    where: { sku: 'YBKC01' },
    select: { id: true, externalProductId: true, externalSkuId: true, externalSynced: true },
  });
  if (!product) { console.log('找不到 YBKC01'); return; }

  console.log('当前状态:', product);

  // 查历史所有 PurchaseOrderItem，看哪个 offerId 不一样
  const items = await prisma.purchaseOrderItem.findMany({
    where: { product: { sku: 'YBKC01' } },
    select: { id: true, offerId: true, skuId: true, purchaseOrderId: true },
  });
  console.log('\n历史 PurchaseOrderItem 记录:');
  items.forEach((i) => console.log(`  item#${i.id} po=${i.purchaseOrderId} offerId=${i.offerId} skuId=${i.skuId}`));

  // ─── 2. 直接修复：清空 externalSkuId，重置 externalSynced ─────────
  const fixed = await prisma.product.update({
    where: { id: product.id },
    data: {
      externalSkuId:    null,
      externalSkuIdNum: null,
      externalSynced:   false,
    },
  });
  console.log('\n✅ 修复完成:', {
    externalProductId: fixed.externalProductId,
    externalSkuId:     fixed.externalSkuId,
    externalSynced:    fixed.externalSynced,
  });

  // ─── 3. 同步清理 PurchaseOrderItem 中过期的 skuId ────────────────
  //    如果 item 的 offerId ≠ 当前 externalProductId，其 skuId 也是旧的
  const staleItems = items.filter(
    (i) => i.offerId && i.offerId !== product.externalProductId
  );
  if (staleItems.length > 0) {
    console.log(`\n发现 ${staleItems.length} 条 PO 子单 offerId 与当前不符，清空其 skuId:`);
    for (const item of staleItems) {
      await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: { skuId: null },
      });
      console.log(`  ✅ item#${item.id} skuId 已清空`);
    }
  } else {
    console.log('\nPO 子单 offerId 均一致，无需额外清理。');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
