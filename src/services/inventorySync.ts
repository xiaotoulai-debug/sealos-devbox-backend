/**
 * 库存同步 — 将本地库存（Product.stockActual / Inventory 关联）推送到 eMAG 平台
 * 数据流: StoreProduct.mappedInventorySku -> Product.sku -> Product.stockActual -> eMAG offer/save
 */
import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';
import { batchUpdateStock } from './emagLogistics';

const BATCH_SIZE = 50;
const DELAY_MS = 400;  // 限速

export interface InventorySyncResult {
  shopId: number;
  updatedCount: number;
  errors: string[];
}

export async function syncInventoryToPlatform(): Promise<InventorySyncResult[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
  });

  const results: InventorySyncResult[] = [];
  for (const shop of shops) {
    const result: InventorySyncResult = { shopId: shop.id, updatedCount: 0, errors: [] };
    try {
      const creds = await getEmagCredentials(shop.id);
      const storeProducts = await prisma.storeProduct.findMany({
        where: {
          shopId: shop.id,
          mappedInventorySku: { not: null },
        },
        select: { pnk: true, mappedInventorySku: true },
      });

      const skus = storeProducts.map((p) => (p.mappedInventorySku ?? '').trim()).filter(Boolean);
      if (skus.length === 0) {
        results.push(result);
        continue;
      }

      const products = await prisma.product.findMany({
        where: { sku: { in: skus } },
        select: { sku: true, stockActual: true },
      });
      const skuToStock = new Map(products.map((p) => [p.sku, Math.max(0, Math.round(Number(p.stockActual) || 0))]));

      const items: Array<{ partNumber: string; stock: number }> = [];
      for (const sp of storeProducts) {
        const invSku = (sp.mappedInventorySku ?? '').trim();
        if (!invSku) continue;
        const stock = skuToStock.get(invSku) ?? 0;
        items.push({ partNumber: sp.pnk, stock });
      }

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const res = await batchUpdateStock(creds, batch);
        if (res.isError) {
          result.errors.push(`batch ${i / BATCH_SIZE + 1}: ${res.messages?.join(';') ?? 'API 错误'}`);
        } else {
          result.updatedCount += batch.length;
        }
        if (i + BATCH_SIZE < items.length) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      }
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
    results.push(result);
  }
  return results;
}
