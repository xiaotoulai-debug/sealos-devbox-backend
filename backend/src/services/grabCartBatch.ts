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
  if (preview.costStatus !== 'COMPLETE') return false;
  if (preview.suggestedGrabPriceExVat == null || preview.finalMinPrice == null) return false;
  if (preview.suggestedGrabPriceExVat < preview.finalMinPrice) return false;
  if (preview.profitMarginPctAfter == null || preview.profitMarginPctAfter < targetMinMarginPct * 100) return false;
  return true;
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
    canGrab: elig.canGrab,
    code: elig.code,
    riskLevel: computeRiskLevel(preview.currentSalePriceExVat, preview.suggestedGrabPriceExVat),
    selectable: qualified,
    unselectableReason: qualified ? null : elig.message,
    lastPriceAdjustedAt: row.lastPriceAdjustedAt?.toISOString() ?? null,
    lastPriceAdjustmentMode: row.lastPriceAdjustmentMode,
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

  const mappedSkus = [...new Set(dbRows.map((row) => row.mappedInventorySku).filter(Boolean))] as string[];
  const productsWithFbe = mappedSkus.length > 0
    ? await prisma.product.findMany({
        where: { sku: { in: mappedSkus }, fbeFee: { not: null } },
        select: { sku: true },
      })
    : [];
  const fbeSkuSet = new Set(productsWithFbe.map((p) => p.sku));
  const prefilteredRows = dbRows.filter(
    (row) => row.mappedInventorySku
      && fbeSkuSet.has(row.mappedInventorySku)
      && Boolean(row.sku?.trim())
      && Boolean(row.pnk?.trim()),
  );

  const qualified: GrabCartCandidateItem[] = [];
  for (const row of prefilteredRows) {
    try {
      const preview = await buildGrabCartPreview({ shopId: params.shopId, storeProductId: row.id });
      if (isQualifiedGrabCartPreview(preview, targetMinMarginPct)) {
        qualified.push(buildCandidateFromPreview(row, preview, true));
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
