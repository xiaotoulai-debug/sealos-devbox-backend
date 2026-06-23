export type EmagLinkType = 'SELF_BUILT' | 'RESELL' | 'OWN_BRAND_RESELL' | 'UNKNOWN';
export type OwnershipContentPermission = 'OWNER' | 'OFFER_ONLY' | 'UNKNOWN';
export type EmagLinkTypeSource =
  | 'BRAND_OWNERSHIP'
  | 'OWNERSHIP_CONTENT_PERMISSION'
  | 'OWNERSHIP_UNKNOWN'
  | 'PUBLISH_LOG'
  | 'PUBLISH_LOG_CREATE'
  | 'PUBLISH_LOG_ATTACH'
  | 'OWNERSHIP'
  | 'OWNERSHIP_FALSE'
  | 'OWNERSHIP_UNVERIFIED'
  | 'MANUAL'
  | 'UNKNOWN';
export type EmagLinkTypeConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ContentPermission = 'EDITABLE' | 'OFFER_ONLY' | 'UNKNOWN';
export type OfferCompetitionType = 'NO_ACTIVE_COMPETITION' | 'EXCLUSIVE' | 'COMPETITIVE' | 'UNKNOWN';

export type LinkTypeReason =
  | 'brand_empty'
  | 'brand_not_own'
  | 'own_brand_and_content_owner'
  | 'own_brand_but_no_content_ownership'
  | 'own_brand_ownership_unknown';

export type PublishLogLike = {
  shopId?: number | null;
  mode?: 'CREATE_PRODUCT' | 'ATTACH_EXISTING' | string | null;
  partNumberKey?: string | null;
  matchedBy?: 'EAN' | string | null;
} | null;

export type EmagLinkTypeResult = {
  linkType: EmagLinkType;
  linkTypeLabel: string;
  linkTypeSource: EmagLinkTypeSource;
  linkTypeConfidence: EmagLinkTypeConfidence;
  linkTypeReason: LinkTypeReason | null;
};

export type ContentPermissionResult = {
  contentPermission: ContentPermission;
  contentPermissionLabel: string;
};

export type OfferCompetitionResult = {
  numberOfOffers: number | null;
  offerCompetitionType: OfferCompetitionType;
  offerCompetitionLabel: string;
};

export type EmagLinkInferenceInput = {
  shopId: number;
  pnk: string;
  rawApiData?: {
    ownership?: unknown;
    brand?: unknown;
    number_of_offers?: unknown;
    numberOfOffers?: unknown;
  } | null;
  publishLog?: PublishLogLike;
};

export const OWN_BRAND_NORMALIZED = 'suootci';

export const LINK_TYPE_LABELS: Record<EmagLinkType, string> = {
  SELF_BUILT: '自建链接',
  RESELL: '跟卖链接',
  OWN_BRAND_RESELL: '自有品牌跟卖',
  UNKNOWN: '待确认',
};

export const CONTENT_PERMISSION_LABELS: Record<ContentPermission, string> = {
  EDITABLE: '可维护资料',
  OFFER_ONLY: '仅报价',
  UNKNOWN: '未知权限',
};

export const OFFER_COMPETITION_LABELS: Record<OfferCompetitionType, string> = {
  NO_ACTIVE_COMPETITION: '暂无竞争',
  EXCLUSIVE: '独家报价',
  COMPETITIVE: '多卖家竞争',
  UNKNOWN: '竞争未知',
};

export function normalizeBrand(value: unknown): string | null {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function isOwnBrand(value: unknown): boolean {
  const brand = normalizeBrand(value);
  if (!brand) return false;
  return brand.toLowerCase() === OWN_BRAND_NORMALIZED;
}

/** ownership=1/true/"1"：当前店铺拥有商品资料维护权 */
export function isOwnershipOwner(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  }
  return false;
}

/** ownership=2/false/"2"：当前店铺仅可维护报价 */
export function isOwnershipOfferOnly(value: unknown): boolean {
  if (value === false || value === 2) return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'false' || normalized === '2';
  }
  return false;
}

/** @deprecated 使用 isOwnershipOwner */
export function isOwnershipTrue(value: unknown): boolean {
  return isOwnershipOwner(value);
}

/** @deprecated 使用 isOwnershipOfferOnly */
export function isOwnershipFalse(value: unknown): boolean {
  return isOwnershipOfferOnly(value);
}

export function normalizeOwnershipContentPermission(ownership: unknown): OwnershipContentPermission {
  if (isOwnershipOwner(ownership)) return 'OWNER';
  if (isOwnershipOfferOnly(ownership)) return 'OFFER_ONLY';
  return 'UNKNOWN';
}

export function normalizeOwnershipDisplay(ownership: unknown): 1 | 2 | null {
  if (isOwnershipOwner(ownership)) return 1;
  if (isOwnershipOfferOnly(ownership)) return 2;
  return null;
}

/** @deprecated 使用 normalizeOwnershipContentPermission */
export function normalizeOwnership(value: unknown): EmagLinkType {
  const permission = normalizeOwnershipContentPermission(value);
  if (permission === 'OWNER') return 'SELF_BUILT';
  if (permission === 'OFFER_ONLY') return 'RESELL';
  return 'UNKNOWN';
}

/**
 * 运营口径：brand + ownership 组合判断当前店铺链接身份。
 * 非 SuooTci 品牌绝对跟卖；SuooTci + ownership=1 为自建；SuooTci + ownership=2 为自有品牌跟卖。
 */
export function inferEmagLinkType(input: EmagLinkInferenceInput): EmagLinkTypeResult {
  const brand = normalizeBrand(input.rawApiData?.brand);
  const ownership = input.rawApiData?.ownership;
  const permission = normalizeOwnershipContentPermission(ownership);

  if (!brand) {
    return {
      linkType: 'UNKNOWN',
      linkTypeLabel: LINK_TYPE_LABELS.UNKNOWN,
      linkTypeSource: 'BRAND_OWNERSHIP',
      linkTypeConfidence: 'LOW',
      linkTypeReason: 'brand_empty',
    };
  }

  if (!isOwnBrand(brand)) {
    return {
      linkType: 'RESELL',
      linkTypeLabel: LINK_TYPE_LABELS.RESELL,
      linkTypeSource: 'BRAND_OWNERSHIP',
      linkTypeConfidence: 'HIGH',
      linkTypeReason: 'brand_not_own',
    };
  }

  if (permission === 'OWNER') {
    return {
      linkType: 'SELF_BUILT',
      linkTypeLabel: LINK_TYPE_LABELS.SELF_BUILT,
      linkTypeSource: 'BRAND_OWNERSHIP',
      linkTypeConfidence: 'HIGH',
      linkTypeReason: 'own_brand_and_content_owner',
    };
  }

  if (permission === 'OFFER_ONLY') {
    return {
      linkType: 'OWN_BRAND_RESELL',
      linkTypeLabel: LINK_TYPE_LABELS.OWN_BRAND_RESELL,
      linkTypeSource: 'BRAND_OWNERSHIP',
      linkTypeConfidence: 'HIGH',
      linkTypeReason: 'own_brand_but_no_content_ownership',
    };
  }

  return {
    linkType: 'UNKNOWN',
    linkTypeLabel: LINK_TYPE_LABELS.UNKNOWN,
    linkTypeSource: 'BRAND_OWNERSHIP',
    linkTypeConfidence: 'LOW',
    linkTypeReason: 'own_brand_ownership_unknown',
  };
}

export function inferContentPermission(linkType: EmagLinkType): ContentPermissionResult {
  if (linkType === 'SELF_BUILT') {
    return {
      contentPermission: 'EDITABLE',
      contentPermissionLabel: CONTENT_PERMISSION_LABELS.EDITABLE,
    };
  }

  if (linkType === 'RESELL' || linkType === 'OWN_BRAND_RESELL') {
    return {
      contentPermission: 'OFFER_ONLY',
      contentPermissionLabel: CONTENT_PERMISSION_LABELS.OFFER_ONLY,
    };
  }

  return {
    contentPermission: 'UNKNOWN',
    contentPermissionLabel: CONTENT_PERMISSION_LABELS.UNKNOWN,
  };
}

export function buildLinkTypeUpdateFromOwnership(
  shopId: number,
  pnk: string,
  ownership: unknown,
  offerCompetitionType: OfferCompetitionType,
  brand?: unknown,
) {
  const linkTypeResult = inferEmagLinkType({
    shopId,
    pnk,
    rawApiData: { ownership, brand },
    publishLog: null,
  });
  const contentPermission = inferContentPermission(linkTypeResult.linkType);
  const linkActionTips = inferLinkActionTips(linkTypeResult.linkType, offerCompetitionType);

  return {
    emagLinkType: linkTypeResult.linkType,
    emagLinkTypeSource: linkTypeResult.linkTypeSource,
    emagLinkTypeConfidence: linkTypeResult.linkTypeConfidence,
    contentPermission: contentPermission.contentPermission,
    linkActionTips,
    linkTypeReason: linkTypeResult.linkTypeReason,
  };
}

export function inferOfferCompetition(rawApiData?: { number_of_offers?: unknown; numberOfOffers?: unknown } | null): OfferCompetitionResult {
  const rawCount = rawApiData?.number_of_offers ?? rawApiData?.numberOfOffers;
  if (rawCount == null || rawCount === '') {
    return {
      numberOfOffers: null,
      offerCompetitionType: 'UNKNOWN',
      offerCompetitionLabel: OFFER_COMPETITION_LABELS.UNKNOWN,
    };
  }

  const count = Number(rawCount);
  if (!Number.isFinite(count) || count < 0) {
    return {
      numberOfOffers: null,
      offerCompetitionType: 'UNKNOWN',
      offerCompetitionLabel: OFFER_COMPETITION_LABELS.UNKNOWN,
    };
  }

  if (count === 0) {
    return {
      numberOfOffers: 0,
      offerCompetitionType: 'NO_ACTIVE_COMPETITION',
      offerCompetitionLabel: OFFER_COMPETITION_LABELS.NO_ACTIVE_COMPETITION,
    };
  }

  if (count === 1) {
    return {
      numberOfOffers: 1,
      offerCompetitionType: 'EXCLUSIVE',
      offerCompetitionLabel: OFFER_COMPETITION_LABELS.EXCLUSIVE,
    };
  }

  return {
    numberOfOffers: Math.trunc(count),
    offerCompetitionType: 'COMPETITIVE',
    offerCompetitionLabel: OFFER_COMPETITION_LABELS.COMPETITIVE,
  };
}

export function inferLinkActionTips(linkType: EmagLinkType, offerCompetitionType: OfferCompetitionType): string[] {
  if (linkType === 'SELF_BUILT' && offerCompetitionType === 'COMPETITIVE') {
    return ['投诉卖家', '检查乱价', '维护品牌'];
  }

  if ((linkType === 'RESELL' || linkType === 'OWN_BRAND_RESELL') && offerCompetitionType === 'COMPETITIVE') {
    return linkType === 'OWN_BRAND_RESELL'
      ? ['关注自有品牌跟卖', '调整报价', '控制毛利']
      : ['关注购物车', '调整报价', '控制毛利'];
  }

  if (linkType === 'SELF_BUILT' && offerCompetitionType === 'EXCLUSIVE') {
    return ['保护链接', '稳定库存', '维护资料'];
  }

  if ((linkType === 'RESELL' || linkType === 'OWN_BRAND_RESELL') && offerCompetitionType === 'EXCLUSIVE') {
    return ['保持报价优势', '关注库存', '控制毛利'];
  }

  if (linkType === 'SELF_BUILT' && offerCompetitionType === 'NO_ACTIVE_COMPETITION') {
    return ['保护链接', '关注库存', '维护资料'];
  }

  if ((linkType === 'RESELL' || linkType === 'OWN_BRAND_RESELL') && offerCompetitionType === 'NO_ACTIVE_COMPETITION') {
    return ['关注库存', '保持报价优势', '观察链接状态'];
  }

  if (linkType === 'UNKNOWN' && offerCompetitionType === 'NO_ACTIVE_COMPETITION') {
    return ['确认链接来源', '观察库存状态'];
  }

  if (linkType === 'UNKNOWN' && offerCompetitionType === 'COMPETITIVE') {
    return ['确认链接来源', '关注购物车', '检查报价'];
  }

  return ['确认链接来源', '检查资料权限'];
}

export type BrandSource = 'API' | 'EXISTING_META' | 'EMPTY';

export function resolveBrandFromOfferMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  return normalizeBrand((meta as Record<string, unknown>).brand);
}

/** 只读已有 emagOfferMeta.brand，兼容 null / 非对象 / 数组 */
export function getExistingOfferMetaBrand(meta: unknown): string | null {
  return resolveBrandFromOfferMeta(meta);
}

/** 只读已有 emagOfferMeta.linkTypeReason，兼容 null / 非对象 / 数组 */
export function getExistingLinkTypeReason(meta: unknown): LinkTypeReason | null {
  return resolveLinkTypeReasonFromOfferMeta(meta);
}

/**
 * 同步时合并 brand：API 有值优先；API 为空则保留 DB 已有 brand，禁止写 null 覆盖。
 */
export function resolveEffectiveBrandForSync(
  apiBrand: unknown,
  existingMeta: unknown,
): { effectiveBrand: string | null; brandSource: BrandSource } {
  const normalizedApi = normalizeBrand(apiBrand);
  if (normalizedApi) {
    return { effectiveBrand: normalizedApi, brandSource: 'API' };
  }
  const existingBrand = getExistingOfferMetaBrand(existingMeta);
  if (existingBrand) {
    return { effectiveBrand: existingBrand, brandSource: 'EXISTING_META' };
  }
  return { effectiveBrand: null, brandSource: 'EMPTY' };
}

/** 同步时合并 ownership：本次 API 有值优先，否则回退 DB 已有 emagOwnership */
export function resolveEffectiveOwnershipForSync(
  apiOwnership: unknown,
  existingOwnership: unknown,
): unknown {
  if (apiOwnership !== undefined && apiOwnership !== null) return apiOwnership;
  return existingOwnership ?? null;
}

export function resolveLinkTypeReasonFromOfferMeta(meta: unknown): LinkTypeReason | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const reason = (meta as Record<string, unknown>).linkTypeReason;
  if (
    reason === 'brand_empty'
    || reason === 'brand_not_own'
    || reason === 'own_brand_and_content_owner'
    || reason === 'own_brand_but_no_content_ownership'
    || reason === 'own_brand_ownership_unknown'
  ) {
    return reason;
  }
  return null;
}
