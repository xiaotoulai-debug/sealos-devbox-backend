import { prisma } from '../lib/prisma';

/**
 * 按 StoreProduct.id 聚合当前店铺 SHIPPED 状态 FBE 在途数量。
 * 仅查询传入的 storeProductIds，禁止全表扫描。
 */
export async function aggregateFbeInTransitByStoreProductIds(
  shopId: number,
  storeProductIds: number[],
): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (storeProductIds.length === 0) return result;

  const directItems = await prisma.fbeShipmentItem.findMany({
    where: {
      storeProductId: { in: storeProductIds },
      shipment: { shopId, status: 'SHIPPED' },
    },
    select: { storeProductId: true, quantity: true },
  });

  for (const item of directItems) {
    if (item.storeProductId == null) continue;
    result.set(
      item.storeProductId,
      (result.get(item.storeProductId) ?? 0) + item.quantity,
    );
  }

  return result;
}

/**
 * 历史明细 storeProductId 为空时的唯一命中 fallback。
 * 多映射时不分配、输出 warning；禁止复制到多条 EAN。
 */
export async function applyLegacyFbeInTransitFallback(
  shopId: number,
  storeProductIds: number[],
  productIdByStoreProductId: Map<number, number>,
  inTransitMap: Map<number, number>,
): Promise<void> {
  const productIds = [...new Set(productIdByStoreProductId.values())];
  if (productIds.length === 0) return;

  const legacyItems = await prisma.fbeShipmentItem.findMany({
    where: {
      storeProductId: null,
      productId: { in: productIds },
      shipment: { shopId, status: 'SHIPPED' },
    },
    select: { productId: true, quantity: true },
  });
  if (legacyItems.length === 0) return;

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, sku: true },
  });
  const skuByProductId = new Map(
    products.map((p) => [p.id, String(p.sku ?? '').trim()]),
  );

  const skus = [...new Set(
    products.map((p) => String(p.sku ?? '').trim()).filter(Boolean),
  )];
  if (skus.length === 0) return;

  const storeProductsBySku = await prisma.storeProduct.findMany({
    where: { shopId, isArchived: false, mappedInventorySku: { in: skus } },
    select: { id: true, mappedInventorySku: true },
  });

  const storeProductsPerSku = new Map<string, number[]>();
  for (const sp of storeProductsBySku) {
    const sku = String(sp.mappedInventorySku ?? '').trim();
    if (!sku) continue;
    const arr = storeProductsPerSku.get(sku) ?? [];
    arr.push(sp.id);
    storeProductsPerSku.set(sku, arr);
  }

  const legacyQtyByProductId = new Map<number, number>();
  for (const item of legacyItems) {
    legacyQtyByProductId.set(
      item.productId,
      (legacyQtyByProductId.get(item.productId) ?? 0) + item.quantity,
    );
  }

  const storeProductIdSet = new Set(storeProductIds);

  for (const [productId, qty] of legacyQtyByProductId) {
    const sku = skuByProductId.get(productId) ?? '';
    if (!sku) continue;
    const candidates = storeProductsPerSku.get(sku) ?? [];
    if (candidates.length === 1) {
      const spId = candidates[0];
      if (storeProductIdSet.has(spId)) {
        inTransitMap.set(spId, (inTransitMap.get(spId) ?? 0) + qty);
      }
    } else if (candidates.length > 1) {
      console.warn(
        `[FBE in-transit] 历史明细平台产品来源不唯一，无法自动判定 storeProductId ` +
        `productId=${productId} shopId=${shopId} candidates=[${candidates.join(',')}]`,
      );
    }
  }
}

/** 构建当前页 StoreProduct 维度在途 Map（含历史唯一 fallback） */
export async function buildStoreProductInTransitMap(
  shopId: number,
  storeProductIds: number[],
  productIdByStoreProductId: Map<number, number>,
): Promise<Map<number, number>> {
  const map = await aggregateFbeInTransitByStoreProductIds(shopId, storeProductIds);
  await applyLegacyFbeInTransitFallback(
    shopId,
    storeProductIds,
    productIdByStoreProductId,
    map,
  );
  return map;
}
