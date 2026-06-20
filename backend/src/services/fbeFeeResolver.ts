import { DEFAULT_FBE_CNY } from './priceProtection';

export type FbeFeeScope = 'STORE_PRODUCT_OVERRIDE' | 'PRODUCT_DEFAULT' | 'DEFAULT_FALLBACK';

export type FbeFeeSourceKind =
  | 'STORE_OVERRIDE'
  | 'LEGACY_PRODUCT_DEFAULT'
  | 'MANUAL'
  | 'IMPORT'
  | 'DEFAULT_FALLBACK'
  | 'MISSING';

export type ResolvedFbeFee = {
  fbeFeeCny: number;
  fbeScope: FbeFeeScope;
  fbeSource: FbeFeeSourceKind;
  isEstimatedFbe: boolean;
  productDefaultFbeFeeCny: number | null;
  storeOverrideFbeFeeCny: number | null;
  fbeUpdatedAt: string | null;
  fbeNote: string | null;
};

export type FbeFeeStoreProductInput = {
  fbeFeeOverrideCny?: unknown;
  fbeFeeOverrideSource?: string | null;
  fbeFeeOverrideUpdatedAt?: Date | string | null;
  fbeFeeOverrideNote?: string | null;
} | null | undefined;

export type FbeFeeProductInput = {
  fbeFee?: unknown;
  fbeFeeSource?: string | null;
  fbeFeeUpdatedAt?: Date | string | null;
  fbeFeeNote?: string | null;
} | null | undefined;

function toPositiveFee(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeProductSource(source: string | null | undefined): FbeFeeSourceKind {
  if (source === 'MANUAL' || source === 'IMPORT') return source;
  if (source === 'LEGACY_PRODUCT_DEFAULT') return 'LEGACY_PRODUCT_DEFAULT';
  return 'LEGACY_PRODUCT_DEFAULT';
}

function normalizeStoreSource(source: string | null | undefined): FbeFeeSourceKind {
  if (source === 'MANUAL' || source === 'IMPORT') return source;
  return 'MANUAL';
}

export function resolveFbeFee(input: {
  storeProduct?: FbeFeeStoreProductInput;
  product?: FbeFeeProductInput;
}): ResolvedFbeFee {
  const storeOverride = toPositiveFee(input.storeProduct?.fbeFeeOverrideCny);
  const productDefault = toPositiveFee(input.product?.fbeFee);

  if (storeOverride != null) {
    return {
      fbeFeeCny: storeOverride,
      fbeScope: 'STORE_PRODUCT_OVERRIDE',
      fbeSource: normalizeStoreSource(input.storeProduct?.fbeFeeOverrideSource),
      isEstimatedFbe: false,
      productDefaultFbeFeeCny: productDefault,
      storeOverrideFbeFeeCny: storeOverride,
      fbeUpdatedAt: toIso(input.storeProduct?.fbeFeeOverrideUpdatedAt),
      fbeNote: input.storeProduct?.fbeFeeOverrideNote ?? null,
    };
  }

  if (productDefault != null) {
    return {
      fbeFeeCny: productDefault,
      fbeScope: 'PRODUCT_DEFAULT',
      fbeSource: normalizeProductSource(input.product?.fbeFeeSource),
      isEstimatedFbe: false,
      productDefaultFbeFeeCny: productDefault,
      storeOverrideFbeFeeCny: null,
      fbeUpdatedAt: toIso(input.product?.fbeFeeUpdatedAt),
      fbeNote: input.product?.fbeFeeNote ?? null,
    };
  }

  return {
    fbeFeeCny: DEFAULT_FBE_CNY,
    fbeScope: 'DEFAULT_FALLBACK',
    fbeSource: 'DEFAULT_FALLBACK',
    isEstimatedFbe: true,
    productDefaultFbeFeeCny: null,
    storeOverrideFbeFeeCny: null,
    fbeUpdatedAt: null,
    fbeNote: null,
  };
}

export function buildFbeEstimatedWarning(resolved: ResolvedFbeFee): string {
  return `FBE 费用使用 ${DEFAULT_FBE_CNY} RMB 默认估算`;
}
