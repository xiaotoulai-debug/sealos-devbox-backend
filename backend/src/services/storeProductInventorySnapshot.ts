import { prisma } from '../lib/prisma';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';
import { calculateComprehensiveSales } from './productClassification';

export type InventorySnapshotOptions = {
  dryRun?: boolean;
  shopId?: number;
  snapshotDate?: Date;
};

export type InventorySnapshotSummary = {
  dryRun: boolean;
  shopId: number;
  snapshotDate: string;
  scanned: number;
  planned: number;
  created: number;
  updated: number;
  samples: Array<{
    storeProductId: number;
    sku: string | null;
    platformStock: number;
    inTransitStock: number;
    sales30: number;
    comprehensiveSales: number;
    existed: boolean;
  }>;
};

const UPSERT_BATCH_SIZE = 100;

function normalizeSnapshotDate(input?: Date): Date {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new Error('snapshotDate 无效');
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeSkuKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

async function buildLocalProductMap(
  products: Array<{ pnk: string; mappedInventorySku: string | null; sku: string | null; vendorSku: string | null }>,
) {
  const skuKeys = new Set<string>();
  const pnks = new Set<string>();
  for (const p of products) {
    const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
    if (skuKey) skuKeys.add(skuKey);
    if (p.pnk) pnks.add(p.pnk);
  }

  const [bySku, byPnk] = await Promise.all([
    skuKeys.size > 0
      ? prisma.product.findMany({
          where: { sku: { in: [...skuKeys] }, isDeleted: false },
          select: { id: true, sku: true },
        })
      : Promise.resolve([]),
    pnks.size > 0
      ? prisma.product.findMany({
          where: { pnk: { in: [...pnks] }, isDeleted: false },
          select: { id: true, pnk: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    skuToProductId: new Map(bySku.map((p) => [normalizeSkuKey(p.sku), p.id])),
    pnkToProductId: new Map(byPnk.map((p) => [p.pnk!, p.id])),
  };
}

export async function createInventorySnapshotsForShop(
  shopId: number,
  options: InventorySnapshotOptions = {},
): Promise<InventorySnapshotSummary> {
  if (!Number.isInteger(shopId) || shopId <= 0) {
    throw new Error('shopId 必须是正整数');
  }

  const dryRun = options.dryRun ?? true;
  const snapshotDate = normalizeSnapshotDate(options.snapshotDate);
  const snapshotDateKey = dateKey(snapshotDate);

  const [salesStats, products] = await Promise.all([
    getSalesStatsByShop(shopId, true),
    prisma.storeProduct.findMany({
      where: { shopId, isArchived: false },
      select: {
        id: true,
        shopId: true,
        pnk: true,
        sku: true,
        vendorSku: true,
        mappedInventorySku: true,
        stock: true,
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  const localMaps = await buildLocalProductMap(products);
  const productIdByStoreProductId = new Map<number, number>();
  for (const p of products) {
    const skuKey = normalizeSkuKey((p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim());
    const localProductId = (skuKey ? localMaps.skuToProductId.get(skuKey) : undefined) ?? localMaps.pnkToProductId.get(p.pnk);
    if (localProductId) productIdByStoreProductId.set(p.id, localProductId);
  }

  const localProductIds = [...new Set([...productIdByStoreProductId.values()])];
  const inTransitByProductId = new Map<number, number>();
  if (localProductIds.length > 0) {
    const fbeItems = await prisma.fbeShipmentItem.findMany({
      where: {
        productId: { in: localProductIds },
        shipment: { shopId, status: 'SHIPPED' },
      },
      select: { productId: true, quantity: true },
    });
    for (const item of fbeItems) {
      inTransitByProductId.set(item.productId, (inTransitByProductId.get(item.productId) ?? 0) + item.quantity);
    }
  }

  const existing = await prisma.storeProductInventorySnapshot.findMany({
    where: {
      snapshotDate,
      storeProductId: { in: products.map((p) => p.id) },
    },
    select: { storeProductId: true },
  });
  const existingIds = new Set(existing.map((row) => row.storeProductId));

  const rows = products.map((p) => {
    const sales = getSalesForProduct(salesStats.map, p.sku, p.vendorSku, p.pnk);
    const comprehensiveSales = calculateComprehensiveSales(sales, p.stock);
    const localProductId = productIdByStoreProductId.get(p.id);
    return {
      storeProductId: p.id,
      shopId: p.shopId,
      sku: p.sku ?? p.vendorSku ?? null,
      snapshotDate,
      platformStock: p.stock,
      inTransitStock: localProductId ? inTransitByProductId.get(localProductId) ?? 0 : 0,
      sales7: sales.d7,
      sales14: sales.d14,
      sales30: sales.d30,
      comprehensiveSales,
      existed: existingIds.has(p.id),
    };
  });

  const summary: InventorySnapshotSummary = {
    dryRun,
    shopId,
    snapshotDate: snapshotDateKey,
    scanned: products.length,
    planned: rows.length,
    created: rows.filter((row) => !row.existed).length,
    updated: rows.filter((row) => row.existed).length,
    samples: rows.slice(0, 8).map((row) => ({
      storeProductId: row.storeProductId,
      sku: row.sku,
      platformStock: row.platformStock,
      inTransitStock: row.inTransitStock,
      sales30: row.sales30,
      comprehensiveSales: row.comprehensiveSales,
      existed: row.existed,
    })),
  };

  if (dryRun) return summary;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    await Promise.all(batch.map((row) => prisma.storeProductInventorySnapshot.upsert({
      where: {
        storeProductId_snapshotDate: {
          storeProductId: row.storeProductId,
          snapshotDate: row.snapshotDate,
        },
      },
      create: {
        shopId: row.shopId,
        storeProductId: row.storeProductId,
        sku: row.sku,
        snapshotDate: row.snapshotDate,
        platformStock: row.platformStock,
        inTransitStock: row.inTransitStock,
        sales7: row.sales7,
        sales14: row.sales14,
        sales30: row.sales30,
        comprehensiveSales: row.comprehensiveSales,
      },
      update: {
        sku: row.sku,
        platformStock: row.platformStock,
        inTransitStock: row.inTransitStock,
        sales7: row.sales7,
        sales14: row.sales14,
        sales30: row.sales30,
        comprehensiveSales: row.comprehensiveSales,
      },
    })));
  }

  return summary;
}

export async function createInventorySnapshotsForAllShops(options: InventorySnapshotOptions = {}): Promise<InventorySnapshotSummary[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const results: InventorySnapshotSummary[] = [];
  for (const shop of shops) {
    results.push(await createInventorySnapshotsForShop(shop.id, options));
  }
  return results;
}
