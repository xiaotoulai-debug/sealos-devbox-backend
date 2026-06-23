/**
 * 临时补救：将 product_ids 为空、[] 或无效 JSON 的 PurchaseOrderItem 按以下规则补全并写回 DB：
 *   1) 同采购单下 Product.purchaseOrderId 匹配 → offerId 对齐 externalProductId 或唯一产品
 *   2) 若无挂载产品，则子单 offerId 与 Product.externalProductId 相等且 isDeleted=false 时取第一条（多条则跳过，需人工）
 *
 * 运行（在 backend 目录）：
 *   npx tsx scripts/backfill-purchase-order-item-product-ids.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function needsBackfill(productIds: string | null): boolean {
  if (productIds == null || String(productIds).trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(productIds);
    if (!Array.isArray(parsed) || parsed.length === 0) return true;
    const nums = parsed.map((x) => parseInt(String(x), 10)).filter((n) => !Number.isNaN(n) && n > 0);
    return nums.length === 0;
  } catch {
    return true;
  }
}

function buildJson(
  item: { offerId: string | null; productIds: string | null },
  products: { id: number; externalProductId: string | null }[],
): string | null {
  if (!needsBackfill(item.productIds)) return null;
  const offer = String(item.offerId ?? '').trim();
  if (offer) {
    const matched = products.filter((p) => String(p.externalProductId ?? '').trim() === offer);
    if (matched.length > 0) return JSON.stringify(matched.map((m) => m.id));
  }
  if (products.length === 1) return JSON.stringify([products[0].id]);
  if (products.length > 1) return JSON.stringify(products.map((p) => p.id));
  return null;
}

async function main() {
  const items = await prisma.purchaseOrderItem.findMany({
    select: { id: true, purchaseOrderId: true, offerId: true, productIds: true },
  });
  const candidates = items.filter((i) => needsBackfill(i.productIds));
  let updated = 0;

  for (const item of candidates) {
    let products = await prisma.product.findMany({
      where: { purchaseOrderId: item.purchaseOrderId },
      select: { id: true, externalProductId: true },
    });

    if (products.length === 0) {
      const offer = String(item.offerId ?? '').trim();
      if (!offer) continue;
      const hits = await prisma.product.findMany({
        where: { externalProductId: offer, isDeleted: false },
        select: { id: true, externalProductId: true },
        take: 8,
      });
      if (hits.length !== 1) continue;
      products = hits;
    }

    const json = buildJson(item, products);
    if (!json) continue;

    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data:  { productIds: json },
    });
    updated++;
    console.log(`item #${item.id} (PO ${item.purchaseOrderId}) → product_ids ${json}`);
  }

  console.log(`\n完成：扫描 ${candidates.length} 条待修复子单，实际更新 ${updated} 条。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
