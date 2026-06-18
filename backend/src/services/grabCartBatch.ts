import { randomUUID } from 'crypto';
import { prisma } from '../lib/prisma';
import { DEFAULT_PRICE_STRATEGY } from './priceProtection';
import {
  buildGrabCartPreview,
  executeGrabCartPriceChange,
  type GrabCartPreviewResult,
  type PriceExecuteResult,
} from './emagPrice';
import { PRICE_ERROR_CODES } from './priceErrors';

export const GRAB_CART_BATCH_MAX_ITEMS = 5;
export const GRAB_CART_CANDIDATES_MAX_PAGE_SIZE = 100;
export const GRAB_CART_CANDIDATES_SCAN_LIMIT = 100;

export type GrabCartCandidateRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type GrabCartCandidateItem = {
  storeProductId: number;
  sku: string;
  pnk: string;
  emagOfferId: string | null;
  productName: string | null;
  currentSalePriceExVat: number | null;
  cartPriceExVat: number | null;
  suggestedGrabPriceExVat: number | null;
  finalMinPrice: number | null;
  estimatedProfitAfter: number | null;
  profitMarginPctAfter: number | null;
  stock: number | null;
  buyButtonRank: number | null;
  buyBoxStatus: string | null;
  costStatus: GrabCartPreviewResult['costStatus'];
  costWarnings: string[];
  isEstimatedFbe: boolean;
  canGrab: boolean;
  code: string;
  riskLevel: GrabCartCandidateRiskLevel;
  selectable: boolean;
  unselectableReason: string | null;
  lastPriceAdjustedAt: string | null;
  lastPriceAdjustmentMode: string | null;
};

export type ListGrabCartCandidatesResult = {
  shopId: number;
  page: number;
  pageSize: number;
  total: number;
  scannedCount: number;
  scanLimit: number;
  items: GrabCartCandidateItem[];
};

export type GrabCartBatchExecuteItemInput = {
  storeProductId: number;
  confirmedPriceExVat: number;
};

export type GrabCartBatchItemResult = {
  storeProductId: number;
  sku: string | null;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'BLOCKED' | 'PENDING_VERIFY';
  code: string;
  message: string;
  oldSalePriceExVat: number | null;
  newSalePriceExVat: number | null;
  logId: number | null;
  readBackStatus: string | null;
  readBackPrice: number | null;
  readBackWarning: string | null;
  noEmagWriteExecuted: boolean;
  writeGuardReasonCode: string | null;
};

export type GrabCartBatchExecuteResult = {
  batchId: string;
  shopId: number;
  mode: 'GRAB_CART_MANUAL';
  total: number;
  success: number;
  failed: number;
  skipped: number;
  blocked: number;
  pendingConfirm: number;
  items: GrabCartBatchItemResult[];
};

export type GrabCartReadinessBlockerCode =
  | 'NOT_RESELL'
  | 'NO_STOCK'
  | 'OUT_OF_STOCK'
  | 'ALREADY_WON'
  | 'MISSING_PRODUCT_MAPPING'
  | 'MISSING_FBE_FEE'
  | 'MISSING_LOGISTICS'
  | 'MISSING_COMMISSION'
  | 'CART_PRICE_TAX_MODE_UNKNOWN'
  | 'MISSING_COST'
  | 'OFFER_NOT_SELLABLE'
  | 'BELOW_FINAL_MIN_PRICE'
  | 'OTHER';

export type GrabCartReadinessBlocker = {
  code: GrabCartReadinessBlockerCode;
  count: number;
  message: string;
};

export type GrabCartReadinessResult = {
  shopId: number;
  summary: {
    totalStoreProducts: number;
    resellCount: number;
    resellWithStockCount: number;
    hasOfferPnkSkuCount: number;
    notWonCount: number;
    mappedProductCount: number;
    fbeFeeReadyCount: number;
    realFbeReadyCount: number;
    estimatedFbeCount: number;
    fbeMissingButFallbackCount: number;
    logisticsReadyCount: number;
    commissionReadyCount: number;
    cartPriceTaxModeReady: boolean;
    cartPriceTaxMode: string;
    previewOkCount: number;
    candidateCount: number;
    scannedCount: number;
    scanLimit: number;
  };
  displaySummary: {
    resellCount: number;
    inStockResellCount: number;
    dataReadyCount: number;
    candidateReadyCount: number;
  };
  blockers: GrabCartReadinessBlocker[];
  topBlockers: GrabCartReadinessBlocker[];
  nextActions: Array<{
    action: string;
    description: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
  legacyNextActions: string[];
  autoIntegration: {
    codeLayerAutoSupported: boolean;
    dataReady: boolean;
    configReady: boolean;
    candidateReady: boolean;
    message: string;
  };
};

const READINESS_BLOCKER_MESSAGES: Record<GrabCartReadinessBlockerCode, string> = {
  NOT_RESELL: '不是 RESELL 跟卖产品',
  NO_STOCK: 'RESELL 产品库存为 0',
  OUT_OF_STOCK: 'RESELL 产品库存为 0',
  ALREADY_WON: '已获得购物车，无需抢车',
  MISSING_PRODUCT_MAPPING: '未绑定库存 Product',
  MISSING_FBE_FEE: 'Product.fbeFee 未维护',
  MISSING_LOGISTICS: 'Product 尺寸或重量不完整',
  MISSING_COMMISSION: 'StoreProduct.commissionRate 未同步',
  CART_PRICE_TAX_MODE_UNKNOWN: 'StorePriceStrategyConfig.cartPriceTaxMode 未配置',
  MISSING_COST: 'Product.purchasePrice 未维护',
  OFFER_NOT_SELLABLE: 'eMAG offer 当前不可售',
  BELOW_FINAL_MIN_PRICE: '建议抢车价低于最终保护价',
  OTHER: '其他 preview 阻塞原因',
};

export function normalizeGrabCartBatchReason(reason: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof reason !== 'string') {
    return { ok: false, message: '执行原因必填' };
  }
  const trimmed = reason.trim();
  if (trimmed.length < 10 || trimmed.length > 500) {
    return { ok: false, message: '执行原因必填，长度需在 10-500 字之间' };
  }
  return { ok: true, value: trimmed };
}

function computeRiskLevel(
  currentPrice: number | null,
  suggestedPrice: number | null,
): GrabCartCandidateRiskLevel {
  if (currentPrice == null || suggestedPrice == null || currentPrice <= 0) return 'MEDIUM';
  const changePct = ((suggestedPrice - currentPrice) / currentPrice) * 100;
  if (changePct <= -15) return 'HIGH';
  if (changePct <= -5) return 'MEDIUM';
  return 'LOW';
}

function mapExecuteToBatchItem(
  sku: string | null,
  result: PriceExecuteResult,
): GrabCartBatchItemResult {
  let status: GrabCartBatchItemResult['status'];
  switch (result.status) {
    case 'SUCCESS':
      status = 'SUCCESS';
      break;
    case 'BLOCKED':
      status = 'BLOCKED';
      break;
    case 'FAILED':
      status = 'FAILED';
      break;
    case 'PENDING_VERIFY':
      status = 'PENDING_VERIFY';
      break;
    case 'DRY_RUN_ONLY':
    case 'SKIPPED':
    default:
      status = 'SKIPPED';
      break;
  }

  return {
    storeProductId: result.storeProductId,
    sku,
    status,
    code: result.code,
    message: result.message,
    oldSalePriceExVat: result.oldSalePriceExVat ?? null,
    newSalePriceExVat: result.newSalePriceExVat ?? null,
    logId: result.logId ?? null,
    readBackStatus: result.readBackStatus ?? null,
    readBackPrice: result.readBackPrice ?? null,
    readBackWarning: result.readBackWarning ?? null,
    noEmagWriteExecuted: result.noEmagWriteExecuted,
    writeGuardReasonCode: result.writeGuardReasonCode ?? null,
  };
}

function isQualifiedGrabCartPreview(
  preview: GrabCartPreviewResult,
  targetMinMarginPct: number,
): boolean {
  const elig = preview.grabCartEligibility;
  if (!elig.canGrab || elig.code !== 'OK') return false;
  if (preview.costStatus !== 'COMPLETE' && preview.costStatus !== 'ESTIMATED') return false;
  if (preview.suggestedGrabPriceExVat == null || preview.finalMinPrice == null) return false;
  if (preview.suggestedGrabPriceExVat < preview.finalMinPrice) return false;
  if (preview.profitMarginPctAfter == null || preview.profitMarginPctAfter < targetMinMarginPct * 100) return false;
  return true;
}

function isDisplayableEstimatedGrabCartPreview(
  preview: GrabCartPreviewResult,
  targetMinMarginPct: number,
): boolean {
  if (preview.costStatus !== 'ESTIMATED') return false;
  if (preview.suggestedGrabPriceExVat == null || preview.finalMinPrice == null) return false;
  if (preview.suggestedGrabPriceExVat < preview.finalMinPrice) return false;
  if (preview.profitMarginPctAfter == null || preview.profitMarginPctAfter < targetMinMarginPct * 100) return false;
  return true;
}

function isEstimatedFbePreview(preview: GrabCartPreviewResult): boolean {
  return preview.costWarnings.some((warning) => warning.includes('FBE 费用使用') && warning.includes('默认估算'));
}

function isCompleteLogisticsProduct(product: {
  length: unknown;
  width: unknown;
  height: unknown;
  actualWeight: unknown;
} | undefined): boolean {
  return Number(product?.length) > 0
    && Number(product?.width) > 0
    && Number(product?.height) > 0
    && Number(product?.actualWeight) > 0;
}

function toReadinessBlockers(counts: Record<GrabCartReadinessBlockerCode, number>): GrabCartReadinessBlocker[] {
  return (Object.keys(READINESS_BLOCKER_MESSAGES) as GrabCartReadinessBlockerCode[])
    .map((code) => ({
      code,
      count: counts[code] ?? 0,
      message: READINESS_BLOCKER_MESSAGES[code],
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

function mapPreviewCodeToReadinessBlocker(code: string): GrabCartReadinessBlockerCode | null {
  if (code === PRICE_ERROR_CODES.OFFER_NOT_SELLABLE) return 'OFFER_NOT_SELLABLE';
  if (code === PRICE_ERROR_CODES.BELOW_FINAL_MIN_PRICE) return 'BELOW_FINAL_MIN_PRICE';
  if (code === PRICE_ERROR_CODES.CART_PRICE_TAX_MODE_UNKNOWN) return 'CART_PRICE_TAX_MODE_UNKNOWN';
  if (code === PRICE_ERROR_CODES.ALREADY_WON) return 'ALREADY_WON';
  if (code === PRICE_ERROR_CODES.OUT_OF_STOCK) return 'OUT_OF_STOCK';
  if (code === PRICE_ERROR_CODES.LINK_TYPE_NOT_ALLOWED) return 'NOT_RESELL';
  if (code === PRICE_ERROR_CODES.MISSING_LOGISTICS) return 'MISSING_LOGISTICS';
  if (code === PRICE_ERROR_CODES.MISSING_COMMISSION) return 'MISSING_COMMISSION';
  if (code === PRICE_ERROR_CODES.MISSING_COST) return 'MISSING_COST';
  if (code === 'OK') return null;
  return 'OTHER';
}

function toReadinessAction(
  action: string,
  description: string,
  priority: 'HIGH' | 'MEDIUM' | 'LOW',
): GrabCartReadinessResult['nextActions'][number] {
  return { action, description, priority };
}

function buildCandidateFromPreview(
  row: {
    id: number;
    sku: string | null;
    pnk: string;
    name: string | null;
    emagOfferId: string | null;
    stock: number | null;
    buyButtonRank: number | null;
    buyBoxStatus: string | null;
    lastPriceAdjustedAt: Date | null;
    lastPriceAdjustmentMode: string | null;
  },
  preview: GrabCartPreviewResult,
  qualified: boolean,
): GrabCartCandidateItem {
  const elig = preview.grabCartEligibility;
  return {
    storeProductId: row.id,
    sku: row.sku ?? '',
    pnk: row.pnk,
    emagOfferId: row.emagOfferId,
    productName: row.name,
    currentSalePriceExVat: preview.currentSalePriceExVat,
    cartPriceExVat: preview.cartPriceExVat,
    suggestedGrabPriceExVat: preview.suggestedGrabPriceExVat,
    finalMinPrice: preview.finalMinPrice,
    estimatedProfitAfter: preview.estimatedProfitAfter,
    profitMarginPctAfter: preview.profitMarginPctAfter,
    stock: row.stock,
    buyButtonRank: row.buyButtonRank,
    buyBoxStatus: row.buyBoxStatus,
    costStatus: preview.costStatus,
    costWarnings: preview.costWarnings,
    isEstimatedFbe: isEstimatedFbePreview(preview),
    canGrab: elig.canGrab,
    code: elig.code,
    riskLevel: computeRiskLevel(preview.currentSalePriceExVat, preview.suggestedGrabPriceExVat),
    selectable: qualified,
    unselectableReason: qualified ? null : elig.message,
    lastPriceAdjustedAt: row.lastPriceAdjustedAt?.toISOString() ?? null,
    lastPriceAdjustmentMode: row.lastPriceAdjustmentMode,
  };
}

export async function buildGrabCartReadiness(params: { shopId: number; includePreview?: boolean }): Promise<GrabCartReadinessResult> {
  const baseWhere = { shopId: params.shopId, isArchived: false };
  const resellWhere = { ...baseWhere, emagLinkType: 'RESELL' };
  const resellWithStockWhere = { ...resellWhere, stock: { gt: 0 } };
  const hasOfferPnkSkuWhere = {
    ...resellWithStockWhere,
    emagOfferId: { not: null },
    pnk: { not: '' },
    sku: { not: '' },
  };
  const notWonWhere = {
    ...hasOfferPnkSkuWhere,
    AND: [
      { OR: [{ buyBoxStatus: null }, { buyBoxStatus: { not: 'WON' } }] },
      { OR: [{ buyButtonRank: null }, { buyButtonRank: { not: 1 } }] },
    ],
  };

  const [
    totalStoreProducts,
    resellCount,
    resellWithStockCount,
    hasOfferPnkSkuCount,
    notWonCount,
    strategyConfig,
    notWonRows,
  ] = await Promise.all([
    prisma.storeProduct.count({ where: baseWhere }),
    prisma.storeProduct.count({ where: resellWhere }),
    prisma.storeProduct.count({ where: resellWithStockWhere }),
    prisma.storeProduct.count({ where: hasOfferPnkSkuWhere }),
    prisma.storeProduct.count({ where: notWonWhere }),
    prisma.storePriceStrategyConfig.findUnique({
      where: { shopId: params.shopId },
      select: { cartPriceTaxMode: true },
    }),
    prisma.storeProduct.findMany({
      where: notWonWhere,
      select: {
        id: true,
        mappedInventorySku: true,
        commissionRate: true,
      },
      orderBy: { id: 'asc' },
      take: GRAB_CART_CANDIDATES_SCAN_LIMIT,
    }),
  ]);

  const mappedSkus = [...new Set(notWonRows.map((row) => row.mappedInventorySku).filter(Boolean))] as string[];
  const products = mappedSkus.length > 0
    ? await prisma.product.findMany({
        where: { sku: { in: mappedSkus } },
        select: { sku: true, purchasePrice: true, fbeFee: true, length: true, width: true, height: true, actualWeight: true },
      })
    : [];
  const productBySku = new Map(products.map((product) => [product.sku, product]));

  const mappedProductCount = notWonRows.filter((row) => row.mappedInventorySku && productBySku.has(row.mappedInventorySku)).length;
  const fbeFeeReadyCount = notWonRows.filter((row) => {
    const product = row.mappedInventorySku ? productBySku.get(row.mappedInventorySku) : undefined;
    return product?.fbeFee != null;
  }).length;
  const realFbeReadyCount = fbeFeeReadyCount;
  const fbeMissingButFallbackCount = notWonRows.filter((row) => {
    const product = row.mappedInventorySku ? productBySku.get(row.mappedInventorySku) : undefined;
    return product != null && product.fbeFee == null;
  }).length;
  const estimatedFbeCount = fbeMissingButFallbackCount;
  const logisticsReadyCount = notWonRows.filter((row) => {
    const product = row.mappedInventorySku ? productBySku.get(row.mappedInventorySku) : undefined;
    return product != null && isCompleteLogisticsProduct(product);
  }).length;
  const commissionReadyCount = notWonRows.filter((row) => row.commissionRate != null).length;
  const costReadyCount = notWonRows.filter((row) => {
    const product = row.mappedInventorySku ? productBySku.get(row.mappedInventorySku) : undefined;
    return product?.purchasePrice != null;
  }).length;
  const dataReadyCount = notWonRows.filter((row) => {
    const product = row.mappedInventorySku ? productBySku.get(row.mappedInventorySku) : undefined;
    return product != null
      && product.purchasePrice != null
      && isCompleteLogisticsProduct(product)
      && row.commissionRate != null;
  }).length;
  const cartPriceTaxMode = strategyConfig?.cartPriceTaxMode ?? DEFAULT_PRICE_STRATEGY.cartPriceTaxMode;
  const cartPriceTaxModeReady = cartPriceTaxMode !== 'UNKNOWN';

  const blockerCounts: Record<GrabCartReadinessBlockerCode, number> = {
    NOT_RESELL: Math.max(totalStoreProducts - resellCount, 0),
    NO_STOCK: 0,
    OUT_OF_STOCK: Math.max(resellCount - resellWithStockCount, 0),
    ALREADY_WON: Math.max(hasOfferPnkSkuCount - notWonCount, 0),
    MISSING_PRODUCT_MAPPING: Math.max(notWonRows.length - mappedProductCount, 0),
    MISSING_FBE_FEE: 0,
    MISSING_LOGISTICS: Math.max(mappedProductCount - logisticsReadyCount, 0),
    MISSING_COMMISSION: Math.max(notWonRows.length - commissionReadyCount, 0),
    CART_PRICE_TAX_MODE_UNKNOWN: cartPriceTaxModeReady ? 0 : notWonRows.length,
    MISSING_COST: Math.max(mappedProductCount - costReadyCount, 0),
    OFFER_NOT_SELLABLE: 0,
    BELOW_FINAL_MIN_PRICE: 0,
    OTHER: 0,
  };

  let previewOkCount = 0;
  let candidateCount = cartPriceTaxModeReady ? dataReadyCount : 0;
  let scannedCount = notWonRows.length;

  if (params.includePreview === true) {
    for (const row of notWonRows) {
      try {
        const preview = await buildGrabCartPreview({ shopId: params.shopId, storeProductId: row.id });
        const code = preview.grabCartEligibility.code;
        if (preview.grabCartEligibility.canGrab && code === 'OK' && (preview.costStatus === 'COMPLETE' || preview.costStatus === 'ESTIMATED')) {
          previewOkCount += 1;
          continue;
        }
        const blockerCode = mapPreviewCodeToReadinessBlocker(code);
        if (blockerCode) blockerCounts[blockerCode] += 1;
      } catch (err) {
        blockerCounts.OTHER += 1;
        console.error(`[buildGrabCartReadiness] preview failed storeProductId=${row.id}:`, err instanceof Error ? err.message : err);
      }
    }

    const candidates = await listGrabCartCandidates({ shopId: params.shopId, page: 1, pageSize: GRAB_CART_CANDIDATES_MAX_PAGE_SIZE });
    candidateCount = candidates.total;
    scannedCount = candidates.scannedCount;
  }
  const dataReady = resellWithStockCount > 0
    && mappedProductCount > 0
    && logisticsReadyCount > 0
    && commissionReadyCount > 0
    && costReadyCount > 0;
  const configReady = cartPriceTaxModeReady;
  const candidateReady = candidateCount > 0;
  const nextActions: GrabCartReadinessResult['nextActions'] = [];

  if (resellCount === 0) {
    nextActions.push(toReadinessAction('SYNC_RESELL_PRODUCTS', '先同步或识别该店铺的 RESELL 跟卖产品。', 'HIGH'));
  }
  if (resellWithStockCount === 0 && resellCount > 0) {
    nextActions.push(toReadinessAction('CHECK_RESELL_STOCK', '当前 RESELL 产品没有平台库存，请先确认库存同步结果。', 'HIGH'));
  }
  if (mappedProductCount < notWonRows.length) {
    nextActions.push(toReadinessAction('MAP_INVENTORY_PRODUCT', '给未绑定的 StoreProduct 补齐 mappedInventorySku / Product 映射。', 'HIGH'));
  }
  if (costReadyCount < mappedProductCount || mappedProductCount === 0) {
    nextActions.push(toReadinessAction('FILL_PURCHASE_COST', '补齐 Product.purchasePrice，确保价格保护能计算采购成本。', 'HIGH'));
  }
  if (logisticsReadyCount < mappedProductCount || mappedProductCount === 0) {
    nextActions.push(toReadinessAction('FILL_LOGISTICS_DIMENSIONS', '补齐 Product 长宽高和实际重量，用于计算头程物流成本。', 'MEDIUM'));
  }
  if (commissionReadyCount < notWonRows.length) {
    nextActions.push(toReadinessAction('SYNC_COMMISSION_RATE', '执行佣金同步，补齐 StoreProduct.commissionRate。', 'MEDIUM'));
  }
  if (!cartPriceTaxModeReady) {
    nextActions.push(toReadinessAction('CONFIG_CART_PRICE_TAX_MODE', '配置 StorePriceStrategyConfig.cartPriceTaxMode，明确购物车价是否含 VAT。', 'HIGH'));
  }
  if (params.includePreview === true && previewOkCount === 0 && dataReady && configReady) {
    nextActions.push(toReadinessAction('CHECK_PREVIEW_BLOCKERS', '根据 includePreview 返回的阻塞原因处理 offer 可售状态或保护价。', 'LOW'));
  }
  if (candidateReady) {
    nextActions.push(toReadinessAction('OPEN_CANDIDATE_POOL', '当前已有可准备的抢车候选，可进入候选池勾选确认。', 'LOW'));
  }

  const legacyNextActions = [...new Set(nextActions.map((item) => item.description))];
  const blockers = toReadinessBlockers(blockerCounts);
  const topBlockers = blockers.slice(0, 5);
  const missingParts = legacyNextActions.filter((action) => action !== '当前已有可准备的抢车候选，可进入候选池勾选确认。');
  const message = candidateReady
    ? '代码已支持该店铺，当前已有 DB-only 可准备候选；如需最终执行前校验，可打开 includePreview=true。'
    : `代码已支持该店铺，但当前${missingParts.length > 0 ? `需要：${missingParts.join('、')}` : '暂无可执行抢车候选'}。`;

  return {
    shopId: params.shopId,
    summary: {
      totalStoreProducts,
      resellCount,
      resellWithStockCount,
      hasOfferPnkSkuCount,
      notWonCount,
      mappedProductCount,
      fbeFeeReadyCount,
      realFbeReadyCount,
      estimatedFbeCount,
      fbeMissingButFallbackCount,
      logisticsReadyCount,
      commissionReadyCount,
      cartPriceTaxModeReady,
      cartPriceTaxMode,
      previewOkCount,
      candidateCount,
      scannedCount,
      scanLimit: GRAB_CART_CANDIDATES_SCAN_LIMIT,
    },
    displaySummary: {
      resellCount,
      inStockResellCount: resellWithStockCount,
      dataReadyCount,
      candidateReadyCount: candidateCount,
    },
    blockers,
    topBlockers,
    nextActions,
    legacyNextActions,
    autoIntegration: {
      codeLayerAutoSupported: true,
      dataReady,
      configReady,
      candidateReady,
      message,
    },
  };
}

export async function listGrabCartCandidates(params: {
  shopId: number;
  page?: number;
  pageSize?: number;
}): Promise<ListGrabCartCandidatesResult> {
  const page = Number.isInteger(params.page) && (params.page ?? 0) > 0 ? params.page! : 1;
  const pageSizeRaw = Number.isInteger(params.pageSize) && (params.pageSize ?? 0) > 0 ? params.pageSize! : 50;
  const pageSize = Math.min(pageSizeRaw, GRAB_CART_CANDIDATES_MAX_PAGE_SIZE);

  const strategyConfig = await prisma.storePriceStrategyConfig.findUnique({
    where: { shopId: params.shopId },
    select: { targetMinMarginPct: true },
  });
  const targetMinMarginPct = strategyConfig?.targetMinMarginPct != null
    ? Number(strategyConfig.targetMinMarginPct)
    : DEFAULT_PRICE_STRATEGY.targetMinMarginPct;

  const dbRows = await prisma.storeProduct.findMany({
    where: {
      shopId: params.shopId,
      isArchived: false,
      emagLinkType: 'RESELL',
      stock: { gt: 0 },
      emagOfferId: { not: null },
      commissionRate: { not: null },
      mappedInventorySku: { not: null },
      AND: [
        { OR: [{ buyBoxStatus: null }, { buyBoxStatus: { not: 'WON' } }] },
        { OR: [{ buyButtonRank: null }, { buyButtonRank: { not: 1 } }] },
      ],
    },
    select: {
      id: true,
      sku: true,
      pnk: true,
      name: true,
      emagOfferId: true,
      mappedInventorySku: true,
      stock: true,
      buyButtonRank: true,
      buyBoxStatus: true,
      lastPriceAdjustedAt: true,
      lastPriceAdjustmentMode: true,
    },
    orderBy: { id: 'asc' },
    take: GRAB_CART_CANDIDATES_SCAN_LIMIT,
  });

  const prefilteredRows = dbRows.filter(
    (row) => row.mappedInventorySku
      && Boolean(row.sku?.trim())
      && Boolean(row.pnk?.trim()),
  );

  const qualified: GrabCartCandidateItem[] = [];
  for (const row of prefilteredRows) {
    try {
      const preview = await buildGrabCartPreview({ shopId: params.shopId, storeProductId: row.id });
      const selectable = isQualifiedGrabCartPreview(preview, targetMinMarginPct);
      if (selectable || isDisplayableEstimatedGrabCartPreview(preview, targetMinMarginPct)) {
        qualified.push(buildCandidateFromPreview(row, preview, selectable));
      }
    } catch (err) {
      console.error(`[listGrabCartCandidates] preview failed storeProductId=${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const offset = (page - 1) * pageSize;
  const items = qualified.slice(offset, offset + pageSize);

  return {
    shopId: params.shopId,
    page,
    pageSize,
    total: qualified.length,
    scannedCount: prefilteredRows.length,
    scanLimit: GRAB_CART_CANDIDATES_SCAN_LIMIT,
    items,
  };
}

export function validateGrabCartBatchItems(
  items: GrabCartBatchExecuteItemInput[],
): { ok: true } | { ok: false; message: string } {
  if (!Array.isArray(items) || items.length < 1 || items.length > GRAB_CART_BATCH_MAX_ITEMS) {
    return { ok: false, message: `items 数量必须在 1-${GRAB_CART_BATCH_MAX_ITEMS} 之间` };
  }

  const seen = new Set<number>();
  for (const item of items) {
    const storeProductId = Number(item.storeProductId);
    const confirmedPriceExVat = Number(item.confirmedPriceExVat);
    if (!Number.isInteger(storeProductId) || storeProductId <= 0) {
      return { ok: false, message: 'storeProductId 无效' };
    }
    if (!Number.isFinite(confirmedPriceExVat) || confirmedPriceExVat <= 0) {
      return { ok: false, message: 'confirmedPriceExVat 必须是大于 0 的不含 VAT 价格' };
    }
    if (seen.has(storeProductId)) {
      return { ok: false, message: 'items 中存在重复的 storeProductId' };
    }
    seen.add(storeProductId);
  }

  return { ok: true };
}

export async function batchExecuteGrabCart(params: {
  shopId: number;
  reason: string;
  items: GrabCartBatchExecuteItemInput[];
  operatorUserId?: number | null;
}): Promise<GrabCartBatchExecuteResult> {
  const batchId = randomUUID();
  const batchReason = `[batch:${batchId}] ${params.reason}`;
  const results: GrabCartBatchItemResult[] = [];

  for (const item of params.items) {
    const storeProduct = await prisma.storeProduct.findFirst({
      where: { id: item.storeProductId, shopId: params.shopId, isArchived: false },
      select: { id: true, sku: true },
    });

    if (!storeProduct) {
      results.push({
        storeProductId: item.storeProductId,
        sku: null,
        status: 'BLOCKED',
        code: PRICE_ERROR_CODES.STORE_PRODUCT_NOT_FOUND,
        message: 'StoreProduct 不存在或不属于指定 shopId',
        oldSalePriceExVat: null,
        newSalePriceExVat: item.confirmedPriceExVat,
        logId: null,
        readBackStatus: null,
        readBackPrice: null,
        readBackWarning: null,
        noEmagWriteExecuted: true,
        writeGuardReasonCode: null,
      });
      continue;
    }

    const executeResult = await executeGrabCartPriceChange({
      shopId: params.shopId,
      storeProductId: item.storeProductId,
      confirmedPriceExVat: item.confirmedPriceExVat,
      reason: batchReason,
      operatorUserId: params.operatorUserId ?? null,
    });

    results.push(mapExecuteToBatchItem(storeProduct.sku, executeResult));
  }

  const summary = {
    success: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    pendingConfirm: 0,
  };

  for (const row of results) {
    if (row.status === 'SUCCESS') {
      summary.success += 1;
      if (row.readBackStatus === 'UNCONFIRMED') summary.pendingConfirm += 1;
    } else if (row.status === 'FAILED' || row.status === 'PENDING_VERIFY') {
      summary.failed += 1;
    } else if (row.status === 'BLOCKED') {
      summary.blocked += 1;
    } else {
      summary.skipped += 1;
    }
  }

  return {
    batchId,
    shopId: params.shopId,
    mode: 'GRAB_CART_MANUAL',
    total: results.length,
    ...summary,
    items: results,
  };
}
