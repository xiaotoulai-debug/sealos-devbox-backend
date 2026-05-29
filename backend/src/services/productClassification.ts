import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';

export const PRODUCT_CLASSES = [
  'HOT',
  'POTENTIAL',
  'NORMAL',
  'DEAD',
  'TO_BE_ELIMINATED',
  'NEW',
] as const;

export type ProductClass = typeof PRODUCT_CLASSES[number];

export const STOCK_STATUSES = [
  'OUT_OF_STOCK',
  'LOW_STOCK',
  'WARNING',
  'SAFE',
  'OVERSTOCK',
] as const;

export type StockStatus = typeof STOCK_STATUSES[number];

export const PRODUCT_CLASS_RULES = {
  newDays: 30,
  hotComprehensiveSales: 1,
  hotSales30: 30,
  hotSales7: 7,
  potentialComprehensiveSales: 0.2,
  potentialSales30: 5,
  potentialSales7: 2,
  deadComprehensiveSales: 0.05,
} as const;

export type ClassifyStoreProductInput = {
  stock: number;
  inTransitStock?: number;
  syncedAt: Date;
  sales7: number;
  sales14: number;
  sales30: number;
  comprehensiveSales: number;
};

export type ClassificationMetrics = {
  stock: number;
  inTransitStock: number;
  sales7: number;
  sales14: number;
  sales30: number;
  sales7Daily: number;
  sales30Daily: number;
  comprehensiveSales: number;
  daysSinceSynced: number;
  sales90: null;
  availableDays90: null;
  inStockDailySales90: null;
};

export type StockStatusResult = {
  stockStatus: StockStatus;
  stockDays: number | null;
  referenceDailySales: number;
};

export type ClassifyStoreProductResult = {
  productClass: ProductClass;
  reason: string;
  metrics: ClassificationMetrics;
};

export type ProductClassRecalcOptions = {
  dryRun?: boolean;
  shopId?: number;
};

export type ProductClassRecalcSummary = {
  dryRun: boolean;
  shopId?: number;
  scanned: number;
  updated: number;
  counts: Record<ProductClass, number>;
  samples: Record<ProductClass, Array<{ id: number; sku: string | null; pnk: string; before: string | null; after: ProductClass }>>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const UPDATE_BATCH_SIZE = 50;

export function isProductClass(value: string): value is ProductClass {
  return (PRODUCT_CLASSES as readonly string[]).includes(value);
}

export function normalizeProductClassQuery(raw: unknown): ProductClass | 'all' | null {
  if (raw == null) return null;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase();
  if (!value || value === 'ALL') return 'all';
  return isProductClass(value) ? value : null;
}

export function calculateComprehensiveSales(sales7: number, sales14: number, sales30: number): number {
  return parseFloat((((sales7 / 7) * 0.3) + ((sales14 / 14) * 0.3) + ((sales30 / 30) * 0.4)).toFixed(2));
}

export function calculateStockStatus(platformStock: number, comprehensiveSales: number, sales30: number): StockStatusResult {
  const stock = Number(platformStock ?? 0);
  const referenceDailySales = Math.max(Number(comprehensiveSales ?? 0), Number(sales30 ?? 0) / 30);
  const roundedReferenceDailySales = parseFloat(referenceDailySales.toFixed(4));

  if (stock <= 0) {
    return {
      stockStatus: 'OUT_OF_STOCK',
      stockDays: null,
      referenceDailySales: roundedReferenceDailySales,
    };
  }

  if (referenceDailySales <= 0) {
    return {
      stockStatus: 'SAFE',
      stockDays: null,
      referenceDailySales: 0,
    };
  }

  const stockDays = parseFloat((stock / referenceDailySales).toFixed(2));
  if (stockDays <= 30) return { stockStatus: 'LOW_STOCK', stockDays, referenceDailySales: roundedReferenceDailySales };
  if (stockDays <= 60) return { stockStatus: 'WARNING', stockDays, referenceDailySales: roundedReferenceDailySales };
  if (stockDays <= 120) return { stockStatus: 'SAFE', stockDays, referenceDailySales: roundedReferenceDailySales };
  return { stockStatus: 'OVERSTOCK', stockDays, referenceDailySales: roundedReferenceDailySales };
}

export function classifyStoreProduct(input: ClassifyStoreProductInput, now = new Date()): ClassifyStoreProductResult {
  const stock = Number(input.stock ?? 0);
  const inTransitStock = Number(input.inTransitStock ?? 0);
  const sales7 = Number(input.sales7 ?? 0);
  const sales14 = Number(input.sales14 ?? 0);
  const sales30 = Number(input.sales30 ?? 0);
  const comprehensiveSales = Number(input.comprehensiveSales ?? 0);
  const daysSinceSynced = Math.max(0, Math.floor((now.getTime() - input.syncedAt.getTime()) / DAY_MS));
  const sales7Daily = sales7 / 7;
  const sales30Daily = sales30 / 30;

  const metrics: ClassificationMetrics = {
    stock,
    inTransitStock,
    sales7,
    sales14,
    sales30,
    sales7Daily: parseFloat(sales7Daily.toFixed(4)),
    sales30Daily: parseFloat(sales30Daily.toFixed(4)),
    comprehensiveSales,
    daysSinceSynced,
    sales90: null,
    availableDays90: null,
    inStockDailySales90: null,
  };

  const isSyncedNewWithoutSales = daysSinceSynced <= PRODUCT_CLASS_RULES.newDays && sales30 === 0;
  const isIncomingNewWithoutSales =
    sales7 === 0 &&
    sales14 === 0 &&
    sales30 === 0 &&
    comprehensiveSales < PRODUCT_CLASS_RULES.deadComprehensiveSales &&
    stock === 0 &&
    inTransitStock > 0;

  if (isSyncedNewWithoutSales || isIncomingNewWithoutSales) {
    return {
      productClass: 'NEW',
      reason: isIncomingNewWithoutSales
        ? '近7/14/30天暂无销量、平台库存为0且存在FBE在途库存，说明产品尚未真正开始售卖，归为新品待到货。'
        : '基于 StoreProduct.syncedAt 判断为 ERP 新同步产品，且近30天暂无销量；该时间不是 eMAG 真实上架时间。',
      metrics,
    };
  }

  if (
    comprehensiveSales >= PRODUCT_CLASS_RULES.hotComprehensiveSales ||
    sales30 >= PRODUCT_CLASS_RULES.hotSales30 ||
    sales7 >= PRODUCT_CLASS_RULES.hotSales7
  ) {
    return {
      productClass: 'HOT',
      reason: '综合日销、近30天销量或近7天销量达到热销阈值。',
      metrics,
    };
  }

  if (
    comprehensiveSales >= PRODUCT_CLASS_RULES.potentialComprehensiveSales ||
    sales30 >= PRODUCT_CLASS_RULES.potentialSales30 ||
    sales7 >= PRODUCT_CLASS_RULES.potentialSales7
  ) {
    return {
      productClass: 'POTENTIAL',
      reason: '综合日销、近30天销量或近7天销量达到潜力款阈值。',
      metrics,
    };
  }

  if (stock > 0 && daysSinceSynced > PRODUCT_CLASS_RULES.newDays && sales30 === 0 && comprehensiveSales < PRODUCT_CLASS_RULES.deadComprehensiveSales) {
    return {
      productClass: 'DEAD',
      reason: '当前有平台库存但近30天无销量且综合日销低于0.05；第一阶段尚无 90 天有货天数，当前仅为弱滞销判断。',
      metrics,
    };
  }

  if (
    sales7 === 0 &&
    sales14 === 0 &&
    sales30 === 0 &&
    comprehensiveSales < PRODUCT_CLASS_RULES.deadComprehensiveSales &&
    stock === 0 &&
    inTransitStock === 0 &&
    daysSinceSynced > PRODUCT_CLASS_RULES.newDays
  ) {
    return {
      productClass: 'TO_BE_ELIMINATED',
      reason: '近7/14/30天暂无销量，平台库存为0且无在途库存，说明当前没有继续销售或补货动作，归为待淘汰款，建议人工确认是否继续采购或下架。',
      metrics,
    };
  }

  return {
    productClass: 'NORMAL',
    reason: '未命中新品、热销、潜力、弱滞销或待淘汰规则，归为普通款。',
    metrics,
  };
}

function emptyCounts(): Record<ProductClass, number> {
  return PRODUCT_CLASSES.reduce((acc, c) => {
    acc[c] = 0;
    return acc;
  }, {} as Record<ProductClass, number>);
}

function emptySamples(): ProductClassRecalcSummary['samples'] {
  return PRODUCT_CLASSES.reduce((acc, c) => {
    acc[c] = [];
    return acc;
  }, {} as ProductClassRecalcSummary['samples']);
}

function normalizeSkuKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

async function buildLocalProductIdMap(
  products: Array<{ pnk: string; mappedInventorySku: string | null; sku: string | null; vendorSku: string | null }>,
): Promise<Map<string, number>> {
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

  const skuToProductId = new Map(bySku.map((p) => [normalizeSkuKey(p.sku), p.id]));
  const pnkToProductId = new Map(byPnk.map((p) => [p.pnk!, p.id]));
  const storeProductIdToProductId = new Map<string, number>();
  for (const p of products) {
    const skuKey = normalizeSkuKey((p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim());
    const productId = (skuKey ? skuToProductId.get(skuKey) : undefined) ?? pnkToProductId.get(p.pnk);
    if (productId) storeProductIdToProductId.set(p.pnk, productId);
  }
  return storeProductIdToProductId;
}

async function recalcForProducts(shopId: number, dryRun: boolean): Promise<ProductClassRecalcSummary> {
  const { map: salesMap } = await getSalesStatsByShop(shopId, true);
  const products = await prisma.storeProduct.findMany({
    where: { shopId, isArchived: false },
    select: {
      id: true,
      pnk: true,
      sku: true,
      vendorSku: true,
      mappedInventorySku: true,
      stock: true,
      syncedAt: true,
      productClass: true,
    },
    orderBy: { id: 'asc' },
  });

  const productIdByPnk = await buildLocalProductIdMap(products);
  const localProductIds = [...new Set([...productIdByPnk.values()])];
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

  const now = new Date();
  const summary: ProductClassRecalcSummary = {
    dryRun,
    shopId,
    scanned: products.length,
    updated: 0,
    counts: emptyCounts(),
    samples: emptySamples(),
  };

  const pendingUpdates: Array<{
    id: number;
    productClass: ProductClass;
    reason: string;
    metrics: ClassificationMetrics;
    comprehensiveSales: number;
  }> = [];

  for (const p of products) {
    const sales = getSalesForProduct(salesMap, p.sku, p.vendorSku);
    const comprehensiveSales = calculateComprehensiveSales(sales.d7, sales.d14, sales.d30);
    const localProductId = productIdByPnk.get(p.pnk);
    const inTransitStock = localProductId ? inTransitByProductId.get(localProductId) ?? 0 : 0;
    const classified = classifyStoreProduct({
      stock: p.stock,
      inTransitStock,
      syncedAt: p.syncedAt,
      sales7: sales.d7,
      sales14: sales.d14,
      sales30: sales.d30,
      comprehensiveSales,
    }, now);

    summary.counts[classified.productClass]++;
    if (summary.samples[classified.productClass].length < 5) {
      summary.samples[classified.productClass].push({
        id: p.id,
        sku: p.sku,
        pnk: p.pnk,
        before: p.productClass,
        after: classified.productClass,
      });
    }

    if (p.productClass !== classified.productClass || !dryRun) {
      pendingUpdates.push({
        id: p.id,
        productClass: classified.productClass,
        reason: classified.reason,
        metrics: classified.metrics,
        comprehensiveSales,
      });
    }
  }

  if (dryRun) {
    summary.updated = pendingUpdates.length;
    return summary;
  }

  for (let i = 0; i < pendingUpdates.length; i += UPDATE_BATCH_SIZE) {
    const batch = pendingUpdates.slice(i, i + UPDATE_BATCH_SIZE);
    await Promise.all(batch.map((item) => prisma.storeProduct.update({
      where: { id: item.id },
      data: {
        productClass: item.productClass,
        classificationReason: item.reason,
        classificationMetrics: item.metrics as unknown as Prisma.InputJsonValue,
        classifiedAt: now,
        comprehensiveSales: item.comprehensiveSales,
      },
    })));
    summary.updated += batch.length;
  }

  return summary;
}

export async function recalcProductClassForShop(shopId: number, options: ProductClassRecalcOptions = {}): Promise<ProductClassRecalcSummary> {
  if (!Number.isInteger(shopId) || shopId <= 0) {
    throw new Error('shopId 必须是正整数');
  }
  return recalcForProducts(shopId, options.dryRun ?? false);
}

export async function recalcProductClassForAllShops(options: ProductClassRecalcOptions = {}): Promise<ProductClassRecalcSummary[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
    orderBy: { id: 'asc' },
  });

  const results: ProductClassRecalcSummary[] = [];
  for (const shop of shops) {
    results.push(await recalcForProducts(shop.id, options.dryRun ?? false));
  }
  return results;
}
