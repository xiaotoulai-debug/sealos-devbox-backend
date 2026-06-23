/**
 * v2：扩展脏数据扫描
 * 覆盖两种"身首异处"模式：
 *
 * 模式A：URL 中的 offerId ≠ externalProductId（URL 换链但 DB 未同步）
 * 模式B：URL 中的 offerId = externalProductId（表面一致），
 *         BUT 关联采购单 PurchaseOrderItem.offerId ≠ externalProductId
 *         说明 specId 是在旧 offerId 时代设置的，属于旧品规格，对新 offerId 无效
 */
import { prisma } from '../src/lib/prisma';

function extractOfferIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m =
    url.match(/\/offer\/(\d{10,})/i) ||
    url.match(/[?&]id=(\d{10,})/i)  ||
    url.match(/(\d{10,})/);
  return m ? m[1] : null;
}

async function main() {
  console.log('=== 脏数据扩展扫描 v2 ===\n');

  // 一次性拉取所有含 1688 链接、且有 externalSkuId 的产品
  const products = await prisma.product.findMany({
    where: {
      purchaseUrl:      { not: null, contains: '1688' },
      externalSkuId:    { not: null },   // 只有设了规格才可能脏
    },
    select: {
      id: true, sku: true,
      purchaseUrl: true,
      externalProductId: true,
      externalSkuId: true,
      externalSynced: true,
      purchaseOrderId: true,
    },
  });

  console.log(`扫描范围：${products.length} 条（已设 externalSkuId 且含 1688 链接）\n`);

  // 批量拉取所有关联采购单的 PurchaseOrderItem（通过 purchaseOrderId）
  const orderIds = [...new Set(products.map((p) => p.purchaseOrderId).filter(Boolean))] as number[];
  const items = orderIds.length > 0
    ? await prisma.purchaseOrderItem.findMany({
        where: { purchaseOrderId: { in: orderIds } },
        select: { purchaseOrderId: true, offerId: true },
      })
    : [];
  // purchaseOrderId → PurchaseOrderItem 的 offerId（旧商品 ID 快照）
  const orderToItemOfferId = new Map<number, string | null>();
  for (const item of items) {
    if (!orderToItemOfferId.has(item.purchaseOrderId)) {
      orderToItemOfferId.set(item.purchaseOrderId, item.offerId ?? null);
    }
  }

  const staleA: typeof products = [];  // 模式A：URL offerId ≠ externalProductId
  const staleB: typeof products = [];  // 模式B：externalProductId 已更新，但 specId 是旧品的
  const clean:  typeof products = [];

  for (const p of products) {
    const urlOfferId     = extractOfferIdFromUrl(p.purchaseUrl);
    const itemOfferId    = p.purchaseOrderId ? orderToItemOfferId.get(p.purchaseOrderId) ?? null : null;

    // 模式A
    if (urlOfferId && p.externalProductId && urlOfferId !== p.externalProductId) {
      staleA.push(p);
      continue;
    }

    // 模式B：externalProductId 与 URL 一致，但采购单子单的 offerId 是旧的
    // 说明：规格是在 offerId 是旧值时绑定的，对新 offerId 无效
    if (itemOfferId && p.externalProductId && itemOfferId !== p.externalProductId) {
      staleB.push(p);
      continue;
    }

    clean.push(p);
  }

  console.log(`  ✅ 干净数据:        ${clean.length} 条`);
  console.log(`  ❌ 模式A (URL错配): ${staleA.length} 条`);
  console.log(`  ❌ 模式B (specId串货): ${staleB.length} 条\n`);

  const allStale = [...staleA, ...staleB];
  if (allStale.length === 0) {
    console.log('🎉 无脏数据，无需修复。');
    return;
  }

  console.log('=== 脏数据明细 ===');
  for (const p of allStale) {
    const urlOfferId  = extractOfferIdFromUrl(p.purchaseUrl);
    const itemOfferId = p.purchaseOrderId ? orderToItemOfferId.get(p.purchaseOrderId) : 'N/A';
    const mode = staleB.includes(p) ? 'B(specId串货)' : 'A(URL错配)';
    console.log(`  [${mode}] SKU=${p.sku ?? `#${p.id}`}`);
    console.log(`    URL offerId:          ${urlOfferId}`);
    console.log(`    externalProductId:    ${p.externalProductId}`);
    console.log(`    PO子单 offerId:       ${itemOfferId}`);
    console.log(`    externalSkuId:        ${p.externalSkuId}`);
  }

  // 批量修复：清空 externalSkuId，重置 externalSynced
  const staleIds = allStale.map((p) => p.id);
  console.log(`\n=== 开始修复 ${staleIds.length} 条脏数据 ===`);

  const fixedCount = await prisma.product.updateMany({
    where: { id: { in: staleIds } },
    data: {
      externalSkuId:    null,
      externalSkuIdNum: null,
      externalSynced:   false,
    },
  });

  console.log(`✅ 已修复 ${fixedCount.count} 条记录（externalSkuId 清空，externalSynced=false）`);

  // 验证
  const verify = await prisma.product.findMany({
    where: { id: { in: staleIds } },
    select: { id: true, sku: true, externalSkuId: true, externalSynced: true },
  });
  console.log('\n=== 修复验证 ===');
  for (const p of verify) {
    const ok = p.externalSkuId === null && p.externalSynced === false;
    console.log(`  ${ok ? '✅' : '❌'} SKU=${p.sku ?? `#${p.id}`} externalSkuId=${p.externalSkuId} externalSynced=${p.externalSynced}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
