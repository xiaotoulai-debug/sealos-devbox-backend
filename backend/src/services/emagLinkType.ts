export type EmagLinkType = 'SELF_BUILT' | 'RESELL' | 'UNKNOWN';
export type EmagLinkTypeSource = 'PUBLISH_LOG' | 'OWNERSHIP' | 'MANUAL' | 'UNKNOWN';
export type EmagLinkTypeConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type ContentPermission = 'EDITABLE' | 'OFFER_ONLY' | 'UNKNOWN';
export type OfferCompetitionType = 'NO_ACTIVE_COMPETITION' | 'EXCLUSIVE' | 'COMPETITIVE' | 'UNKNOWN';

export type PublishLogLike = {
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

export function normalizeOwnership(value: unknown): EmagLinkType {
  if (value === true || value === 1) return 'SELF_BUILT';
  if (value === false || value === 2) return 'RESELL';

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return 'SELF_BUILT';
    if (normalized === 'false' || normalized === '2') return 'RESELL';
  }

  return 'UNKNOWN';
}

export function inferEmagLinkType(input: EmagLinkInferenceInput): EmagLinkTypeResult {
  const publishLog = input.publishLog;
  if (publishLog) {
    const mode = String(publishLog.mode ?? '').trim().toUpperCase();
    const partNumberKey = String(publishLog.partNumberKey ?? '').trim();
    const matchedBy = String(publishLog.matchedBy ?? '').trim().toUpperCase();

    if (mode === 'CREATE_PRODUCT' && !partNumberKey) {
      return {
        linkType: 'SELF_BUILT',
        linkTypeLabel: LINK_TYPE_LABELS.SELF_BUILT,
        linkTypeSource: 'PUBLISH_LOG',
        linkTypeConfidence: 'HIGH',
      };
    }

    if (mode === 'ATTACH_EXISTING' || partNumberKey || matchedBy === 'EAN') {
      return {
        linkType: 'RESELL',
        linkTypeLabel: LINK_TYPE_LABELS.RESELL,
        linkTypeSource: 'PUBLISH_LOG',
        linkTypeConfidence: 'HIGH',
      };
    }
  }

  const linkType = normalizeOwnership(input.rawApiData?.ownership);
  if (linkType !== 'UNKNOWN') {
    return {
      linkType,
      linkTypeLabel: LINK_TYPE_LABELS[linkType],
      linkTypeSource: 'OWNERSHIP',
      linkTypeConfidence: 'MEDIUM',
    };
  }

  return {
    linkType: 'UNKNOWN',
    linkTypeLabel: LINK_TYPE_LABELS.UNKNOWN,
    linkTypeSource: 'UNKNOWN',
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

  return ['确认链接来源', '检查资料权限'];
}
