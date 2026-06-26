/**
 * eMAG 产品统一解析器 (Normalizer) — 双引擎抓图（仅官方 API）
 *
 * 引擎一（本模块）：从 product_offer/read 的 attachments / images / main_url / description 解析主图。
 * 引擎二（storeProductSync 调用）：documentation/find_by_eans 返回 product_image（跨境 B 店验证有效）。
 *
 * 无论 RO/BG/HU、定时任务还是手动拉取，所有产品数据必须经此解析器。
 */

import type { EmagRegion } from './emagClient';
import { REGION_CURRENCY, REGION_DOMAIN } from './emagClient';

// ─── 工具函数 ─────────────────────────────────────────────────────

export function slugifyProductName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 150) || 'product';
}

/**
 * 图片提纯算法（黄金逻辑，跨境 B 店验证有效）
 * 严格过滤：logo、placeholder、emag 占位图、svg，确保只保留真实商品大图
 */
export function isInvalidImageUrl(u: string): boolean {
  if (!u || typeof u !== 'string') return true;
  const lower = u.toLowerCase();
  if (lower.includes('logo') || lower.includes('/logo') || lower.includes('emag-logo')) return true;
  if (lower.includes('placeholder') || lower.includes('emag-placeholder')) return true;
  if (lower.includes('temporary-images') || lower.includes('1x1') || lower.includes('default')) return true;
  if (lower.endsWith('.svg') || lower.includes('/l.svg') || lower.includes('as/l.svg')) return true;
  return false;
}

function isJpgOrPngUrl(u: string): boolean {
  const lower = u.toLowerCase();
  return (
    lower.includes('.jpg') ||
    lower.includes('.jpeg') ||
    lower.includes('.png') ||
    lower.includes('.jpg?') ||
    lower.includes('.png?')
  );
}

function extractFirstImageFromDescription(html: string): string | null {
  const match = html.match(/src=["'](https:\/\/[^"']+\.(?:jpg|jpeg|png)(?:\?[^"']*)?)["']/i);
  if (match?.[1] && !isInvalidImageUrl(match[1])) return match[1];
  const emagMatch = html.match(/src=["'](https:\/\/s\d+emagst\.akamaized\.net\/products\/[^"']+)["']/i);
  if (emagMatch?.[1] && !isInvalidImageUrl(emagMatch[1])) return emagMatch[1];
  return null;
}

/**
 * 从 images 数组提取主图（严格遵循 eMAG 官方 API 文档 product_offer/read 第 23 页）
 * - images 为对象数组，每项含 display_type、url
 * - display_type === 1 为主图，优先取该对象的 url
 * - 若无 display_type === 1，则降级取数组第一个有效 url
 * - 无条件信任 eMAG 返回的 url，不做任何正则过滤
 */
function extractFirstImageFromArray(images: unknown): string | null {
  let arr: any[];
  if (typeof images === 'string') {
    try { arr = JSON.parse(images); } catch { return null; }
    if (!Array.isArray(arr)) return null;
  } else if (Array.isArray(images)) {
    arr = images;
  } else {
    return null;
  }
  if (arr.length === 0) return null;

  if (arr.length > 0) {
    const sample = arr[0];
    console.log('🔍 [extractFirstImageFromArray] images[0] 原始结构:', JSON.stringify(sample));
    console.log('🔍 [extractFirstImageFromArray] images 长度:', arr.length);
  }

  for (const img of arr) {
    if (!img || typeof img !== 'object') continue;
    const displayType = (img as any).display_type ?? (img as any).type;
    if (displayType === 1 || displayType === '1') {
      const u = (img as any).url ?? (img as any).image ?? (img as any).src ?? (img as any).link;
      if (typeof u === 'string' && u.trim()) {
        console.log('✅ [extractFirstImageFromArray] 命中 display_type=1, url:', u.trim());
        return u.trim();
      }
    }
  }

  for (const img of arr) {
    const u = typeof img === 'string'
      ? img
      : (img && typeof img === 'object' ? ((img as any).url ?? (img as any).image ?? (img as any).src ?? (img as any).link) : null);
    if (typeof u === 'string' && u.trim()) {
      console.log('⚠️ [extractFirstImageFromArray] 无 display_type=1, 降级取首项 url:', u.trim());
      return u.trim();
    }
  }

  console.log('❌ [extractFirstImageFromArray] 遍历完毕，无任何可用 url');
  return null;
}

/** 从 attachments 数组提取第一张有效图（type===1 为主图，无条件信任 eMAG 返回的 url） */
function extractFirstImageFromAttachments(attachments: unknown): string | null {
  let arr: any[];
  if (typeof attachments === 'string') {
    try { arr = JSON.parse(attachments); } catch { return null; }
    if (!Array.isArray(arr)) return null;
  } else if (Array.isArray(attachments)) {
    arr = attachments;
  } else {
    return null;
  }
  if (arr.length === 0) return null;

  for (const att of arr) {
    if (!att || typeof att !== 'object') continue;
    const type = (att as any).type ?? (att as any).display_type;
    if (type === 1 || type === '1' || type === 'main') {
      const u = (att as any).url ?? (att as any).image ?? (att as any).src ?? (att as any).link;
      if (typeof u === 'string' && u.trim()) return u.trim();
    }
  }

  for (const att of arr) {
    if (!att || typeof att !== 'object') continue;
    const u = (att as any).url ?? (att as any).image ?? (att as any).src ?? (att as any).link;
    if (typeof u === 'string' && u.trim()) return u.trim();
  }

  return null;
}

// ─── 输出类型 ─────────────────────────────────────────────────────

export interface NormalizedProduct {
  pnk: string;
  sku: string | null;
  vendorSku: string | null;
  ean: string | null;
  name: string;
  salePrice: number;
  currency: string;
  stock: number;
  status: number;
  mainImage: string | null;
  productUrl: string | null;
  emagOfferId: string | null;
  categoryId: number | undefined;
  validationStatus: string;
  docErrors: string | null;
  rejectionReason: string | null;
  isRejected: boolean;
  ownership: unknown | null;
  numberOfOffers: number | null;
  bestOfferSalePrice: number | null;
  mainOfferPrice: number | null;
  buyButtonRank: number | null;
  offerValidationStatus: unknown | null;
  brand: string | null;
  // ── VAT 字段（来自 product_offer.vat_id）─────────────────────
  vatId: number | null;  // eMAG VAT 分类 ID，原样存储，不做税率换算
  // ── 新诊断体系字段 ──────────────────────────────────────────────
  platformDiagnostics: PlatformDiagnostic[];
  emagStatusSnapshot: EmagStatusSnapshot;
  hasPlatformAttention: boolean;
  hasBlockingIssue: boolean;
}

// ─── 平台诊断标签系统 ─────────────────────────────────────────────────────

export type PlatformDiagnosticCode =
  | 'DRAFT_INCOMPLETE'
  | 'PLATFORM_LOCKED'
  | 'PRICE_INVALID'
  | 'BRAND_REJECTED'
  | 'EAN_REJECTED'
  | 'DOCUMENTATION_REJECTED'
  | 'TRANSLATION_FAILED'
  | 'UPDATE_REJECTED'
  | 'UPDATE_REVIEW_PENDING'
  | 'MARKETPLACE_REVIEW_PENDING'
  | 'BRAND_REVIEW_PENDING'
  | 'DOCUMENTATION_REVIEW_PENDING'
  | 'TRANSLATION_PENDING'
  | 'WAITING_SALEABLE_OFFER'
  | 'OFFER_INACTIVE'
  | 'OFFER_EOL';

export interface PlatformDiagnostic {
  code: PlatformDiagnosticCode;
  severity: 'critical' | 'warning' | 'pending' | 'inactive';
  saleImpact: 'blocked' | 'saleable' | 'unknown';
  actionType: 'fix' | 'wait' | 'check' | 'none';
  reason: string | null;
  sources: Array<'validation_status' | 'translation_validation_status' | 'offer_validation_status' | 'offer_status'>;
  rawValues: number[];
}

export interface EmagStatusSnapshotItem {
  value: number | null;
  description: string | null;
  errors: string[];
}

export interface EmagStatusSnapshot {
  vs: EmagStatusSnapshotItem | null;
  transVs: EmagStatusSnapshotItem | null;
  offerVs: EmagStatusSnapshotItem | null;
  offerStatus: number | null;
}

type DiagMeta = {
  code: PlatformDiagnosticCode;
  severity: 'critical' | 'warning' | 'pending' | 'inactive';
  saleImpact: 'blocked' | 'saleable' | 'unknown';
  actionType: 'fix' | 'wait' | 'check' | 'none';
};

const COMMON_VALUE_MAP: Record<number, DiagMeta | null> = {
  0:  { code: 'DRAFT_INCOMPLETE',             severity: 'warning',   saleImpact: 'blocked',  actionType: 'fix'   },
  1:  { code: 'MARKETPLACE_REVIEW_PENDING',   severity: 'pending',   saleImpact: 'blocked',  actionType: 'wait'  },
  2:  { code: 'BRAND_REVIEW_PENDING',         severity: 'pending',   saleImpact: 'blocked',  actionType: 'wait'  },
  3:  null,
  4:  { code: 'DOCUMENTATION_REVIEW_PENDING', severity: 'pending',   saleImpact: 'blocked',  actionType: 'wait'  },
  5:  { code: 'BRAND_REJECTED',               severity: 'critical',  saleImpact: 'blocked',  actionType: 'fix'   },
  6:  { code: 'EAN_REJECTED',                 severity: 'critical',  saleImpact: 'blocked',  actionType: 'fix'   },
  8:  { code: 'DOCUMENTATION_REJECTED',       severity: 'critical',  saleImpact: 'blocked',  actionType: 'fix'   },
  9:  null,
  10: { code: 'PLATFORM_LOCKED',              severity: 'critical',  saleImpact: 'blocked',  actionType: 'check' },
  11: { code: 'UPDATE_REVIEW_PENDING',        severity: 'pending',   saleImpact: 'saleable', actionType: 'wait'  },
  12: { code: 'UPDATE_REJECTED',              severity: 'warning',   saleImpact: 'saleable', actionType: 'fix'   },
};

const TRANS_ONLY_VALUE_MAP: Record<number, DiagMeta | null> = {
  13: { code: 'WAITING_SALEABLE_OFFER', severity: 'pending',   saleImpact: 'blocked', actionType: 'check' },
  14: { code: 'TRANSLATION_FAILED',    severity: 'critical',  saleImpact: 'blocked', actionType: 'fix'   },
  15: { code: 'TRANSLATION_PENDING',   severity: 'pending',   saleImpact: 'blocked', actionType: 'wait'  },
  16: { code: 'TRANSLATION_PENDING',   severity: 'pending',   saleImpact: 'blocked', actionType: 'wait'  },
  17: null,
};

const OFFER_INACTIVE_SUPPRESSOR_CODES = new Set<PlatformDiagnosticCode>([
  'PLATFORM_LOCKED', 'BRAND_REJECTED', 'EAN_REJECTED',
  'DOCUMENTATION_REJECTED', 'TRANSLATION_FAILED', 'DRAFT_INCOMPLETE',
]);

const DIAG_SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, pending: 2, inactive: 3 };
const DIAG_CODE_ORDER: Record<PlatformDiagnosticCode, number> = {
  PLATFORM_LOCKED: 0, DOCUMENTATION_REJECTED: 1, BRAND_REJECTED: 2, EAN_REJECTED: 3,
  TRANSLATION_FAILED: 4, PRICE_INVALID: 5, DRAFT_INCOMPLETE: 6,
  UPDATE_REJECTED: 10,
  MARKETPLACE_REVIEW_PENDING: 20, BRAND_REVIEW_PENDING: 21, DOCUMENTATION_REVIEW_PENDING: 22,
  TRANSLATION_PENDING: 23, WAITING_SALEABLE_OFFER: 24, UPDATE_REVIEW_PENDING: 25,
  OFFER_EOL: 30, OFFER_INACTIVE: 31,
};

function extractStatusObjFromRaw(raw: unknown): EmagStatusSnapshotItem | null {
  if (raw == null) return null;
  const item = Array.isArray(raw) ? raw[0] : raw;
  if (item == null) return null;
  if (typeof item === 'number') return { value: item, description: null, errors: [] };
  if (typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  const value = obj.value != null ? Number(obj.value) : null;
  const description = typeof obj.description === 'string' && obj.description ? obj.description : null;
  const errors = extractErrorsForSnapshot(obj);
  return { value, description, errors };
}

function extractErrorsForSnapshot(obj: Record<string, unknown>): string[] {
  const errsRaw = obj.errors ?? obj.doc_errors ?? obj.messages;
  const msgs: string[] = [];
  const addMsg = (e: unknown): void => {
    let m = '';
    if (typeof e === 'string') {
      m = e.trim();
    } else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      m = String(o.message ?? o.error ?? o.description ?? o.field ?? o.text ?? '').trim();
      if (!m) m = JSON.stringify(e).slice(0, 500);
    }
    if (m && m !== '{}') msgs.push(m.slice(0, 500));
  };
  if (Array.isArray(errsRaw)) {
    for (const e of errsRaw.slice(0, 10)) addMsg(e);
  } else if (typeof errsRaw === 'string' && errsRaw.trim()) {
    msgs.push(errsRaw.trim().slice(0, 500));
  }
  return msgs;
}

function reasonFromStatusItem(item: EmagStatusSnapshotItem | null): string | null {
  if (!item) return null;
  if (item.errors.length > 0) return item.errors.join('; ');
  return item.description;
}

export function buildPlatformDiagnostics(
  vs: EmagStatusSnapshotItem | null,
  transVs: EmagStatusSnapshotItem | null,
  offerVs: EmagStatusSnapshotItem | null,
  offerStatus: number | null,
): PlatformDiagnostic[] {
  const byCode = new Map<PlatformDiagnosticCode, PlatformDiagnostic>();

  const processCommon = (
    item: EmagStatusSnapshotItem | null,
    sourceKey: 'validation_status' | 'translation_validation_status',
  ): void => {
    if (!item || item.value == null) return;
    const val = item.value;
    if (!(val in COMMON_VALUE_MAP)) return;
    const meta = COMMON_VALUE_MAP[val];
    if (!meta) return;
    const existing = byCode.get(meta.code);
    if (existing) {
      if (!existing.sources.includes(sourceKey)) existing.sources.push(sourceKey);
      if (!existing.rawValues.includes(val)) existing.rawValues.push(val);
      if (sourceKey === 'validation_status' && !existing.reason) {
        existing.reason = reasonFromStatusItem(item);
      }
    } else {
      byCode.set(meta.code, {
        code: meta.code, severity: meta.severity, saleImpact: meta.saleImpact, actionType: meta.actionType,
        reason: reasonFromStatusItem(item), sources: [sourceKey], rawValues: [val],
      });
    }
  };

  processCommon(vs, 'validation_status');
  processCommon(transVs, 'translation_validation_status');

  if (transVs && transVs.value != null) {
    const val = transVs.value;
    if (val in TRANS_ONLY_VALUE_MAP) {
      const meta = TRANS_ONLY_VALUE_MAP[val];
      if (meta) {
        const existing = byCode.get(meta.code);
        if (meta.code === 'TRANSLATION_PENDING' && existing) {
          if (!existing.rawValues.includes(val)) existing.rawValues.push(val);
        } else if (!existing) {
          byCode.set(meta.code, {
            code: meta.code, severity: meta.severity, saleImpact: meta.saleImpact, actionType: meta.actionType,
            reason: reasonFromStatusItem(transVs), sources: ['translation_validation_status'], rawValues: [val],
          });
        }
      }
    }
  }

  if (offerVs && offerVs.value === 2) {
    byCode.set('PRICE_INVALID', {
      code: 'PRICE_INVALID', severity: 'critical', saleImpact: 'blocked', actionType: 'fix',
      reason: reasonFromStatusItem(offerVs), sources: ['offer_validation_status'], rawValues: [2],
    });
  }

  const rootCodes = new Set(byCode.keys());

  if (offerStatus === 0 && ![...OFFER_INACTIVE_SUPPRESSOR_CODES].some(c => rootCodes.has(c))) {
    byCode.set('OFFER_INACTIVE', {
      code: 'OFFER_INACTIVE', severity: 'inactive', saleImpact: 'blocked', actionType: 'check',
      reason: null, sources: ['offer_status'], rawValues: [0],
    });
  }

  if (offerStatus === 2) {
    byCode.set('OFFER_EOL', {
      code: 'OFFER_EOL', severity: 'inactive', saleImpact: 'blocked', actionType: 'check',
      reason: null, sources: ['offer_status'], rawValues: [2],
    });
  }

  return [...byCode.values()].sort((a, b) => {
    const sa = DIAG_SEVERITY_ORDER[a.severity] ?? 99;
    const sb = DIAG_SEVERITY_ORDER[b.severity] ?? 99;
    if (sa !== sb) return sa - sb;
    return (DIAG_CODE_ORDER[a.code] ?? 99) - (DIAG_CODE_ORDER[b.code] ?? 99);
  });
}

function extractBrand(raw: Record<string, unknown>): string | null {
  const candidates = [raw.brand, raw.Brand, raw.product_brand, raw.productBrand];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

// ─── 统一解析器 ───────────────────────────────────────────────────

export interface NormalizeOptions {
  /** 是否打印 [Pipeline Output] 日志，默认 true；大批量时可传 false 减少刷屏 */
  logOutput?: boolean;
}

/**
 * 标准数据清洗管线入口（单一数据源，无硬编码）
 * 图片: attachments(type===1) > images > main_url > description
 * 价格/货币: 标准化提取，BGN→EUR
 */
export function normalizeEmagProduct(raw: Record<string, unknown>, region: EmagRegion, options?: NormalizeOptions): NormalizedProduct {
  return normalizeProductOffer(raw, region, options);
}

/**
 * 将 eMAG product_offer 原始响应解析为标准化产品
 * 图片优先级: attachments > images > main_url > main_image > image_url > description HTML
 * product_url: API 返回 > 按 region 域名拼接
 */
function normalizeProductOffer(raw: Record<string, unknown>, region: EmagRegion, options?: NormalizeOptions): NormalizedProduct {
  const pnk = String(raw?.part_number_key ?? raw?.pnk ?? raw?.part_number ?? '').trim();
  // sku  = eMAG 平台编码（raw.part_number，对应 PNK 层级，非卖家自有 SKU）
  const sku = raw?.part_number != null ? String(raw.part_number).trim() : null;
  // vendorSku = 卖家自有 SKU（raw.ext_part_number，文档："Your unique identifier for the product."）
  // 降级回退：若 ext_part_number 为空（部分旧产品可能缺失此字段），则退回使用 part_number
  const extPn = raw?.ext_part_number != null ? String(raw.ext_part_number).trim() : null;
  const vendorSku = (extPn && extPn.length > 0) ? extPn : sku;

  const eanRaw = raw?.ean;

  /**
   * EAN 归一化规则：
   * 1. 只保留纯数字字符串（过滤非数字干扰）
   * 2. 不足 13 位的补前导零至 13 位（EAN-13 标准；防止 API 将数字类型转回字符串时丢失前导零）
   * 3. 记录格式转换日志供审计
   */
  function normalizeEanString(raw: string, pnkCtx: string): string {
    const cleaned = raw.trim().replace(/\s/g, '');
    if (!/^\d+$/.test(cleaned)) return cleaned; // 非纯数字（如旧格式含字母），原样保留
    if (cleaned.length < 13) {
      const padded = cleaned.padStart(13, '0');
      // 审计日志：记录哪些 EAN 发生了格式补全
      console.log(`[EAN Normalize] pnk=${pnkCtx} EAN 前导零补全: "${cleaned}" → "${padded}"`);
      return padded;
    }
    return cleaned;
  }

  const ean =
    Array.isArray(eanRaw) && eanRaw.length > 0
      ? eanRaw
          .map((x: unknown) => {
            const raw = typeof x === 'string' ? x : (x as any)?.value ?? (x as any)?.ean ?? String(x);
            return raw ? normalizeEanString(String(raw), pnk) : null;
          })
          .filter(Boolean)
          .join(', ') || null
      : typeof eanRaw === 'string' && eanRaw.trim()
        ? normalizeEanString(eanRaw, pnk)
        : eanRaw != null && typeof eanRaw === 'number'
          ? // eMAG 偶发 number 类型（数字型 EAN 丢失前导零的根本原因）
            normalizeEanString(String(Math.round(eanRaw as number)), pnk)
          : null;

  // product_url：API 优先，否则按 region 域名拼接
  const domain = REGION_DOMAIN[region];
  let productUrl: string | null = null;
  const u = raw.url ?? raw.product_url ?? raw.link ?? raw.product_link ?? raw.page_url ?? raw.product_page ?? (raw.links as Record<string, unknown>)?.view;
  if (typeof u === 'string' && u.trim()) {
    productUrl = u.trim();
  } else {
    const name = String(raw.name ?? raw.title ?? '').trim();
    if (name) {
      productUrl = `https://www.${domain}/${slugifyProductName(name)}/pd/${pnk}/`;
    }
  }

  // main_image：多源优先级，images(display_type=1) > attachments > main_url > description
  let mainImage: string | null = null;

  // 🔍 探针：打印原始 images 字段的类型和内容（仅前 3 个产品）
  const rawImages = raw?.images;
  const rawAttachments = raw?.attachments;
  if (options?.logOutput !== false) {
    console.log(`🔍 [Normalizer] PNK=${pnk} raw.images type=${typeof rawImages}, isArray=${Array.isArray(rawImages)}, value=`, JSON.stringify(rawImages)?.slice(0, 500));
    console.log(`🔍 [Normalizer] PNK=${pnk} raw.attachments type=${typeof rawAttachments}, isArray=${Array.isArray(rawAttachments)}, value=`, JSON.stringify(rawAttachments)?.slice(0, 500));
  }

  // 优先从 images 提取（eMAG 官方文档 display_type===1 为主图）
  if (rawImages != null) {
    mainImage = extractFirstImageFromArray(rawImages);
  }
  // 次选 attachments
  if (!mainImage && rawAttachments != null) {
    mainImage = extractFirstImageFromAttachments(rawAttachments);
  }
  // 兜底：main_url / main_image / image_url 直接字段
  if (!mainImage) {
    const mainUrl = raw?.main_url ?? raw?.main_image ?? raw?.image_url;
    if (typeof mainUrl === 'string' && mainUrl.trim()) {
      mainImage = mainUrl.trim();
    }
  }
  // 最终兜底：从 description HTML 提取
  if (!mainImage && typeof raw?.description === 'string' && raw.description.trim()) {
    mainImage = extractFirstImageFromDescription(raw.description);
  }

  // 货币
  const currencyRaw = raw?.currency ?? raw?.currency_type;
  let currency =
    typeof currencyRaw === 'string' && currencyRaw.trim()
      ? currencyRaw.trim().toUpperCase()
      : (REGION_CURRENCY[region] ?? 'RON');
  if (currency === 'BGN') currency = 'EUR';

  // 库存
  let stock = 0;
  if (raw?.general_stock != null) stock = Number(raw.general_stock) || 0;
  else if (raw?.estimated_stock != null) stock = Number(raw.estimated_stock) || 0;
  else if (Array.isArray(raw?.stock) && raw.stock.length > 0) {
    stock = raw.stock.reduce((s: number, x: any) => s + Number(x?.value ?? x ?? 0), 0);
  } else if (typeof raw?.stock === 'number') stock = raw.stock;

  // 校验状态（三字段独立解析，禁止互相兜底）
  const validationRaw = raw?.validation_status;                    // 独立来源 1
  const translationValidationRaw = raw?.translation_validation_status; // 独立来源 2
  const offerValidationRaw = raw?.offer_validation_status;         // 独立来源 3
  const vsRaw = validationRaw;                                     // legacy 别名（仅限本函数内部 legacy 逻辑使用）
  const vsArr = Array.isArray(vsRaw) ? vsRaw : vsRaw ? [vsRaw] : [];
  const transVsRaw = translationValidationRaw;
  const transVsArr = Array.isArray(transVsRaw) ? transVsRaw : transVsRaw ? [transVsRaw] : [];
  const offerVs = offerValidationRaw;
  const offerVsArr = Array.isArray(offerVs) ? offerVs : offerVs ? [offerVs] : [];
  const compactValidationStatus = (value: unknown): unknown | null => {
    if (value == null || value === '') return null;
    if (Array.isArray(value)) return value.map(compactValidationStatus).filter((item) => item != null);
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      return {
        value: obj.value ?? null,
        description: obj.description ?? null,
        errors: Array.isArray(obj.errors) ? obj.errors : obj.errors ?? null,
      };
    }
    return value;
  };
  const compactOfferValidationStatus = compactValidationStatus(offerVs);

  const extractMsg = (e: any): string => {
    if (typeof e === 'string') return e;
    return (
      e?.message ??
      e?.error ??
      e?.description ??
      e?.field ??
      e?.text ??
      (e?.code ? `[${e.code}] ${e.message || e.description || e.detail || ''}`.trim() : '') ??
      (e?.details ? (Array.isArray(e.details) ? e.details.map(extractMsg).join('; ') : String(e.details)) : '') ??
      JSON.stringify(e)
    );
  };
  const collectErrors = (arr: any[]): string[] => {
    const msgs: string[] = [];
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue;
      const errs = v.errors ?? v.doc_errors ?? v.docErrors ?? v.messages ?? v.documents;
      if (Array.isArray(errs)) {
        for (const e of errs) {
          const m = extractMsg(e);
          if (m && m !== '{}') msgs.push(m);
        }
      } else if (typeof errs === 'string') msgs.push(errs);
      else if (errs && typeof errs === 'object' && !Array.isArray(errs)) {
        const m = extractMsg(errs);
        if (m && m !== '{}') msgs.push(m);
      }
    }
    return msgs;
  };

  const docErrorsTop = raw?.doc_errors ?? raw?.docErrors;
  const docErrorsFromVs = collectErrors(vsArr);
  const docErrorsFromTrans = collectErrors(transVsArr);
  const docErrorsFromOffer = collectErrors(offerVsArr);
  const docErrorsFromTop = Array.isArray(docErrorsTop)
    ? docErrorsTop.map((e: any) => (typeof e === 'string' ? e : e?.message ?? e?.error ?? e?.description ?? e?.field ?? JSON.stringify(e)))
    : typeof docErrorsTop === 'string'
      ? [docErrorsTop]
      : [];
  const allErrorMsgs = [...new Set([...docErrorsFromTop, ...docErrorsFromVs, ...docErrorsFromTrans, ...docErrorsFromOffer])].filter(Boolean);
  const mergedRejectionReason = allErrorMsgs.length > 0 ? allErrorMsgs.join('; ') : null;

  let vsValue: unknown = null;
  let vsDesc: string | null = null;
  for (const v of vsArr) {
    const val = typeof v === 'object' && v ? (v as any).value : v;
    vsValue = val;
    vsDesc = typeof v === 'object' && v ? (v as any).description : null;
    if (val === 8 || val === '8') break;
  }
  let transRejected = false;
  for (const v of transVsArr) {
    const val = typeof v === 'object' && v ? (v as any).value : v;
    if (val === 8 || val === '8') {
      transRejected = true;
      break;
    }
  }
  let offerRejected = false;
  for (const v of offerVsArr) {
    const val = typeof v === 'object' && v ? (v as any).value : v;
    if (val === 0 || val === '0' || val === 8 || val === '8') {
      offerRejected = true;
      break;
    }
  }

  const isRejected = vsValue === 8 || vsValue === '8' || transRejected || (offerRejected && allErrorMsgs.length > 0);
  const isApproved = (vsValue === 9 || vsValue === '9') && !transRejected;

  // ─── 新诊断体系（三字段严格独立解析）─────────────────────────────
  const vsItem = extractStatusObjFromRaw(validationRaw);
  const transVsItem = extractStatusObjFromRaw(translationValidationRaw);
  const offerVsItem = extractStatusObjFromRaw(offerValidationRaw);
  const offerStatusNum = raw?.status != null ? Number(raw.status) : null;
  const platformDiagnostics = buildPlatformDiagnostics(vsItem, transVsItem, offerVsItem, offerStatusNum);
  const hasPlatformAttention = platformDiagnostics.length > 0;
  const hasBlockingIssue = platformDiagnostics.some(d => d.saleImpact === 'blocked');
  const emagStatusSnapshot: EmagStatusSnapshot = {
    vs: vsItem,
    transVs: transVsItem,
    offerVs: offerVsItem,
    offerStatus: offerStatusNum,
  };
  const fallbackText = isRejected ? '待更新' : '待完善';
  const rawName = String(raw?.name ?? raw?.title ?? '').trim();
  const name = rawName || fallbackText;

  const salePrice = Number(raw?.sale_price ?? raw?.salePrice ?? raw?.main_offer_price ?? 0);
  const toNullableNumber = (...values: unknown[]): number | null => {
    for (const value of values) {
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const ownership = raw?.ownership ?? null;
  const numberOfOffers = toNullableNumber(raw?.number_of_offers, raw?.numberOfOffers);
  const bestOfferSalePrice = toNullableNumber(raw?.best_offer_sale_price, raw?.bestOfferSalePrice);
  const mainOfferPrice = toNullableNumber(raw?.main_offer_price, raw?.mainOfferPrice);
  const buyButtonRank = toNullableNumber(raw?.buy_button_rank, raw?.buyButtonRank);
  const brand = extractBrand(raw);
  // vatId：从 eMAG product_offer.vat_id 原样提取，整数 ID，不做税率换算
  const vatId = toNullableNumber(raw?.vat_id, raw?.vatId);
  const vatIdInt = vatId != null && Number.isInteger(vatId) ? vatId : null;
  const skuDisplay = sku ?? vendorSku ?? pnk;

  if (options?.logOutput !== false) {
    console.log(`[Pipeline Output] SKU: ${skuDisplay}, Image: ${mainImage ?? '(空)'}, Currency: ${currency}`);
  }

  return {
    pnk,
    sku: sku ?? null,
    vendorSku: vendorSku ?? null,
    ean: ean ?? null,
    name,
    salePrice,
    currency,
    stock,
    status: Number(raw?.status ?? 1),
    mainImage,
    productUrl,
    emagOfferId: raw?.id != null ? String(raw.id) : null,
    categoryId: raw?.category_id as number | undefined,
    validationStatus: isApproved ? 'active' : vsDesc || 'rejected',
    docErrors: isRejected ? mergedRejectionReason : null,
    rejectionReason: isRejected ? (mergedRejectionReason || vsDesc || '已驳回') : null,
    isRejected,
    ownership,
    numberOfOffers,
    bestOfferSalePrice,
    mainOfferPrice,
    buyButtonRank,
    offerValidationStatus: compactOfferValidationStatus,
    brand,
    vatId: vatIdInt,
    platformDiagnostics,
    emagStatusSnapshot,
    hasPlatformAttention,
    hasBlockingIssue,
  };
}
