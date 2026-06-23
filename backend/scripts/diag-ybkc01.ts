import { prisma } from '../src/lib/prisma';

async function main() {
  const p = await prisma.product.findFirst({
    where: { sku: 'YBKC01' },
    select: {
      id: true, sku: true,
      purchaseUrl: true,
      externalProductId: true,
      externalSkuId: true,
      externalSkuIdNum: true,
      externalSynced: true,
      status: true,
      purchaseOrderId: true,
    },
  });
  if (!p) { console.log('❌ 找不到 YBKC01'); return; }
  console.log('=== YBKC01 当前 DB 状态 ===');
  console.log(JSON.stringify(p, null, 2));

  const purchaseUrl = p.purchaseUrl ?? '';
  const urlOfferMatch = purchaseUrl.match(/\/offer\/(\d{10,})/i) ||
                        purchaseUrl.match(/[?&]id=(\d{10,})/i)   ||
                        purchaseUrl.match(/(\d{10,})/);
  const urlOfferId = urlOfferMatch ? urlOfferMatch[1] : null;

  console.log('\n=== 诊断结论 ===');
  console.log(`purchaseUrl 中的 offerId: ${urlOfferId ?? '无法解析'}`);
  console.log(`DB externalProductId:     ${p.externalProductId ?? 'null'}`);
  console.log(`externalSkuId:            ${p.externalSkuId ?? 'null (已清空)'}`);
  console.log(`externalSynced:           ${p.externalSynced}`);

  if (p.externalSkuId) {
    console.log('\n❌ externalSkuId 仍有值！下单会用旧规格，需继续清空。');
  } else if (urlOfferId !== p.externalProductId) {
    console.log('\n❌ URL offerId 与 DB externalProductId 不一致（URL 换链未同步）！');
  } else if (!p.externalSynced) {
    console.log('\n⚠️  externalSkuId 已清空，externalSynced=false。');
    console.log('   业务员需在前端重新选规格，然后才能下单。');
  } else {
    console.log('\n✅ 数据正常，可以下单。');
  }

  // 看最新 PO 状态
  if (p.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: p.purchaseOrderId },
      select: { id: true, orderNo: true, status: true },
    });
    console.log('\n=== 当前关联采购单 ===');
    console.log(JSON.stringify(po, null, 2));
  } else {
    console.log('\n采购单 ID: null（产品当前未绑定采购单，需重新建单）');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
