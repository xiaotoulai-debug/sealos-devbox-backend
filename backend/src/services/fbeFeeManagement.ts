import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { recalcProfitForStoreProducts } from './profitCalculator';
import { listGrabCartCandidates } from './grabCartBatch';
import { resolveFbeFee, type FbeFeeScope, type ResolvedFbeFee } from './fbeFeeResolver';

export const FBE_FEE_BATCH_MAX_ROWS = 500;

export type FbeFeeBatchScope = 'PRODUCT_DEFAULT' | 'STORE_PRODUCT_OVERRIDE';
export type FbeFeeBatchSource = 'MANUAL' | 'IMPORT';
export type FbeFeeRecordStatus = 'ALL' | 'ACTUAL' | 'ESTIMATED' | 'MISSING_MAPPING';

export type FbeFeeBatchInputRow = {
  scope: FbeFeeBatchScope;
  shopId?: number;
  storeProductId?: number;
  sku?: string;
  pnk?: string;
  feeCny: number;
  note?: string;
  source: FbeFeeBatchSource;
};

export type FbeFeeBatchItemResult = {
  rowIndex: number;
  scope: FbeFeeBatchScope;
  status: 'PLANNED' | 'UPDATED' | 'UNCHANGED' | 'FAILED';
  productId: number | null;
  storeProductId: number | null;
  shopId: number | null;
  sku: string | null;
  pnk: string | null;
  oldFeeCny: number | null;
  newFeeCny: number | null;
  message?: string;
};

export type FbeFeeBatchResult = {
  total: number;
  planned: number;
  updated: number;
  unchanged: number;
  failed: number;
  affectedStoreProductCount: number;
  profitRecalculatedCount: number;
  items: FbeFeeBatchItemResult[];
};

type ResolvedTarget = {
  scope: FbeFeeBatchScope;
  productId: number | null;
  storeProductId: number | null;
  shopId: number | null;
  sku: string | null;
  pnk: string | null;
  oldFeeCny: number | null;
  product: {
    id: number;
    sku: string | null;
    pnk: string;
    fbeFee: Prisma.Decimal | null;
    fbeFeeSource: string | null;
  } | null;
  storeProduct: {
    id: number;
    shopId: number;
    sku: string | null;
    pnk: string;
    mappedInventorySku: string | null;
    fbeFeeOverrideCny: Prisma.Decimal | null;
    fbeFeeOverrideSource: string | null;
  } | null;
};

function roundFee(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeSku(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePnk(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function targetKey(scope: FbeFeeBatchScope, productId: number | null, storeProductId: number | null): string {
  if (scope === 'PRODUCT_DEFAULT') return `PRODUCT:${productId}`;
  return `STORE:${storeProductId}`;
}

async function findProductBySku(sku: string) {
  return prisma.product.findFirst({
    where: { sku, isDeleted: false },
    select: { id: true, sku: true, pnk: true, fbeFee: true, fbeFeeSource: true },
  });
}

async function findProductByPnk(pnk: string) {
  return prisma.product.findFirst({
    where: { pnk, isDeleted: false },
    select: { id: true, sku: true, pnk: true, fbeFee: true, fbeFeeSource: true },
  });
}

async function findStoreProductById(storeProductId: number) {
  return prisma.storeProduct.findFirst({
    where: { id: storeProductId, isArchived: false },
    select: {
      id: true,
      shopId: true,
      sku: true,
      pnk: true,
      mappedInventorySku: true,
      fbeFeeOverrideCny: true,
      fbeFeeOverrideSource: true,
    },
  });
}

async function findStoreProductByShopSku(shopId: number, sku: string) {
  return prisma.storeProduct.findFirst({
    where: { shopId, isArchived: false, OR: [{ sku }, { vendorSku: sku }, { mappedInventorySku: sku }] },
    select: {
      id: true,
      shopId: true,
      sku: true,
      pnk: true,
      mappedInventorySku: true,
      fbeFeeOverrideCny: true,
      fbeFeeOverrideSource: true,
    },
  });
}

async function findStoreProductByShopPnk(shopId: number, pnk: string) {
  return prisma.storeProduct.findFirst({
    where: { shopId, pnk, isArchived: false },
    select: {
      id: true,
      shopId: true,
      sku: true,
      pnk: true,
      mappedInventorySku: true,
      fbeFeeOverrideCny: true,
      fbeFeeOverrideSource: true,
    },
  });
}

async function resolveBatchTarget(row: FbeFeeBatchInputRow, rowIndex: number): Promise<{ ok: true; target: ResolvedTarget } | { ok: false; message: string }> {
  const sku = normalizeSku(row.sku);
  const pnk = normalizePnk(row.pnk);

  if (row.scope === 'PRODUCT_DEFAULT') {
    let productBySku = sku ? await findProductBySku(sku) : null;
    let productByPnk = pnk ? await findProductByPnk(pnk) : null;

    if (sku && !productBySku) {
      return { ok: false, message: `第 ${rowIndex + 1} 行：SKU ${sku} 未找到 Product 映射` };
    }
    if (!sku && pnk && !productByPnk) {
      return { ok: false, message: `第 ${rowIndex + 1} 行：PNK ${pnk} 未找到 Product 映射` };
    }
    if (!sku && !pnk && !row.storeProductId) {
      return { ok: false, message: `第 ${rowIndex + 1} 行：PRODUCT_DEFAULT 至少需要 sku、pnk 或 storeProductId` };
    }

    if (sku && pnk && productBySku && productByPnk && productBySku.id !== productByPnk.id) {
      return { ok: false, message: `第 ${rowIndex + 1} 行：SKU 与 PNK 指向不同 Product` };
    }

    let product = productBySku ?? productByPnk;
    let storeProduct = null;

    if (row.storeProductId) {
      storeProduct = await findStoreProductById(row.storeProductId);
      if (!storeProduct) {
        return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId=${row.storeProductId} 不存在` };
      }
      const mappedSku = storeProduct.mappedInventorySku;
      const linkedProduct = mappedSku
        ? await findProductBySku(mappedSku)
        : await findProductByPnk(storeProduct.pnk);
      if (!linkedProduct) {
        return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId=${row.storeProductId} 未绑定 Product` };
      }
      if (product && product.id !== linkedProduct.id) {
        return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId 与 sku/pnk 指向不同 Product` };
      }
      product = linkedProduct;
    }

    if (!product) {
      return { ok: false, message: `第 ${rowIndex + 1} 行：无法解析 Product 目标` };
    }

    return {
      ok: true,
      target: {
        scope: 'PRODUCT_DEFAULT',
        productId: product.id,
        storeProductId: storeProduct?.id ?? null,
        shopId: storeProduct?.shopId ?? null,
        sku: product.sku,
        pnk: product.pnk,
        oldFeeCny: product.fbeFee != null ? Number(product.fbeFee) : null,
        product,
        storeProduct,
      },
    };
  }

  if (!row.shopId || !Number.isInteger(row.shopId) || row.shopId <= 0) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：STORE_PRODUCT_OVERRIDE 必须提供有效 shopId` };
  }

  let storeProduct = row.storeProductId ? await findStoreProductById(row.storeProductId) : null;
  if (row.storeProductId && !storeProduct) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId=${row.storeProductId} 不存在` };
  }
  if (storeProduct && storeProduct.shopId !== row.shopId) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId 不属于 shopId=${row.shopId}` };
  }

  const storeBySku = sku ? await findStoreProductByShopSku(row.shopId, sku) : null;
  const storeByPnk = !sku && pnk ? await findStoreProductByShopPnk(row.shopId, pnk) : null;

  if (sku && !storeBySku && !storeProduct) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：shopId=${row.shopId} 下 SKU ${sku} 未找到 StoreProduct` };
  }
  if (!sku && pnk && !storeByPnk && !storeProduct) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：shopId=${row.shopId} 下 PNK ${pnk} 未找到 StoreProduct` };
  }
  if (!sku && !pnk && !storeProduct) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：STORE_PRODUCT_OVERRIDE 至少需要 storeProductId、sku 或 pnk` };
  }

  if (storeProduct && storeBySku && storeProduct.id !== storeBySku.id) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId 与 SKU 指向不同 StoreProduct` };
  }
  if (storeProduct && storeByPnk && storeProduct.id !== storeByPnk.id) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：storeProductId 与 PNK 指向不同 StoreProduct` };
  }
  if (storeBySku && storeByPnk && storeBySku.id !== storeByPnk.id) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：SKU 与 PNK 指向不同 StoreProduct` };
  }

  storeProduct = storeProduct ?? storeBySku ?? storeByPnk;
  if (!storeProduct) {
    return { ok: false, message: `第 ${rowIndex + 1} 行：无法解析 StoreProduct 目标` };
  }

  const mappedSku = storeProduct.mappedInventorySku;
  const product = mappedSku
    ? await findProductBySku(mappedSku)
    : await findProductByPnk(storeProduct.pnk);

  return {
    ok: true,
    target: {
      scope: 'STORE_PRODUCT_OVERRIDE',
      productId: product?.id ?? null,
      storeProductId: storeProduct.id,
      shopId: storeProduct.shopId,
      sku: storeProduct.sku ?? storeProduct.mappedInventorySku,
      pnk: storeProduct.pnk,
      oldFeeCny: storeProduct.fbeFeeOverrideCny != null ? Number(storeProduct.fbeFeeOverrideCny) : null,
      product,
      storeProduct,
    },
  };
}

async function findAffectedStoreProductIdsForProduct(product: { id: number; sku: string | null; pnk: string }): Promise<number[]> {
  const or: Prisma.StoreProductWhereInput[] = [{ pnk: product.pnk }];
  if (product.sku) {
    or.push({ mappedInventorySku: product.sku });
  }
  const rows = await prisma.storeProduct.findMany({
    where: { isArchived: false, OR: or },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

function toRecordDto(row: {
  id: number;
  shopId: number;
  sku: string | null;
  pnk: string;
  name: string;
  mappedInventorySku: string | null;
  profitMarginPct: number | null;
  fbeFeeOverrideCny: Prisma.Decimal | null;
  fbeFeeOverrideSource: string | null;
  fbeFeeOverrideUpdatedAt: Date | null;
  fbeFeeOverrideNote: string | null;
  shop: { shopName: string; region: string | null };
  product: {
    id: number;
    sku: string | null;
    fbeFee: Prisma.Decimal | null;
    fbeFeeSource: string | null;
    fbeFeeUpdatedAt: Date | null;
    fbeFeeNote: string | null;
  } | null;
}, resolved: ResolvedFbeFee, grabCartBlockReason: string | null) {
  return {
    storeProductId: row.id,
    shopId: row.shopId,
    shopName: row.shop.shopName,
    region: row.shop.region,
    SKU: row.sku ?? row.mappedInventorySku ?? '',
    PNK: row.pnk,
    productName: row.name,
    mappedInventorySku: row.mappedInventorySku,
    productId: row.product?.id ?? null,
    effectiveFbeFeeCny: resolved.fbeFeeCny,
    productDefaultFbeFeeCny: resolved.productDefaultFbeFeeCny,
    storeOverrideFbeFeeCny: resolved.storeOverrideFbeFeeCny,
    fbeScope: resolved.fbeScope,
    fbeSource: resolved.fbeSource,
    fbeUpdatedAt: resolved.fbeUpdatedAt,
    fbeNote: resolved.fbeNote,
    isEstimatedFbe: resolved.isEstimatedFbe,
    profitMarginPct: row.profitMarginPct,
    grabCartCostReady: !resolved.isEstimatedFbe && row.product != null,
    blockReason: grabCartBlockReason,
  };
}

async function resolveGrabCartBlockReason(shopId: number, storeProductId: number, resolved: ResolvedFbeFee): Promise<string | null> {
  if (!resolved.isEstimatedFbe) return null;
  if (resolved.fbeScope === 'DEFAULT_FALLBACK') return 'FBE 使用 7 RMB 默认估算，抢车候选要求真实 FBE';
  return 'FBE 费用未维护或为估算值';
}

export async function getFbeFeeSummary(): Promise<{
  activeStoreProductTotal: number;
  actualFbeStoreProductCount: number;
  estimatedFbeStoreProductCount: number;
  productDefaultCount: number;
  storeOverrideCount: number;
  missingProductMappingCount: number;
  actualFbeCoveragePct: number;
  grabCartCandidateCount: number;
  grabCartBlockedByEstimatedFbeCount: number;
}> {
  const activeShops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
  });
  const shopIds = activeShops.map((shop) => shop.id);

  const storeProducts = await prisma.storeProduct.findMany({
    where: { shopId: { in: shopIds }, isArchived: false },
    select: {
      id: true,
      shopId: true,
      pnk: true,
      mappedInventorySku: true,
      fbeFeeOverrideCny: true,
      fbeFeeOverrideSource: true,
      fbeFeeOverrideUpdatedAt: true,
      fbeFeeOverrideNote: true,
    },
  });

  const mappedSkus = [...new Set(storeProducts.map((row) => row.mappedInventorySku).filter(Boolean))] as string[];
  const pnks = [...new Set(storeProducts.map((row) => row.pnk).filter(Boolean))];

  const [productsBySku, productsByPnk] = await Promise.all([
    mappedSkus.length > 0
      ? prisma.product.findMany({
          where: { sku: { in: mappedSkus }, isDeleted: false },
          select: { sku: true, pnk: true, fbeFee: true, fbeFeeSource: true, fbeFeeUpdatedAt: true, fbeFeeNote: true },
        })
      : [],
    pnks.length > 0
      ? prisma.product.findMany({
          where: { pnk: { in: pnks }, isDeleted: false },
          select: { sku: true, pnk: true, fbeFee: true, fbeFeeSource: true, fbeFeeUpdatedAt: true, fbeFeeNote: true },
        })
      : [],
  ]);

  const productBySku = new Map(productsBySku.map((product) => [product.sku!, product]));
  const productByPnk = new Map(productsByPnk.map((product) => [product.pnk, product]));

  let actualFbeStoreProductCount = 0;
  let estimatedFbeStoreProductCount = 0;
  let productDefaultCount = 0;
  let storeOverrideCount = 0;
  let missingProductMappingCount = 0;

  for (const row of storeProducts) {
    const product = row.mappedInventorySku
      ? productBySku.get(row.mappedInventorySku)
      : productByPnk.get(row.pnk);

    if (!product) {
      missingProductMappingCount += 1;
      estimatedFbeStoreProductCount += 1;
      continue;
    }

    const resolved = resolveFbeFee({ storeProduct: row, product });
    if (resolved.fbeScope === 'STORE_PRODUCT_OVERRIDE') storeOverrideCount += 1;
    if (resolved.fbeScope === 'PRODUCT_DEFAULT') productDefaultCount += 1;
    if (resolved.isEstimatedFbe) estimatedFbeStoreProductCount += 1;
    else actualFbeStoreProductCount += 1;
  }

  const activeStoreProductTotal = storeProducts.length;
  const actualFbeCoveragePct = activeStoreProductTotal > 0
    ? Math.round((actualFbeStoreProductCount / activeStoreProductTotal) * 10000) / 100
    : 0;

  let grabCartCandidateCount = 0;
  let grabCartBlockedByEstimatedFbeCount = 0;
  for (const shopId of shopIds) {
    try {
      const candidates = await listGrabCartCandidates({ shopId, page: 1, pageSize: 100 });
      grabCartCandidateCount += candidates.total;
      for (const item of candidates.items) {
        if (item.isEstimatedFbe) grabCartBlockedByEstimatedFbeCount += 1;
      }
    } catch {
      // ignore per-shop candidate errors in summary
    }
  }

  return {
    activeStoreProductTotal,
    actualFbeStoreProductCount,
    estimatedFbeStoreProductCount,
    productDefaultCount,
    storeOverrideCount,
    missingProductMappingCount,
    actualFbeCoveragePct,
    grabCartCandidateCount,
    grabCartBlockedByEstimatedFbeCount,
  };
}

export async function listFbeFeeRecords(params: {
  page?: number;
  pageSize?: number;
  shopId?: number;
  keyword?: string;
  status?: FbeFeeRecordStatus;
}): Promise<{ page: number; pageSize: number; total: number; items: ReturnType<typeof toRecordDto>[] }> {
  const page = Number.isInteger(params.page) && (params.page ?? 0) > 0 ? params.page! : 1;
  const pageSizeRaw = Number.isInteger(params.pageSize) && (params.pageSize ?? 0) > 0 ? params.pageSize! : 20;
  const pageSize = Math.min(pageSizeRaw, 100);
  const status = params.status ?? 'ALL';

  const where: Prisma.StoreProductWhereInput = {
    isArchived: false,
    shop: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
  };
  if (params.shopId) where.shopId = params.shopId;
  if (params.keyword?.trim()) {
    const keyword = params.keyword.trim();
    where.OR = [
      { sku: { contains: keyword, mode: 'insensitive' } },
      { pnk: { contains: keyword, mode: 'insensitive' } },
      { mappedInventorySku: { contains: keyword, mode: 'insensitive' } },
      { name: { contains: keyword, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.storeProduct.findMany({
    where,
    select: {
      id: true,
      shopId: true,
      sku: true,
      pnk: true,
      name: true,
      mappedInventorySku: true,
      profitMarginPct: true,
      fbeFeeOverrideCny: true,
      fbeFeeOverrideSource: true,
      fbeFeeOverrideUpdatedAt: true,
      fbeFeeOverrideNote: true,
      shop: { select: { shopName: true, region: true } },
    },
    orderBy: { id: 'asc' },
  });

  const mappedSkus = [...new Set(rows.map((row) => row.mappedInventorySku).filter(Boolean))] as string[];
  const pnks = [...new Set(rows.map((row) => row.pnk).filter(Boolean))];
  const [productsBySku, productsByPnk] = await Promise.all([
    mappedSkus.length > 0
      ? prisma.product.findMany({
          where: { sku: { in: mappedSkus }, isDeleted: false },
          select: { id: true, sku: true, pnk: true, fbeFee: true, fbeFeeSource: true, fbeFeeUpdatedAt: true, fbeFeeNote: true },
        })
      : [],
    pnks.length > 0
      ? prisma.product.findMany({
          where: { pnk: { in: pnks }, isDeleted: false },
          select: { id: true, sku: true, pnk: true, fbeFee: true, fbeFeeSource: true, fbeFeeUpdatedAt: true, fbeFeeNote: true },
        })
      : [],
  ]);
  const productBySku = new Map(productsBySku.map((product) => [product.sku!, product]));
  const productByPnk = new Map(productsByPnk.map((product) => [product.pnk, product]));

  const enriched = [];
  for (const row of rows) {
    const product = row.mappedInventorySku
      ? productBySku.get(row.mappedInventorySku) ?? null
      : productByPnk.get(row.pnk) ?? null;
    const resolved = resolveFbeFee({ storeProduct: row, product });
    const blockReason = product
      ? await resolveGrabCartBlockReason(row.shopId, row.id, resolved)
      : '缺少 Product 映射';

    if (status === 'MISSING_MAPPING' && product) continue;
    if (status === 'ACTUAL' && resolved.isEstimatedFbe) continue;
    if (status === 'ESTIMATED' && !resolved.isEstimatedFbe) continue;
    if (status === 'MISSING_MAPPING' && !product) {
      enriched.push(toRecordDto({ ...row, product: null }, resolved, blockReason));
      continue;
    }
    if (status !== 'MISSING_MAPPING') {
      enriched.push(toRecordDto({ ...row, product }, resolved, blockReason));
    }
  }

  const total = enriched.length;
  const offset = (page - 1) * pageSize;
  const items = enriched.slice(offset, offset + pageSize);
  return { page, pageSize, total, items };
}

export async function previewFbeFeeBatch(rows: FbeFeeBatchInputRow[]): Promise<FbeFeeBatchResult> {
  return processFbeFeeBatch(rows, { dryRun: true });
}

export async function executeFbeFeeBatch(rows: FbeFeeBatchInputRow[], operatorUserId: number | null): Promise<FbeFeeBatchResult> {
  return processFbeFeeBatch(rows, { dryRun: false, operatorUserId });
}

async function processFbeFeeBatch(
  rows: FbeFeeBatchInputRow[],
  options: { dryRun: boolean; operatorUserId?: number | null },
): Promise<FbeFeeBatchResult> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('rows 不能为空');
  }
  if (rows.length > FBE_FEE_BATCH_MAX_ROWS) {
    throw new Error(`一次最多 ${FBE_FEE_BATCH_MAX_ROWS} 行`);
  }

  const result: FbeFeeBatchResult = {
    total: rows.length,
    planned: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    affectedStoreProductCount: 0,
    profitRecalculatedCount: 0,
    items: [],
  };

  const seenTargets = new Set<string>();
  const affectedStoreProductIds = new Set<number>();
  const now = new Date();

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const feeCny = Number(row.feeCny);
    if (!Number.isFinite(feeCny) || feeCny <= 0) {
      result.failed += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'FAILED',
        productId: null,
        storeProductId: row.storeProductId ?? null,
        shopId: row.shopId ?? null,
        sku: row.sku ?? null,
        pnk: row.pnk ?? null,
        oldFeeCny: null,
        newFeeCny: null,
        message: 'feeCny 必须大于 0',
      });
      continue;
    }

    const resolvedTarget = await resolveBatchTarget(row, rowIndex);
    if (!resolvedTarget.ok) {
      result.failed += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'FAILED',
        productId: null,
        storeProductId: row.storeProductId ?? null,
        shopId: row.shopId ?? null,
        sku: row.sku ?? null,
        pnk: row.pnk ?? null,
        oldFeeCny: null,
        newFeeCny: roundFee(feeCny),
        message: resolvedTarget.message,
      });
      continue;
    }

    const target = resolvedTarget.target;
    const dedupeKey = targetKey(row.scope, target.productId, target.storeProductId);
    if (seenTargets.has(dedupeKey)) {
      result.failed += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'FAILED',
        productId: target.productId,
        storeProductId: target.storeProductId,
        shopId: target.shopId,
        sku: target.sku,
        pnk: target.pnk,
        oldFeeCny: target.oldFeeCny,
        newFeeCny: roundFee(feeCny),
        message: '同一次导入重复命中同一个目标',
      });
      continue;
    }
    seenTargets.add(dedupeKey);

    const newFee = roundFee(feeCny);
    const unchanged = target.oldFeeCny != null && Math.abs(target.oldFeeCny - newFee) < 0.0001;
    if (unchanged) {
      result.unchanged += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'UNCHANGED',
        productId: target.productId,
        storeProductId: target.storeProductId,
        shopId: target.shopId,
        sku: target.sku,
        pnk: target.pnk,
        oldFeeCny: target.oldFeeCny,
        newFeeCny: newFee,
      });
      continue;
    }

    result.planned += 1;
    if (options.dryRun) {
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'PLANNED',
        productId: target.productId,
        storeProductId: target.storeProductId,
        shopId: target.shopId,
        sku: target.sku,
        pnk: target.pnk,
        oldFeeCny: target.oldFeeCny,
        newFeeCny: newFee,
      });
      if (row.scope === 'PRODUCT_DEFAULT' && target.product) {
        const ids = await findAffectedStoreProductIdsForProduct(target.product);
        ids.forEach((id) => affectedStoreProductIds.add(id));
      } else if (target.storeProductId) {
        affectedStoreProductIds.add(target.storeProductId);
      }
      continue;
    }

    try {
      if (row.scope === 'PRODUCT_DEFAULT' && target.productId) {
        await prisma.product.update({
          where: { id: target.productId },
          data: {
            fbeFee: newFee,
            fbeFeeSource: row.source,
            fbeFeeUpdatedAt: now,
            fbeFeeNote: row.note?.trim() || null,
          },
        });
        await prisma.fbeFeeChangeLog.create({
          data: {
            productId: target.productId,
            storeProductId: target.storeProductId,
            shopId: target.shopId,
            sku: target.sku,
            pnk: target.pnk,
            scope: 'PRODUCT_DEFAULT',
            oldFeeCny: target.oldFeeCny,
            newFeeCny: newFee,
            source: row.source,
            note: row.note?.trim() || null,
            operatorUserId: options.operatorUserId ?? null,
          },
        });
        if (target.product) {
          const ids = await findAffectedStoreProductIdsForProduct(target.product);
          ids.forEach((id) => affectedStoreProductIds.add(id));
        }
      } else if (target.storeProductId) {
        await prisma.storeProduct.update({
          where: { id: target.storeProductId },
          data: {
            fbeFeeOverrideCny: newFee,
            fbeFeeOverrideSource: row.source,
            fbeFeeOverrideUpdatedAt: now,
            fbeFeeOverrideNote: row.note?.trim() || null,
          },
        });
        await prisma.fbeFeeChangeLog.create({
          data: {
            productId: target.productId,
            storeProductId: target.storeProductId,
            shopId: target.shopId,
            sku: target.sku,
            pnk: target.pnk,
            scope: 'STORE_PRODUCT_OVERRIDE',
            oldFeeCny: target.oldFeeCny,
            newFeeCny: newFee,
            source: row.source,
            note: row.note?.trim() || null,
            operatorUserId: options.operatorUserId ?? null,
          },
        });
        affectedStoreProductIds.add(target.storeProductId);
      }

      result.updated += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'UPDATED',
        productId: target.productId,
        storeProductId: target.storeProductId,
        shopId: target.shopId,
        sku: target.sku,
        pnk: target.pnk,
        oldFeeCny: target.oldFeeCny,
        newFeeCny: newFee,
      });
    } catch (err) {
      result.failed += 1;
      result.items.push({
        rowIndex,
        scope: row.scope,
        status: 'FAILED',
        productId: target.productId,
        storeProductId: target.storeProductId,
        shopId: target.shopId,
        sku: target.sku,
        pnk: target.pnk,
        oldFeeCny: target.oldFeeCny,
        newFeeCny: newFee,
        message: err instanceof Error ? err.message : '写入失败',
      });
    }
  }

  if (!options.dryRun && affectedStoreProductIds.size > 0) {
    const ids = [...affectedStoreProductIds];
    let recalculated = 0;
    for (let i = 0; i < ids.length; i += 100) {
      recalculated += await recalcProfitForStoreProducts(ids.slice(i, i + 100));
    }
    result.affectedStoreProductCount = ids.length;
    result.profitRecalculatedCount = recalculated;
  } else {
    result.affectedStoreProductCount = affectedStoreProductIds.size;
  }

  return result;
}

export type { FbeFeeScope, ResolvedFbeFee };
