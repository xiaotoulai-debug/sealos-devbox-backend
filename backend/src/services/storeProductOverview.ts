import { prisma } from '../lib/prisma';
import {
  calculateComprehensiveSales,
  calculateStockStatus,
  isProductClass,
  PRODUCT_CLASSES,
  STOCK_STATUSES,
  type ProductClass,
  type StockStatus,
} from './productClassification';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';

export type PurchaseActionKey =
  | 'REPLENISH_NOW'
  | 'URGENT_REPLENISH'
  | 'STILL_NEED_REPLENISH'
  | 'WAIT_FOR_ARRIVAL'
  | 'CLEARANCE'
  | 'SAFE'
  | 'UNKNOWN';

export type PurchaseSuggestion = {
  targetStock: number;
  platformStock: number;
  platformInTransit: number;
  localStock: number;
  purchasingInTransit: number;
  planningStock: number;
  suggestAmount: number;
  inventoryTag: 'NEW' | 'DEAD' | 'HOT' | 'POTENTIAL' | 'NORMAL' | 'TO_BE_ELIMINATED';
  text?: string;
  label?: string;
  reason?: string;
};

type BuildPurchaseSuggestionInput = {
  productClass: ProductClass;
  stockStatus: StockStatus;
  platformStock: number;
  platformInTransit: number;
  localStock: number;
  purchasingInTransit: number;
  planningStock: number;
  comprehensiveSales: number;
  sales30: number;
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
const PURCHASE_ACTION_KEYS: PurchaseActionKey[] = [
  'REPLENISH_NOW',
  'URGENT_REPLENISH',
  'STILL_NEED_REPLENISH',
  'WAIT_FOR_ARRIVAL',
  'CLEARANCE',
  'SAFE',
  'UNKNOWN',
];

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

export function buildPurchaseSuggestion(input: BuildPurchaseSuggestionInput): PurchaseSuggestion {
  const {
    productClass,
    stockStatus,
    platformStock,
    platformInTransit,
    localStock,
    purchasingInTransit,
    planningStock,
    comprehensiveSales,
    sales30,
    daysSinceSynced,
  } = input;

  const targetStock = Math.floor(comprehensiveSales * 60);
  const suggestAmount = Math.max(
    0,
    targetStock - platformStock - platformInTransit - localStock - purchasingInTransit - planningStock,
  );

  const isToBeEliminated = productClass === 'TO_BE_ELIMINATED';
  const isNewProduct = productClass === 'NEW';
  const isDeadProduct = productClass === 'DEAD';
  const isNormalProduct = productClass === 'NORMAL';
  const isHotOrPotentialOutOfStock = (productClass === 'HOT' || productClass === 'POTENTIAL') && platformStock === 0;
  const isHotOrPotentialLowStockWarning =
    (productClass === 'HOT' || productClass === 'POTENTIAL') &&
    platformStock > 0 &&
    (stockStatus === 'LOW_STOCK' || stockStatus === 'WARNING');

  let inventoryTag: PurchaseSuggestion['inventoryTag'];
  if (isToBeEliminated) inventoryTag = 'TO_BE_ELIMINATED';
  else if (isNewProduct) inventoryTag = 'NEW';
  else if (isDeadProduct) inventoryTag = 'DEAD';
  else if (isNormalProduct) inventoryTag = 'NORMAL';
  else if (isHotOrPotentialOutOfStock || isHotOrPotentialLowStockWarning) inventoryTag = productClass;
  else if (daysSinceSynced <= 30) inventoryTag = 'NEW';
  else if (comprehensiveSales === 0 && platformStock + localStock > 0) inventoryTag = 'DEAD';
  else if (comprehensiveSales > 0) {
    const turnoverDays = (platformStock + localStock) / comprehensiveSales;
    inventoryTag = turnoverDays < 15 ? 'HOT' : 'NORMAL';
  } else {
    inventoryTag = 'NORMAL';
  }

  let text: string | undefined;
  let reason: string | undefined;
  if (isToBeEliminated) {
    text = '暂停补货';
    reason = '近30天无销量，且当前无平台库存、无在途库存，建议人工确认是否继续采购或下架。';
  } else if (isNewProduct) {
    if (platformStock === 0 && platformInTransit > 0) {
      text = '新品待到货';
      reason = '新品当前平台库存为0，但存在在途库存，建议等待到货后观察销售表现。';
    } else if (platformStock > 0) {
      text = '新品观察';
      reason = '新品已有平台库存，但暂无销量，建议观察销售表现后再决定是否补货。';
    } else {
      text = '待采购确认';
      reason = '新品暂无平台库存且无在途库存，建议确认是否需要采购或继续上架。';
    }
  } else if (isDeadProduct) {
    if (platformStock >= 10) {
      text = '清仓处理';
      reason = '滞销产品近30天暂无销量，且当前仍有较多平台库存，建议降价清仓，避免继续占用库存。';
    } else if (platformStock > 0) {
      text = '停止补货';
      reason = '滞销产品近30天暂无销量，建议停止补货，观察是否自然售出。';
    } else {
      text = '停止补货';
      reason = '滞销产品暂无平台库存，建议不再补货，除非人工确认重新开发。';
    }
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
    const referenceDailySales = Math.max(comprehensiveSales, sales30 / 30);
    if (platformInTransit <= 0) {
      text = '立即补货';
      reason = '当前平台库存为0，且无在途库存，热销或潜力产品建议立即补货。';
    } else if (referenceDailySales <= 0) {
      text = '等待到货';
      reason = '当前平台库存为0，但存在在途库存，建议等待到货后观察销售表现。';
    } else {
      const inTransitDays = platformInTransit / referenceDailySales;
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
    platformStock,
    platformInTransit,
    localStock,
    purchasingInTransit,
    planningStock,
    suggestAmount,
    inventoryTag,
    ...(text ? { text, label: text } : {}),
    ...(reason ? { reason } : {}),
  };
}

function mapPurchaseAction(suggestion: PurchaseSuggestion): PurchaseActionKey {
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
  if (text.includes('等待到货') || text.includes('待到货')) return 'WAIT_FOR_ARRIVAL';
  if (text.includes('清仓')) return 'CLEARANCE';
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

export async function getProductStructureSummary(shopId: number): Promise<StoreProductOverview['productStructure']> {
  const grouped = await prisma.storeProduct.groupBy({
    by: ['productClass'],
    where: { shopId, isArchived: false },
    _count: { _all: true },
  });

  const counts = emptyRecord(PRODUCT_STRUCTURE_KEYS) as Record<ProductClass, number>;
  for (const row of grouped) {
    counts[normalizeProductClass(row.productClass)] += row._count._all;
  }
  const total = PRODUCT_STRUCTURE_KEYS.reduce((sum, key) => sum + counts[key], 0);
  return { total, ...counts };
}

export async function getStoreProductOverview(shopId: number): Promise<StoreProductOverview> {
  if (!Number.isInteger(shopId) || shopId <= 0) {
    throw new Error('shopId 必须是正整数');
  }

  // 第一版暂不做缓存；后续可在这里按 shopId 增加 1-5 分钟 TTL 缓存。
  const [productStructure, salesStats, products] = await Promise.all([
    getProductStructureSummary(shopId),
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
      },
      orderBy: { id: 'asc' },
    }),
  ]);

  const assets = await buildLocalProductAssets(shopId, products);
  const stockRisk = emptyRecord(STOCK_RISK_KEYS);
  const purchaseActions = emptyRecord(PURCHASE_ACTION_KEYS);
  const nowMs = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (const product of products) {
    const sales = getSalesForProduct(salesStats.map, product.sku, product.vendorSku);
    const comprehensiveSales = calculateComprehensiveSales(sales.d7, sales.d14, sales.d30);
    const stockStatusResult = calculateStockStatus(product.stock, comprehensiveSales, sales.d30);
    stockRisk[stockStatusResult.stockStatus]++;

    const localProductId = assets.storeProductToProductId.get(product.id);
    const skuKey = assets.skuKeyByStoreProductId.get(product.id) ?? '';
    const platformInTransit = localProductId ? assets.platformInTransitByProductId.get(localProductId) ?? 0 : 0;
    const localStock = localProductId ? assets.localStockByProductId.get(localProductId) ?? 0 : 0;
    const purchasingInTransit = localProductId ? assets.purchasingInTransitByProductId.get(localProductId) ?? 0 : 0;
    const planningStock = skuKey ? assets.planningStockBySku.get(skuKey) ?? 0 : 0;
    const productClass = normalizeProductClass(product.productClass);
    const daysSinceSynced = Math.max(0, Math.floor((nowMs - product.syncedAt.getTime()) / dayMs));

    const suggestion = buildPurchaseSuggestion({
      productClass,
      stockStatus: stockStatusResult.stockStatus,
      platformStock: product.stock,
      platformInTransit,
      localStock,
      purchasingInTransit,
      planningStock,
      comprehensiveSales,
      sales30: sales.d30,
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


