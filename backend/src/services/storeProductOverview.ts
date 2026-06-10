import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  calculateComprehensiveSales,
  calculateStockStatus,
  classifyStoreProduct,
  isProductClass,
  NEW_PRODUCT_STAGE_LABELS,
  PRODUCT_CLASSES,
  STOCK_STATUSES,
  type NewProductStage,
  type ProductClass,
  type ClassifyStoreProductResult,
  type ClassificationSalesStats,
  type StockStatus,
} from './productClassification';
import { resolveEffectiveStockSignals, scheduleStockSignalBackfill, type EffectiveStockSignals } from './firstAvailableAt';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';

export type PurchaseActionKey =
  | 'REPLENISH_NOW'
  | 'URGENT_REPLENISH'
  | 'STILL_NEED_REPLENISH'
  | 'WAIT_FOR_ARRIVAL'
  | 'CLEARANCE'
  | 'SAFE'
  | 'UNKNOWN';

export type StockGroupKey =
  | 'STOCK_OK'
  | 'REPLENISH_WARNING'
  | 'OUT_OF_STOCK_REPLENISHED'
  | 'OUT_OF_STOCK_NOT_REPLENISHED';

export const TARGET_STOCK_DAYS_BY_CLASS = {
  HOT: 90,
  POTENTIAL: 75,
  NORMAL: 70,
  CLEARANCE: 0,
  NEW: 30,
} as const;

export const TARGET_STOCK_DAYS_BY_STAGE = {
  NEW_WAITING_INBOUND: 0,
  NEW_OBSERVATION_NO_SALES: 0,
  NEW_OBSERVATION_TRIAL: 30,
  NEW_OBSERVATION_STABLE: 45,
  CLEARANCE_REVIVAL: 30,
} as const;

export type ReplenishmentStage = keyof typeof TARGET_STOCK_DAYS_BY_STAGE;

export type PurchaseSuggestion = {
  targetStock: number;
  targetStockDays: number;
  platformStock: number;
  platformInTransit: number;
  localStock: number;
  purchasingInTransit: number;
  planningStock: number;
  suggestAmount: number;
  coverageStock: number;
  platformStockDays: number | null;
  totalCoverageDays: number | null;
  replenishReferenceDailySales: number;
  inventoryTag: ProductClass;
  newProductStage: NewProductStage | null;
  newProductStageLabel: string | null;
  firstAvailableAt: string | null;
  firstStockSignalAt: string | null;
  firstInboundAt: string | null;
  replenishmentStage?: ReplenishmentStage;
  text?: string;
  label?: string;
  reason?: string;
};

type BuildPurchaseSuggestionInput = {
  productClass: ProductClass;
  newProductStage: NewProductStage | null;
  stockStatus: StockStatus;
  platformStock: number;
  platformInTransit: number;
  localStock: number;
  purchasingInTransit: number;
  planningStock: number;
  comprehensiveSales: number;
  sales7: number;
  sales14: number;
  sales30: number;
  sales60?: number;
  sales90?: number;
  sales180?: number;
  estimatedProfit?: number | null;
  firstAvailableAt?: Date | string | null;
  firstStockSignalAt?: Date | string | null;
  firstInboundAt?: Date | string | null;
  lastOrderAt?: Date | null;
  daysSinceSynced: number;
};

export type StoreProductOverview = {
  productStructure: { total: number } & Record<ProductClass, number>;
  stockRisk: Record<StockStatus, number>;
  purchaseActions: Record<PurchaseActionKey, number>;
  generatedAt: string;
};

const PRODUCT_STRUCTURE_KEYS = PRODUCT_CLASSES;
const STOCK_RISK_KEYS = STOCK_STATUSES;
export const STOCK_STATUS_FILTERS = STOCK_STATUSES;
export const STOCK_GROUP_FILTERS = [
  'STOCK_OK',
  'REPLENISH_WARNING',
  'OUT_OF_STOCK_REPLENISHED',
  'OUT_OF_STOCK_NOT_REPLENISHED',
] as const;
export const PURCHASE_ACTION_FILTERS = [
  'REPLENISH_NOW',
  'URGENT_REPLENISH',
  'STILL_NEED_REPLENISH',
  'WAIT_FOR_ARRIVAL',
  'CLEARANCE',
  'SAFE',
  'UNKNOWN',
] as const;

const PURCHASE_ACTION_KEYS: readonly PurchaseActionKey[] = PURCHASE_ACTION_FILTERS;

function normalizeSkuKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

function emptyRecord<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return keys.reduce((acc, key) => {
    acc[key as T[number]] = 0;
    return acc;
  }, {} as Record<T[number], number>);
}

function normalizeProductClass(value: string | null): ProductClass {
  return value && isProductClass(value) ? value : 'NORMAL';
}

function normalizeNullableDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type RealtimeClassifiableProduct = {
  id: number;
  pnk: string;
  sku: string | null;
  vendorSku: string | null;
  mappedInventorySku: string | null;
  stock: number;
  syncedAt?: Date;
  firstAvailableAt?: Date | null;
  firstStockSignalAt?: Date | null;
  firstInboundAt?: Date | null;
  mainImage?: string | null;
  imageUrl?: string | null;
  estimatedProfit?: unknown;
};

export type RealtimeProductClassification = {
  sales: ClassificationSalesStats;
  comprehensiveSales: number;
  classified: ClassifyStoreProductResult;
};

type StoreProductWhereInput = Prisma.StoreProductWhereInput;

export function classifyProductWithRealtimeSales(
  product: RealtimeClassifiableProduct,
  sales: ClassificationSalesStats,
  inTransitStock = 0,
  signals?: EffectiveStockSignals,
): RealtimeProductClassification {
  const comprehensiveSales = calculateComprehensiveSales(sales, product.stock);
  const resolvedSignals = signals ?? resolveEffectiveStockSignals(
    {
      id: product.id,
      stock: product.stock,
      inTransitStock,
      firstAvailableAt: product.firstAvailableAt ?? null,
      firstInboundAt: product.firstInboundAt ?? null,
      firstStockSignalAt: product.firstStockSignalAt ?? null,
    },
    sales,
  ).signals;
  const classified = classifyStoreProduct({
    stock: product.stock,
    inTransitStock,
    firstAvailableAt: resolvedSignals.firstAvailableAt,
    firstStockSignalAt: resolvedSignals.firstStockSignalAt,
    firstInboundAt: resolvedSignals.firstInboundAt,
    syncedAt: product.syncedAt,
    mappedInventorySku: product.mappedInventorySku,
    mainImage: product.mainImage,
    imageUrl: product.imageUrl,
    estimatedProfit: product.estimatedProfit != null ? Number(product.estimatedProfit) : null,
  }, sales);
  return { sales, comprehensiveSales, classified };
}

export async function buildRealtimeClassificationMap(
  shopId: number,
  products: RealtimeClassifiableProduct[],
  forceRefresh = false,
): Promise<Map<number, RealtimeProductClassification>> {
  const [salesStats, assets] = await Promise.all([
    getSalesStatsByShop(shopId, forceRefresh),
    buildLocalProductAssets(shopId, products),
  ]);
  const result = new Map<number, RealtimeProductClassification>();
  const patches = new Map<number, import('./firstAvailableAt').StockSignalDbPatch>();
  for (const product of products) {
    const sales = getSalesForProduct(salesStats.map, product.sku, product.vendorSku, product.pnk);
    const localProductId = assets.storeProductToProductId.get(product.id);
    const inTransitStock = localProductId ? assets.platformInTransitByProductId.get(localProductId) ?? 0 : 0;
    const { signals, pendingDbPatch } = resolveEffectiveStockSignals(
      {
        id: product.id,
        stock: product.stock,
        inTransitStock,
        firstAvailableAt: product.firstAvailableAt ?? null,
        firstInboundAt: product.firstInboundAt ?? null,
        firstStockSignalAt: product.firstStockSignalAt ?? null,
      },
      sales,
    );
    if (Object.keys(pendingDbPatch).length > 0) {
      patches.set(product.id, pendingDbPatch);
    }
    result.set(
      product.id,
      classifyProductWithRealtimeSales(product, sales, inTransitStock, signals),
    );
  }
  if (patches.size > 0) {
    scheduleStockSignalBackfill(patches);
  }
  return result;
}

export function isStockStatusFilter(value: string): value is StockStatus {
  return (STOCK_STATUS_FILTERS as readonly string[]).includes(value);
}

export function isStockGroupFilter(value: string): value is StockGroupKey {
  return (STOCK_GROUP_FILTERS as readonly string[]).includes(value);
}

export function isPurchaseActionFilter(value: string): value is PurchaseActionKey {
  return (PURCHASE_ACTION_FILTERS as readonly string[]).includes(value);
}

export function calculateReplenishReferenceDailySales(
  comprehensiveSales: number | null | undefined,
  sales30: number | null | undefined,
  sales90?: number | null,
  sales180?: number | null,
): number {
  const referenceDailySales = Math.max(
    Number(comprehensiveSales ?? 0),
    Number(sales30 ?? 0) / 30,
    Number(sales90 ?? 0) / 90,
    Number(sales180 ?? 0) / 180,
  );
  return parseFloat(referenceDailySales.toFixed(4));
}

function normalizeFirstAvailableAtIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveNewObservationReplenishmentStage(
  sales7: number,
  sales14: number,
  sales30: number,
): ReplenishmentStage {
  if (sales7 === 0 && sales14 === 0 && sales30 === 0) {
    return 'NEW_OBSERVATION_NO_SALES';
  }
  const daily7 = sales7 / 7;
  const daily14 = sales14 / 14;
  const daily30 = sales30 / 30;
  if (sales7 > 0 && sales14 > 0 && daily7 >= daily14 * 0.7 && (daily30 <= 0 || daily14 >= daily30 * 0.8)) {
    return 'NEW_OBSERVATION_STABLE';
  }
  return 'NEW_OBSERVATION_TRIAL';
}

function detectClearanceRevival(input: BuildPurchaseSuggestionInput): boolean {
  const { productClass, sales7, sales30, estimatedProfit } = input;
  if (productClass !== 'CLEARANCE') return false;
  if (sales7 <= 0) return false;
  const daily7 = sales7 / 7;
  const daily30 = sales30 / 30;
  if (daily30 > 0 && daily7 < daily30 * 2) return false;
  if (estimatedProfit != null && estimatedProfit <= 0) return false;
  return true;
}

function resolveTargetStockDays(input: BuildPurchaseSuggestionInput): {
  targetStockDays: number;
  replenishmentStage?: ReplenishmentStage;
} {
  const { productClass, newProductStage, sales7, sales14, sales30, comprehensiveSales, platformStock, estimatedProfit } = input;

  if (newProductStage === 'NEW_WAITING_INBOUND') {
    return { targetStockDays: TARGET_STOCK_DAYS_BY_STAGE.NEW_WAITING_INBOUND, replenishmentStage: 'NEW_WAITING_INBOUND' };
  }

  if (newProductStage === 'NEW_OBSERVATION') {
    const stage = resolveNewObservationReplenishmentStage(sales7, sales14, sales30);
    return { targetStockDays: TARGET_STOCK_DAYS_BY_STAGE[stage], replenishmentStage: stage };
  }

  if (productClass === 'CLEARANCE') {
    if (detectClearanceRevival(input)) {
      return { targetStockDays: TARGET_STOCK_DAYS_BY_STAGE.CLEARANCE_REVIVAL, replenishmentStage: 'CLEARANCE_REVIVAL' };
    }
    return { targetStockDays: TARGET_STOCK_DAYS_BY_CLASS.CLEARANCE };
  }

  return { targetStockDays: TARGET_STOCK_DAYS_BY_CLASS[productClass] };
}

export function buildPurchaseSuggestion(input: BuildPurchaseSuggestionInput): PurchaseSuggestion {
  const {
    productClass,
    newProductStage,
    stockStatus,
    platformStock,
    platformInTransit,
    localStock,
    purchasingInTransit,
    planningStock,
    comprehensiveSales,
    sales7,
    sales14,
    sales30,
    sales90,
    sales180,
    firstAvailableAt,
    firstStockSignalAt,
    firstInboundAt,
  } = input;

  const replenishReferenceDailySales = calculateReplenishReferenceDailySales(
    comprehensiveSales,
    sales30,
    sales90,
    sales180,
  );
  const { targetStockDays, replenishmentStage } = resolveTargetStockDays(input);
  const coverageStock = platformStock + platformInTransit + purchasingInTransit + planningStock;
  const targetStock = replenishReferenceDailySales > 0 && targetStockDays > 0
    ? Math.ceil(replenishReferenceDailySales * targetStockDays)
    : 0;
  const suggestAmount = targetStockDays <= 0
    ? 0
    : Math.max(0, targetStock - coverageStock);
  const platformStockDays = replenishReferenceDailySales > 0
    ? parseFloat((platformStock / replenishReferenceDailySales).toFixed(2))
    : null;
  const totalCoverageDays = replenishReferenceDailySales > 0
    ? parseFloat((coverageStock / replenishReferenceDailySales).toFixed(2))
    : null;
  const newProductStageLabel = newProductStage ? NEW_PRODUCT_STAGE_LABELS[newProductStage] : null;
  const firstAvailableAtIso = normalizeFirstAvailableAtIso(firstAvailableAt);
  const firstStockSignalAtIso = normalizeFirstAvailableAtIso(firstStockSignalAt);
  const firstInboundAtIso = normalizeFirstAvailableAtIso(firstInboundAt);

  const isNormalProduct = productClass === 'NORMAL';
  const isClearanceProduct = productClass === 'CLEARANCE';
  const isNewProduct = productClass === 'NEW';
  const isOutOfStockWithSales = platformStock === 0 && replenishReferenceDailySales > 0 && !isNewProduct;
  const isHotOrPotentialOutOfStock = (productClass === 'HOT' || productClass === 'POTENTIAL') && platformStock === 0;
  const isHotOrPotentialLowStockWarning =
    (productClass === 'HOT' || productClass === 'POTENTIAL') &&
    platformStock > 0 &&
    (stockStatus === 'LOW_STOCK' || stockStatus === 'WARNING');

  const inventoryTag: PurchaseSuggestion['inventoryTag'] = productClass;

  let text: string | undefined;
  let reason: string | undefined;

  if (newProductStage === 'NEW_WAITING_INBOUND') {
    text = '等待到货';
    reason = '新品待入仓，货物仍在路上，暂不判断销量，等待到货。';
  } else if (newProductStage === 'NEW_OBSERVATION') {
    if (suggestAmount > 0) {
      text = replenishmentStage === 'NEW_OBSERVATION_STABLE' ? '小批量试补' : '观察试补';
      reason = '新品观察期，当前处于首次入仓后 30 天内，先观察销量，不按清理款处理。';
    } else {
      text = '观察即可';
      reason = '新品观察期，当前处于首次入仓后 30 天内，先观察销量，不按清理款处理。';
    }
  } else if (replenishmentStage === 'CLEARANCE_REVIVAL') {
    text = suggestAmount > 0 ? '复活观察' : '观察即可';
    reason = '清理款近期销量回升，进入复活观察期，仅允许小批量试补。';
  } else if (isOutOfStockWithSales) {
    const pendingStock = platformInTransit + purchasingInTransit + planningStock;
    if (suggestAmount > 0 && coverageStock <= 0) {
      text = replenishReferenceDailySales >= 1 ? '立即补货' : '紧急补货';
      reason = replenishReferenceDailySales >= 1
        ? '当前平台库存为0，且历史/近期销量较好，当前无足够在途或计划库存，建议立即补货。'
        : '当前平台库存为0，但历史/近期仍有销量，建议优先安排补货，避免继续丢单。';
    } else if (suggestAmount > 0) {
      text = '仍需补货';
      reason = '当前平台库存为0，虽然已有部分库存保障，但按历史/近期销量测算仍不足，建议继续补货。';
    } else if (pendingStock > 0) {
      text = '等待到货';
      reason = '当前平台库存为0，但已有在途、采购中或计划库存覆盖目标库存，建议等待到货并观察销售恢复情况。';
    } else if (localStock > 0) {
      text = '仍需补货';
      reason = '当前平台库存为0，本地仓仍有库存，建议尽快安排补货或发往平台仓，避免继续丢单。';
    } else {
      text = '仍需补货';
      reason = '当前平台库存为0且历史/近期有销量，建议复核库存保障并安排补货。';
    }
  } else if (isClearanceProduct) {
    text = platformStock >= 10 || stockStatus === 'OVERSTOCK' ? '清仓处理' : '停止补货';
    reason = '清理款默认不补货，优先降低库存占用。';
  } else if (isNormalProduct) {
    if (stockStatus === 'LOW_STOCK') {
      text = '少量补货';
      reason = '普通款当前库存偏低，但销售强度不高，建议少量补货或结合人工判断。';
    } else if (stockStatus === 'WARNING') {
      text = '观察补货';
      reason = '普通款库存进入预警区间，建议观察近期销量后再决定是否补货。';
    } else if (stockStatus === 'SAFE') {
      text = '暂不补货';
      reason = '当前库存相对充足，暂不需要补货。';
    } else if (stockStatus === 'OVERSTOCK') {
      text = '暂停补货';
      reason = '普通款当前库存偏多，建议暂停补货，避免库存积压。';
    } else if (platformInTransit > 0) {
      text = '等待到货';
      reason = '普通款当前平台库存为0，但存在在途库存，建议等待到货后观察销售表现。';
    } else {
      text = '待确认补货';
      reason = '普通款当前平台库存为0且无在途库存，建议结合销量和采购计划人工确认是否补货。';
    }
  } else if (isHotOrPotentialOutOfStock) {
    if (platformInTransit <= 0) {
      text = '立即补货';
      reason = '当前平台库存为0，且无在途库存，热销或潜力产品建议立即补货。';
    } else if (replenishReferenceDailySales <= 0) {
      text = '等待到货';
      reason = '当前平台库存为0，但存在在途库存，建议等待到货后观察销售表现。';
    } else {
      const inTransitDays = platformInTransit / replenishReferenceDailySales;
      if (inTransitDays >= 30) {
        text = '等待到货';
        reason = `当前平台库存为0，但在途库存预计可覆盖约 ${inTransitDays.toFixed(1)} 天销量，建议关注到货进度，暂不重复采购。`;
      } else {
        text = '仍需补货';
        reason = '当前平台库存为0，且在途库存预计覆盖不足30天，建议继续补货。';
      }
    }
  } else if (isHotOrPotentialLowStockWarning) {
    if (productClass === 'HOT' && stockStatus === 'LOW_STOCK') {
      text = '紧急补货';
      reason = '热销产品当前库存可售天数较低，建议尽快补货，避免断货。';
    } else if (productClass === 'HOT' && stockStatus === 'WARNING') {
      text = '建议补货';
      reason = '热销产品库存已进入补货预警区间，建议提前安排补货。';
    } else if (productClass === 'POTENTIAL' && stockStatus === 'LOW_STOCK') {
      text = '小批量补货';
      reason = '潜力产品库存偏低，可小批量补货，继续观察销售表现。';
    } else {
      text = '观察备货';
      reason = '潜力产品库存进入预警区间，建议观察销量后决定是否补货。';
    }
  }

  return {
    targetStock,
    targetStockDays,
    platformStock,
    platformInTransit,
    localStock,
    purchasingInTransit,
    planningStock,
    suggestAmount,
    coverageStock,
    platformStockDays,
    totalCoverageDays,
    replenishReferenceDailySales,
    inventoryTag,
    newProductStage,
    newProductStageLabel,
    firstAvailableAt: firstAvailableAtIso,
    firstStockSignalAt: firstStockSignalAtIso,
    firstInboundAt: firstInboundAtIso,
    ...(replenishmentStage ? { replenishmentStage } : {}),
    ...(text ? { text, label: text } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function mapPurchaseAction(suggestion: PurchaseSuggestion): PurchaseActionKey {
  const text = suggestion.text ?? suggestion.label ?? '';
  if (text.includes('立即补货')) return 'REPLENISH_NOW';
  if (text.includes('紧急补货')) return 'URGENT_REPLENISH';
  if (
    text.includes('仍需补货') ||
    text.includes('建议补货') ||
    text.includes('小批量补货') ||
    text.includes('少量补货') ||
    text.includes('观察补货')
  ) {
    return 'STILL_NEED_REPLENISH';
  }
  if (text.includes('等待到货') || text.includes('待到货') || text.includes('观察即可')) return 'WAIT_FOR_ARRIVAL';
  if (text.includes('清仓')) return 'CLEARANCE';
  if (text.includes('复活观察') || text.includes('观察试补')) return 'STILL_NEED_REPLENISH';
  if (
    text.includes('暂不补货') ||
    text.includes('暂停补货') ||
    text.includes('停止补货') ||
    suggestion.suggestAmount <= 0
  ) {
    return 'SAFE';
  }
  return 'UNKNOWN';
}

async function buildLocalProductAssets(
  shopId: number,
  products: Array<{ id: number; pnk: string; mappedInventorySku: string | null; sku: string | null; vendorSku: string | null }>,
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
          select: { id: true, sku: true, pnk: true },
        })
      : Promise.resolve([]),
    pnks.size > 0
      ? prisma.product.findMany({
          where: { pnk: { in: [...pnks] }, isDeleted: false },
          select: { id: true, sku: true, pnk: true },
        })
      : Promise.resolve([]),
  ]);

  const skuToProductId = new Map(bySku.map((p) => [normalizeSkuKey(p.sku), p.id]));
  const pnkToProductId = new Map(byPnk.map((p) => [p.pnk!, p.id]));
  const storeProductToProductId = new Map<number, number>();
  const skuKeyByStoreProductId = new Map<number, string>();
  for (const p of products) {
    const skuKey = normalizeSkuKey((p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim());
    const productId = (skuKey ? skuToProductId.get(skuKey) : undefined) ?? pnkToProductId.get(p.pnk);
    if (productId) storeProductToProductId.set(p.id, productId);
    if (skuKey) skuKeyByStoreProductId.set(p.id, skuKey);
  }

  const productIds = [...new Set([...storeProductToProductId.values()])];
  const [warehouseStocks, fbeItems, purchaseItems, planningProducts] = await Promise.all([
    productIds.length > 0
      ? prisma.warehouseStock.findMany({
          where: { productId: { in: productIds } },
          select: { productId: true, stockQuantity: true },
        })
      : Promise.resolve([]),
    productIds.length > 0
      ? prisma.fbeShipmentItem.findMany({
          where: { productId: { in: productIds }, shipment: { shopId, status: 'SHIPPED' } },
          select: { productId: true, quantity: true },
        })
      : Promise.resolve([]),
    productIds.length > 0
      ? prisma.purchaseOrderItem.findMany({
          where: {
            purchaseOrder: {
              status: { in: ['PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL'] },
              OR: [{ shopId }, { shopId: null }],
            },
          },
          select: { productIds: true, quantity: true, receivedQuantity: true },
        })
      : Promise.resolve([]),
    skuKeys.size > 0
      ? prisma.product.findMany({
          where: {
            sku: { in: [...skuKeys] },
            status: 'PURCHASING',
            purchaseOrderId: null,
            OR: [{ shopId }, { shopId: null }],
          },
          select: { sku: true, purchaseQuantity: true },
        })
      : Promise.resolve([]),
  ]);

  const localStockByProductId = new Map<number, number>();
  for (const ws of warehouseStocks) {
    localStockByProductId.set(ws.productId, (localStockByProductId.get(ws.productId) ?? 0) + Number(ws.stockQuantity ?? 0));
  }

  const platformInTransitByProductId = new Map<number, number>();
  for (const item of fbeItems) {
    platformInTransitByProductId.set(item.productId, (platformInTransitByProductId.get(item.productId) ?? 0) + Number(item.quantity ?? 0));
  }

  const productIdSet = new Set(productIds);
  const purchasingInTransitByProductId = new Map<number, number>();
  for (const item of purchaseItems) {
    let ids: number[] = [];
    try {
      ids = JSON.parse(item.productIds ?? '[]')
        .map((id: unknown) => Number(id))
        .filter((id: number) => Number.isInteger(id) && productIdSet.has(id));
    } catch {
      ids = [];
    }
    if (ids.length === 0) continue;
    const remainingQty = Math.max(0, Number(item.quantity ?? 0) - Number(item.receivedQuantity ?? 0));
    if (remainingQty <= 0) continue;
    const qtyPerProduct = remainingQty / ids.length;
    for (const id of ids) {
      purchasingInTransitByProductId.set(id, (purchasingInTransitByProductId.get(id) ?? 0) + qtyPerProduct);
    }
  }

  const planningStockBySku = new Map<string, number>();
  for (const product of planningProducts) {
    const skuKey = normalizeSkuKey(product.sku);
    if (!skuKey) continue;
    planningStockBySku.set(skuKey, (planningStockBySku.get(skuKey) ?? 0) + Number(product.purchaseQuantity ?? 0));
  }

  return {
    storeProductToProductId,
    skuKeyByStoreProductId,
    localStockByProductId,
    platformInTransitByProductId,
    purchasingInTransitByProductId,
    planningStockBySku,
  };
}

export async function getProductStructureSummary(
  shopId: number,
  where: StoreProductWhereInput = { shopId, isArchived: false },
): Promise<StoreProductOverview['productStructure']> {
  const products = await prisma.storeProduct.findMany({
    where,
    select: {
      id: true,
      pnk: true,
      sku: true,
      vendorSku: true,
      mappedInventorySku: true,
      stock: true,
      syncedAt: true,
      firstAvailableAt: true,
      firstStockSignalAt: true,
      firstInboundAt: true,
      mainImage: true,
      imageUrl: true,
      estimatedProfit: true,
    },
    orderBy: { id: 'asc' },
  });
  const classificationMap = await buildRealtimeClassificationMap(shopId, products);
  const counts = emptyRecord(PRODUCT_STRUCTURE_KEYS) as Record<ProductClass, number>;
  for (const product of products) {
    const productClass = classificationMap.get(product.id)?.classified.productClass ?? 'NORMAL';
    counts[productClass]++;
  }
  const total = PRODUCT_STRUCTURE_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return { total, ...counts };
}

export async function getMatchedStoreProductIdsByProductClass(
  shopId: number,
  productClass: ProductClass,
  where: StoreProductWhereInput = { shopId, isArchived: false },
): Promise<number[]> {
  const products = await prisma.storeProduct.findMany({
    where,
    select: {
      id: true,
      pnk: true,
      sku: true,
      vendorSku: true,
      mappedInventorySku: true,
      stock: true,
      syncedAt: true,
      firstAvailableAt: true,
      firstStockSignalAt: true,
      firstInboundAt: true,
      mainImage: true,
      imageUrl: true,
      estimatedProfit: true,
    },
    orderBy: { id: 'asc' },
  });
  const classificationMap = await buildRealtimeClassificationMap(shopId, products);
  return products
    .filter((product) => classificationMap.get(product.id)?.classified.productClass === productClass)
    .map((product) => product.id);
}

export async function getMatchedStoreProductIdsByOverviewFilters(
  shopId: number,
  filters: { stockStatus?: StockStatus; stockGroup?: StockGroupKey; purchaseAction?: PurchaseActionKey },
  where: StoreProductWhereInput = { shopId, isArchived: false },
): Promise<number[]> {
  if (!filters.stockStatus && !filters.stockGroup && !filters.purchaseAction) {
    return [];
  }

  // 第一版暂不做缓存；后续可在这里按 shopId + filters 增加 1-5 分钟 TTL 缓存。
  const [salesStats, products] = await Promise.all([
    getSalesStatsByShop(shopId),
    prisma.storeProduct.findMany({
      where,
      select: {
        id: true,
        pnk: true,
        sku: true,
        vendorSku: true,
        mappedInventorySku: true,
        stock: true,
        productClass: true,
        syncedAt: true,
        firstAvailableAt: true,
        firstStockSignalAt: true,
        firstInboundAt: true,
        mainImage: true,
        imageUrl: true,
        estimatedProfit: true,
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  const needsStockGroupTransit =
    filters.stockGroup === 'OUT_OF_STOCK_REPLENISHED' ||
    filters.stockGroup === 'OUT_OF_STOCK_NOT_REPLENISHED';
  const assets = filters.purchaseAction || needsStockGroupTransit ? await buildLocalProductAssets(shopId, products) : null;
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const matchedIds: number[] = [];

  for (const product of products) {
    const sales = getSalesForProduct(salesStats.map, product.sku, product.vendorSku, product.pnk);
    const comprehensiveSales = calculateComprehensiveSales(sales, product.stock);
    const stockStatusResult = calculateStockStatus(product.stock, comprehensiveSales, sales.d30);
    if (filters.stockStatus && stockStatusResult.stockStatus !== filters.stockStatus) {
      continue;
    }

    if (filters.stockGroup === 'STOCK_OK' && stockStatusResult.stockStatus !== 'SAFE' && stockStatusResult.stockStatus !== 'OVERSTOCK') {
      continue;
    }

    if (filters.stockGroup === 'REPLENISH_WARNING' && stockStatusResult.stockStatus !== 'LOW_STOCK' && stockStatusResult.stockStatus !== 'WARNING') {
      continue;
    }

    if (filters.stockGroup === 'OUT_OF_STOCK_REPLENISHED' || filters.stockGroup === 'OUT_OF_STOCK_NOT_REPLENISHED') {
      if (!assets || product.stock > 0) continue;
      const localProductId = assets.storeProductToProductId.get(product.id);
      const platformInTransit = localProductId ? assets.platformInTransitByProductId.get(localProductId) ?? 0 : 0;
      if (filters.stockGroup === 'OUT_OF_STOCK_REPLENISHED' && platformInTransit <= 0) {
        continue;
      }
      if (filters.stockGroup === 'OUT_OF_STOCK_NOT_REPLENISHED' && platformInTransit > 0) {
        continue;
      }
    }

    if (filters.purchaseAction) {
      if (!assets) continue;
      const localProductId = assets.storeProductToProductId.get(product.id);
      const skuKey = assets.skuKeyByStoreProductId.get(product.id) ?? '';
      const platformInTransit = localProductId ? assets.platformInTransitByProductId.get(localProductId) ?? 0 : 0;
      const localStock = localProductId ? assets.localStockByProductId.get(localProductId) ?? 0 : 0;
      const purchasingInTransit = localProductId ? assets.purchasingInTransitByProductId.get(localProductId) ?? 0 : 0;
      const planningStock = skuKey ? assets.planningStockBySku.get(skuKey) ?? 0 : 0;
      const { signals } = resolveEffectiveStockSignals(
        {
          id: product.id,
          stock: product.stock,
          inTransitStock: platformInTransit,
          firstAvailableAt: product.firstAvailableAt ?? null,
          firstInboundAt: product.firstInboundAt ?? null,
          firstStockSignalAt: product.firstStockSignalAt ?? null,
        },
        sales,
      );
      const fallbackClassification = classifyStoreProduct({
        stock: product.stock,
        inTransitStock: platformInTransit,
        firstAvailableAt: signals.firstAvailableAt,
        firstStockSignalAt: signals.firstStockSignalAt,
        firstInboundAt: signals.firstInboundAt,
        syncedAt: product.syncedAt,
        mappedInventorySku: product.mappedInventorySku,
        mainImage: product.mainImage,
        imageUrl: product.imageUrl,
        estimatedProfit: product.estimatedProfit != null ? Number(product.estimatedProfit) : null,
      }, sales);
      const productClass = fallbackClassification.productClass;
      const daysSinceSynced = Math.max(0, Math.floor((nowMs - product.syncedAt.getTime()) / dayMs));
      const suggestion = buildPurchaseSuggestion({
        productClass,
        newProductStage: fallbackClassification.newProductStage,
        stockStatus: stockStatusResult.stockStatus,
        platformStock: product.stock,
        platformInTransit,
        localStock,
        purchasingInTransit,
        planningStock,
        comprehensiveSales,
        sales7: sales.d7,
        sales14: sales.d14,
        sales30: sales.d30,
        sales60: sales.d60,
        sales90: sales.d90,
        sales180: sales.d180,
        estimatedProfit: product.estimatedProfit != null ? Number(product.estimatedProfit) : null,
        firstAvailableAt: signals.firstAvailableAt,
        firstStockSignalAt: signals.firstStockSignalAt,
        firstInboundAt: signals.firstInboundAt,
        lastOrderAt: normalizeNullableDate(sales.lastOrderAt),
        daysSinceSynced,
      });
      if (mapPurchaseAction(suggestion) !== filters.purchaseAction) {
        continue;
      }
    }

    matchedIds.push(product.id);
  }

  return matchedIds;
}

export async function getStoreProductOverview(shopId: number): Promise<StoreProductOverview> {
  if (!Number.isInteger(shopId) || shopId <= 0) {
    throw new Error('shopId 必须是正整数');
  }

  // 第一版暂不做缓存；后续可在这里按 shopId 增加 1-5 分钟 TTL 缓存。
  const [salesStats, products] = await Promise.all([
    getSalesStatsByShop(shopId),
    prisma.storeProduct.findMany({
      where: { shopId, isArchived: false },
      select: {
        id: true,
        pnk: true,
        sku: true,
        vendorSku: true,
        mappedInventorySku: true,
        stock: true,
        productClass: true,
        syncedAt: true,
        firstAvailableAt: true,
        firstStockSignalAt: true,
        firstInboundAt: true,
        mainImage: true,
        imageUrl: true,
        estimatedProfit: true,
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  const classificationMap = await buildRealtimeClassificationMap(shopId, products);
  const productStructure = emptyRecord(PRODUCT_STRUCTURE_KEYS) as StoreProductOverview['productStructure'];
  productStructure.total = products.length;
  for (const product of products) {
    const productClass = classificationMap.get(product.id)?.classified.productClass ?? 'NORMAL';
    productStructure[productClass]++;
  }

  const assets = await buildLocalProductAssets(shopId, products);
  const stockRisk = emptyRecord(STOCK_RISK_KEYS);
  const purchaseActions = emptyRecord(PURCHASE_ACTION_KEYS);
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const product of products) {
    const sales = getSalesForProduct(salesStats.map, product.sku, product.vendorSku, product.pnk);
    const comprehensiveSales = classificationMap.get(product.id)?.comprehensiveSales ?? calculateComprehensiveSales(sales, product.stock);
    const stockStatusResult = calculateStockStatus(product.stock, comprehensiveSales, sales.d30);
    stockRisk[stockStatusResult.stockStatus]++;

    const localProductId = assets.storeProductToProductId.get(product.id);
    const skuKey = assets.skuKeyByStoreProductId.get(product.id) ?? '';
    const platformInTransit = localProductId ? assets.platformInTransitByProductId.get(localProductId) ?? 0 : 0;
    const localStock = localProductId ? assets.localStockByProductId.get(localProductId) ?? 0 : 0;
    const purchasingInTransit = localProductId ? assets.purchasingInTransitByProductId.get(localProductId) ?? 0 : 0;
    const planningStock = skuKey ? assets.planningStockBySku.get(skuKey) ?? 0 : 0;
    const classified = classificationMap.get(product.id)?.classified;
    const productClass = classified?.productClass ?? normalizeProductClass(product.productClass);
    const daysSinceSynced = Math.max(0, Math.floor((nowMs - product.syncedAt.getTime()) / dayMs));

    const suggestion = buildPurchaseSuggestion({
      productClass,
      newProductStage: classified?.newProductStage ?? null,
      stockStatus: stockStatusResult.stockStatus,
      platformStock: product.stock,
      platformInTransit,
      localStock,
      purchasingInTransit,
      planningStock,
      comprehensiveSales,
      sales7: sales.d7,
      sales14: sales.d14,
      sales30: sales.d30,
      sales60: sales.d60,
      sales90: sales.d90,
      sales180: sales.d180,
      estimatedProfit: product.estimatedProfit != null ? Number(product.estimatedProfit) : null,
      firstAvailableAt: classified?.metrics.firstAvailableAt ? new Date(classified.metrics.firstAvailableAt) : product.firstAvailableAt,
      firstStockSignalAt: product.firstStockSignalAt,
      firstInboundAt: product.firstInboundAt,
      lastOrderAt: normalizeNullableDate(sales.lastOrderAt),
      daysSinceSynced,
    });
    purchaseActions[mapPurchaseAction(suggestion)]++;
  }

  return {
    productStructure,
    stockRisk,
    purchaseActions,
    generatedAt: new Date().toISOString(),
  };
}


