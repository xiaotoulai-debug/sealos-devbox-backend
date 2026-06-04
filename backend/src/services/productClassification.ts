import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';

export const PRODUCT_CLASSES = [
  'HOT',
  'POTENTIAL',
  'NORMAL',
  'CLEARANCE',
] as const;

export type ProductClass = typeof PRODUCT_CLASSES[number];

export const PRODUCT_CLASS_NAMES: Record<ProductClass, string> = {
  HOT: '主推款',
  POTENTIAL: '成长款',
  NORMAL: '常规款',
  CLEARANCE: '清理款',
};

export const STOCK_STATUSES = [
  'OUT_OF_STOCK',
  'LOW_STOCK',
  'WARNING',
  'SAFE',
  'OVERSTOCK',
] as const;

export type StockStatus = typeof STOCK_STATUSES[number];

export const PRODUCT_CLASS_RULES = {
  hotComprehensiveSales: 0.8,
  hotSales30: 15,
  hotStockoutSales60: 20,
  hotStockoutSales90: 30,
  potentialComprehensiveSales: 0.15,
  clearanceComprehensiveSales: 0.03,
} as const;

export type ClassifyStoreProductInput = {
  stock: number;
  inTransitStock?: number;
  syncedAt?: Date;
  mappedInventorySku?: string | null;
  mainImage?: string | null;
  imageUrl?: string | null;
  estimatedProfit?: number | null;
};

export type ClassificationSalesStats = {
  d3?: number;
  d7: number;
  d14: number;
  d30: number;
  d60?: number;
  d90?: number;
  d180?: number;
  lastOrderAt?: Date | string | null;
};

export type ClassificationMetrics = {
  stock: number;
  inTransitStock: number;
  sales3: number;
  sales7: number;
  sales14: number;
  sales30: number;
  sales60: number;
  sales90: number;
  sales180: number;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
  sales3Daily: number;
  sales7Daily: number;
  sales14Daily: number;
  sales30Daily: number;
  sales60Daily: number;
  sales90Daily: number;
  baseComprehensiveSales: number;
  stockoutProtectedSales: number;
  comprehensiveSales: number;
  daysSinceSynced: number;
  stockoutProtected: boolean;
};

export type StockStatusResult = {
  stockStatus: StockStatus;
  stockDays: number | null;
  referenceDailySales: number;
};

export type ClassifyStoreProductResult = {
  productClass: ProductClass;
  classificationName: string;
  reason: string;
  metrics: ClassificationMetrics;
  riskTags: string[];
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
  if (value === 'DEAD' || value === 'TO_BE_ELIMINATED') return 'CLEARANCE';
  if (value === 'NEW' || value === 'OUT_OF_STOCK_WATCH') return 'NORMAL';
  return isProductClass(value) ? value : null;
}

function numberValue(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function calculateBaseComprehensiveSales(salesStats: ClassificationSalesStats): number {
  const d3 = numberValue(salesStats.d3);
  const d7 = numberValue(salesStats.d7);
  const d14 = numberValue(salesStats.d14);
  const d30 = numberValue(salesStats.d30);
  const d60 = numberValue(salesStats.d60);
  const d90 = numberValue(salesStats.d90);
  return (d3 / 3) * 0.20 +
    (d7 / 7) * 0.20 +
    (d14 / 14) * 0.20 +
    (d30 / 30) * 0.20 +
    (d60 / 60) * 0.10 +
    (d90 / 90) * 0.10;
}

export function calculateStockoutProtectedSales(salesStats: ClassificationSalesStats, stock: number): number {
  const d60 = numberValue(salesStats.d60);
  const d90 = numberValue(salesStats.d90);
  return stock <= 0 && (d60 > 0 || d90 > 0)
    ? Math.max(d60 / 60, d90 / 90) * 0.7
    : 0;
}

export function calculateComprehensiveSales(salesStats: ClassificationSalesStats, stock = 0): number {
  const baseComprehensiveSales = calculateBaseComprehensiveSales(salesStats);
  const stockoutProtectedSales = calculateStockoutProtectedSales(salesStats, stock);
  return parseFloat(Math.max(baseComprehensiveSales, stockoutProtectedSales).toFixed(4));
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

function buildClassificationMetrics(input: ClassifyStoreProductInput, salesStats: ClassificationSalesStats, now: Date): ClassificationMetrics {
  const stock = numberValue(input.stock);
  const inTransitStock = numberValue(input.inTransitStock);
  const sales3 = numberValue(salesStats.d3);
  const sales7 = numberValue(salesStats.d7);
  const sales14 = numberValue(salesStats.d14);
  const sales30 = numberValue(salesStats.d30);
  const sales60 = numberValue(salesStats.d60);
  const sales90 = numberValue(salesStats.d90);
  const sales180 = numberValue(salesStats.d180);
  const baseComprehensiveSales = calculateBaseComprehensiveSales(salesStats);
  const stockoutProtectedSales = calculateStockoutProtectedSales(salesStats, stock);
  const comprehensiveSales = calculateComprehensiveSales(salesStats, stock);
  const syncedAt = normalizeDate(input.syncedAt);
  const daysSinceSynced = syncedAt ? Math.max(0, Math.floor((now.getTime() - syncedAt.getTime()) / DAY_MS)) : -1;
  const lastOrderAt = normalizeDate(salesStats.lastOrderAt);
  const daysSinceLastOrder = lastOrderAt
    ? Math.max(0, Math.floor((now.getTime() - lastOrderAt.getTime()) / DAY_MS))
    : null;

  return {
    stock,
    inTransitStock,
    sales3,
    sales7,
    sales14,
    sales30,
    sales60,
    sales90,
    sales180,
    lastOrderAt: lastOrderAt ? lastOrderAt.toISOString() : null,
    daysSinceLastOrder,
    sales3Daily: parseFloat((sales3 / 3).toFixed(4)),
    sales7Daily: parseFloat((sales7 / 7).toFixed(4)),
    sales14Daily: parseFloat((sales14 / 14).toFixed(4)),
    sales30Daily: parseFloat((sales30 / 30).toFixed(4)),
    sales60Daily: parseFloat((sales60 / 60).toFixed(4)),
    sales90Daily: parseFloat((sales90 / 90).toFixed(4)),
    baseComprehensiveSales: parseFloat(baseComprehensiveSales.toFixed(4)),
    stockoutProtectedSales: parseFloat(stockoutProtectedSales.toFixed(4)),
    comprehensiveSales,
    daysSinceSynced,
    stockoutProtected: stockoutProtectedSales > 0,
  };
}

export function getProductRiskTags(input: ClassifyStoreProductInput, salesStats: ClassificationSalesStats): string[] {
  const stock = numberValue(input.stock);
  const d30 = numberValue(salesStats.d30);
  const d60 = numberValue(salesStats.d60);
  const d90 = numberValue(salesStats.d90);
  const comprehensiveSales = calculateComprehensiveSales(salesStats, stock);
  const tags: string[] = [];

  if (stock <= 0 && (d30 > 0 || d60 > 0 || d90 > 0)) tags.push('断货');
  if (stock > 0 && comprehensiveSales > 0 && stock / comprehensiveSales <= 7) tags.push('低库存');
  if (stock > 0 && comprehensiveSales > 0 && stock / comprehensiveSales >= 60) tags.push('库存偏多');
  if (d30 === 0 && d60 === 0 && d90 === 0) tags.push('无销量');
  if (!String(input.mappedInventorySku ?? '').trim()) tags.push('未关联SKU');
  if (!String(input.mainImage ?? '').trim() && !String(input.imageUrl ?? '').trim()) tags.push('无图片');
  if (input.estimatedProfit != null && Number(input.estimatedProfit) < 0) tags.push('负毛利');

  return tags;
}

export function classifyStoreProduct(
  input: ClassifyStoreProductInput,
  salesStats: ClassificationSalesStats,
  now = new Date(),
): ClassifyStoreProductResult {
  const metrics = buildClassificationMetrics(input, salesStats, now);
  const stock = metrics.stock;
  const sales3 = metrics.sales3;
  const sales7 = metrics.sales7;
  const sales14 = metrics.sales14;
  const sales30 = metrics.sales30;
  const sales60 = metrics.sales60;
  const sales90 = metrics.sales90;
  const comprehensiveSales = metrics.comprehensiveSales;
  const riskTags = getProductRiskTags(input, salesStats);

  if (
    comprehensiveSales >= PRODUCT_CLASS_RULES.hotComprehensiveSales ||
    sales30 >= PRODUCT_CLASS_RULES.hotSales30 ||
    (stock <= 0 && (sales60 >= PRODUCT_CLASS_RULES.hotStockoutSales60 || sales90 >= PRODUCT_CLASS_RULES.hotStockoutSales90))
  ) {
    return {
      productClass: 'HOT',
      classificationName: PRODUCT_CLASS_NAMES.HOT,
      reason: stock <= 0 && (sales60 >= PRODUCT_CLASS_RULES.hotStockoutSales60 || sales90 >= PRODUCT_CLASS_RULES.hotStockoutSales90)
        ? '当前断货但 60/90 天历史销量达到主推阈值，需要重点保供。'
        : '综合日销或近30天销量达到主推阈值。',
      metrics,
      riskTags,
    };
  }

  if (sales3 > 0 || sales7 > 0 || sales14 > 0 || comprehensiveSales >= PRODUCT_CLASS_RULES.potentialComprehensiveSales) {
    return {
      productClass: 'POTENTIAL',
      classificationName: PRODUCT_CLASS_NAMES.POTENTIAL,
      reason: sales3 > 0 || sales7 > 0 || sales14 > 0
        ? '近3/7/14天已有动销，归为成长款继续观察。'
        : '综合日销达到成长款阈值。',
      metrics,
      riskTags,
    };
  }

  if (
    (stock > 0 && sales30 === 0 && sales60 === 0 && sales90 === 0) ||
    (stock > 0 && comprehensiveSales < PRODUCT_CLASS_RULES.clearanceComprehensiveSales)
  ) {
    return {
      productClass: 'CLEARANCE',
      classificationName: PRODUCT_CLASS_NAMES.CLEARANCE,
      reason: sales30 === 0 && sales60 === 0 && sales90 === 0
        ? '当前有库存但近30/60/90天均无销量，建议清理库存。'
        : '当前有库存且综合日销低于清理阈值，建议降价、清仓或停止采购。',
      metrics,
      riskTags,
    };
  }

  return {
    productClass: 'NORMAL',
    classificationName: PRODUCT_CLASS_NAMES.NORMAL,
    reason: '未命中主推、成长或清理规则，归为常规款。',
    metrics,
    riskTags,
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
      mainImage: true,
      imageUrl: true,
      estimatedProfit: true,
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
    metrics: Prisma.InputJsonValue;
    comprehensiveSales: number;
  }> = [];

  for (const p of products) {
    const sales = getSalesForProduct(salesMap, p.sku, p.vendorSku, p.pnk);
    const comprehensiveSales = calculateComprehensiveSales(sales, p.stock);
    const localProductId = productIdByPnk.get(p.pnk);
    const inTransitStock = localProductId ? inTransitByProductId.get(localProductId) ?? 0 : 0;
    const classified = classifyStoreProduct({
      stock: p.stock,
      inTransitStock,
      syncedAt: p.syncedAt,
      mappedInventorySku: p.mappedInventorySku,
      mainImage: p.mainImage,
      imageUrl: p.imageUrl,
      estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
    }, sales, now);

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
        metrics: { ...classified.metrics, riskTags: classified.riskTags } as Prisma.InputJsonValue,
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
        classificationMetrics: item.metrics,
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
