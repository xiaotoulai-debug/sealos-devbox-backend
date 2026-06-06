export type EmagLinkType = 'SELF_BUILT' | 'RESELL' | 'UNKNOWN';
export type OwnershipContentPermission = 'OWNER' | 'OFFER_ONLY' | 'UNKNOWN';
export type EmagLinkTypeSource =
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
    number_of_offers?: unknown;
    numberOfOffers?: unknown;
  } | null;
  publishLog?: PublishLogLike;
};

export const LINK_TYPE_LABELS: Record<EmagLinkType, string> = {
  SELF_BUILT: '自建链接',
  RESELL: '跟卖链接',
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

/** @deprecated 使用 normalizeOwnershipContentPermission */
export function normalizeOwnership(value: unknown): EmagLinkType {
  const permission = normalizeOwnershipContentPermission(value);
  if (permission === 'OWNER') return 'SELF_BUILT';
  if (permission === 'OFFER_ONLY') return 'RESELL';
  return 'UNKNOWN';
}

/**
 * 运营口径：按 ownership 判断当前店铺资料维护权限。
 * 自建链接 = 可维护标题/图片/描述/属性；跟卖链接 = 仅报价/价格/库存；待确认 = ownership 缺失或无法识别。
 */
export function inferEmagLinkType(input: EmagLinkInferenceInput): EmagLinkTypeResult {
  const ownership = input.rawApiData?.ownership;
  const permission = normalizeOwnershipContentPermission(ownership);

  if (permission === 'OWNER') {
    return {
      linkType: 'SELF_BUILT',
      linkTypeLabel: LINK_TYPE_LABELS.SELF_BUILT,
      linkTypeSource: 'OWNERSHIP_CONTENT_PERMISSION',
      linkTypeConfidence: 'HIGH',
    };
  }

  if (permission === 'OFFER_ONLY') {
    return {
      linkType: 'RESELL',
      linkTypeLabel: LINK_TYPE_LABELS.RESELL,
      linkTypeSource: 'OWNERSHIP_CONTENT_PERMISSION',
      linkTypeConfidence: 'HIGH',
    };
  }

  return {
    linkType: 'UNKNOWN',
    linkTypeLabel: LINK_TYPE_LABELS.UNKNOWN,
    linkTypeSource: 'OWNERSHIP_UNKNOWN',
    linkTypeConfidence: 'LOW',
  };
}

export function inferContentPermission(linkType: EmagLinkType): ContentPermissionResult {
  if (linkType === 'SELF_BUILT') {
    return {
      contentPermission: 'EDITABLE',
      contentPermissionLabel: CONTENT_PERMISSION_LABELS.EDITABLE,
    };
  }

  if (linkType === 'RESELL') {
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
) {
  const linkTypeResult = inferEmagLinkType({
    shopId,
    pnk,
    rawApiData: { ownership },
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

  if (linkType === 'RESELL' && offerCompetitionType === 'COMPETITIVE') {
    return ['关注购物车', '调整报价', '控制毛利'];
  }

  if (linkType === 'SELF_BUILT' && offerCompetitionType === 'EXCLUSIVE') {
    return ['保护链接', '稳定库存', '维护资料'];
  }

  if (linkType === 'RESELL' && offerCompetitionType === 'EXCLUSIVE') {
    return ['保持报价优势', '关注库存', '控制毛利'];
  }

  if (linkType === 'SELF_BUILT' && offerCompetitionType === 'NO_ACTIVE_COMPETITION') {
    return ['保护链接', '关注库存', '维护资料'];
  }

  if (linkType === 'RESELL' && offerCompetitionType === 'NO_ACTIVE_COMPETITION') {
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
