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
  const sku = raw?.part_number != null ? String(raw.part_number).trim() : null;
  const vendorSku = sku;

  const eanRaw = raw?.ean;
  const ean =
    Array.isArray(eanRaw) && eanRaw.length > 0
      ? eanRaw
          .map((x: unknown) => (typeof x === 'string' ? x : (x as any)?.value ?? (x as any)?.ean ?? String(x)))
          .filter(Boolean)
          .join(', ') || null
      : typeof eanRaw === 'string' && eanRaw.trim()
        ? eanRaw.trim()
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

  // 校验状态
  const vsRaw = raw?.validation_status ?? raw?.offer_validation_status;
  const vsArr = Array.isArray(vsRaw) ? vsRaw : vsRaw ? [vsRaw] : [];
  const transVsRaw = raw?.translation_validation_status;
  const transVsArr = Array.isArray(transVsRaw) ? transVsRaw : transVsRaw ? [transVsRaw] : [];
  const offerVs = raw?.offer_validation_status;
  const offerVsArr = Array.isArray(offerVs) ? offerVs : offerVs ? [offerVs] : [];

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
  const fallbackText = isRejected ? '待更新' : '待完善';
  const rawName = String(raw?.name ?? raw?.title ?? '').trim();
  const name = rawName || fallbackText;

  const salePrice = Number(raw?.sale_price ?? raw?.salePrice ?? raw?.main_offer_price ?? 0);
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
  };
}
