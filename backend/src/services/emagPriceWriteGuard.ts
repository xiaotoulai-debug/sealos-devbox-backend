/**
 * eMAG 真实写价安全闸门（Phase B-7）
 * 仅读取 process.env，fail-closed；不允许从 request body/query/header 打开。
 */

export type EmagPriceWriteMode = 'MANUAL_PRICE_CHANGE' | 'GRAB_CART_MANUAL';

export type EmagPriceWriteGuardReasonCode =
  | 'DISABLED'
  | 'SHOP_NOT_ALLOWED'
  | 'STORE_PRODUCT_NOT_ALLOWED'
  | 'MODE_NOT_ALLOWED'
  | 'ALLOWED';

export type EmagPriceWriteGuardResult = {
  allowed: boolean;
  reasonCode: EmagPriceWriteGuardReasonCode;
  message: string;
};

const VALID_MODES = new Set<EmagPriceWriteMode>(['MANUAL_PRICE_CHANGE', 'GRAB_CART_MANUAL']);

function parseEnvBoolean(value: string | undefined): boolean {
  if (value == null || !value.trim()) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parsePositiveIntegerList(value: string | undefined): Set<number> {
  if (value == null || !value.trim()) return new Set();
  const ids = new Set<number>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

function parseModeList(value: string | undefined): Set<EmagPriceWriteMode> {
  if (value == null || !value.trim()) return new Set();
  const modes = new Set<EmagPriceWriteMode>();
  for (const part of value.split(',')) {
    const trimmed = part.trim().toUpperCase();
    if (!trimmed) continue;
    if (VALID_MODES.has(trimmed as EmagPriceWriteMode)) {
      modes.add(trimmed as EmagPriceWriteMode);
    }
  }
  return modes;
}

export function canExecuteEmagPriceWrite(params: {
  shopId: number;
  storeProductId: number;
  mode: EmagPriceWriteMode;
}): EmagPriceWriteGuardResult {
  if (!parseEnvBoolean(process.env.EMAG_PRICE_WRITE_ENABLED)) {
    return {
      allowed: false,
      reasonCode: 'DISABLED',
      message: '真实 eMAG 写价开关未开启（EMAG_PRICE_WRITE_ENABLED 不为 true）',
    };
  }

  const allowedShopIds = parsePositiveIntegerList(process.env.EMAG_PRICE_WRITE_ALLOWED_SHOP_IDS);
  if (allowedShopIds.size === 0 || !allowedShopIds.has(params.shopId)) {
    return {
      allowed: false,
      reasonCode: 'SHOP_NOT_ALLOWED',
      message: '当前店铺不在真实写价白名单内',
    };
  }

  const allowedStoreProductIds = parsePositiveIntegerList(process.env.EMAG_PRICE_WRITE_ALLOWED_STORE_PRODUCT_IDS);
  if (allowedStoreProductIds.size === 0 || !allowedStoreProductIds.has(params.storeProductId)) {
    return {
      allowed: false,
      reasonCode: 'STORE_PRODUCT_NOT_ALLOWED',
      message: '当前平台产品不在真实写价白名单内',
    };
  }

  const allowedModes = parseModeList(process.env.EMAG_PRICE_WRITE_ALLOWED_MODES);
  if (allowedModes.size === 0 || !allowedModes.has(params.mode)) {
    return {
      allowed: false,
      reasonCode: 'MODE_NOT_ALLOWED',
      message: '当前写价模式不在真实写价白名单内',
    };
  }

  return {
    allowed: true,
    reasonCode: 'ALLOWED',
    message: '真实 eMAG 写价已通过安全闸门',
  };
}
