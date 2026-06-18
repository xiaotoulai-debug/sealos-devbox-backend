import axios, { type AxiosInstance } from 'axios';
import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';

const COMMISSION_ESTIMATE_TIMEOUT_MS = 60_000;

let _commissionAxios: AxiosInstance | null = null;
let _cachedProxyAgent: any = undefined;
let _proxyInitialized = false;

export type CommissionEstimateResult = {
  ok: boolean;
  extId: string;
  rawValue: number | null;
  commissionRate: number | null;
  rawResponse: unknown;
  errorCode?: string;
  errorMessage?: string;
};

export type SyncStoreProductCommissionRateResult = {
  ok: boolean;
  storeProductId: number;
  shopId: number;
  extId: string | null;
  oldCommissionRate: number | null;
  newCommissionRate: number | null;
  rawValue: number | null;
  updated: boolean;
  dryRun: boolean;
  rawResponse?: unknown;
  errorCode?: string;
  errorMessage?: string;
};

export type BatchSyncCommissionItemResult = {
  storeProductId: number;
  sku: string | null;
  emagOfferId: string | null;
  oldCommissionRate: number | null;
  newCommissionRate: number | null;
  status: 'PLANNED' | 'SUCCESS' | 'SKIPPED' | 'FAILED';
  message?: string;
};

export type BatchSyncCommissionRateResult = {
  shopId: number;
  dryRun: boolean;
  totalScanned: number;
  planned: number;
  success: number;
  skipped: number;
  failed: number;
  items: BatchSyncCommissionItemResult[];
};

function getCommissionAxios(): AxiosInstance {
  if (!_commissionAxios) {
    _commissionAxios = axios.create({
      timeout: COMMISSION_ESTIMATE_TIMEOUT_MS,
      validateStatus: () => true,
    });
  }
  return _commissionAxios;
}

function getEmagProxyAgentForCommission(): any {
  if (_proxyInitialized) return _cachedProxyAgent;
  _proxyInitialized = true;

  const proxyUrl = process.env.EMAG_PROXY_URL?.trim();
  if (!proxyUrl) {
    _cachedProxyAgent = null;
    return null;
  }

  try {
    const HttpsProxyAgent = require('https-proxy-agent');
    const createAgent = typeof HttpsProxyAgent === 'function'
      ? HttpsProxyAgent
      : HttpsProxyAgent.default ?? HttpsProxyAgent.HttpsProxyAgent;
    _cachedProxyAgent = createAgent(proxyUrl);
  } catch (err) {
    console.error('[eMAG commission] 代理初始化失败:', err instanceof Error ? err.message : err);
    _cachedProxyAgent = null;
  }

  return _cachedProxyAgent;
}

function toApiV1BaseUrl(api3BaseUrl: string): string {
  return api3BaseUrl.replace(/\/api-3$/, '/api/v1');
}

function normalizeExtId(extId: number | string): string | null {
  const normalized = String(extId ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  if (!Number.isInteger(n) || n <= 0) return null;
  return normalized;
}

function parseCommissionEstimateValue(raw: unknown): { rawValue: number; commissionRate: number } | null {
  const rawValue = Number(raw);
  if (!Number.isFinite(rawValue) || rawValue <= 0 || rawValue > 100) return null;
  return {
    rawValue,
    commissionRate: rawValue / 100,
  };
}

export async function fetchCommissionEstimate(
  shopId: number,
  extId: number | string,
): Promise<CommissionEstimateResult> {
  const normalizedExtId = normalizeExtId(extId);
  if (!normalizedExtId) {
    return {
      ok: false,
      extId: String(extId ?? ''),
      rawValue: null,
      commissionRate: null,
      rawResponse: null,
      errorCode: 'INVALID_EXT_ID',
      errorMessage: 'extId 必须是正整数',
    };
  }

  const creds = await getEmagCredentials(shopId);
  const url = `${toApiV1BaseUrl(creds.baseUrl)}/commission/estimate/${normalizedExtId}`;
  const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const proxyAgent = getEmagProxyAgentForCommission();

  try {
    const resp = await getCommissionAxios().get(url, {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: 'application/json',
      },
      ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
    });

    const body = resp.data;
    const parsedValue = parseCommissionEstimateValue(body?.data?.value ?? body?.value ?? null);
    if (resp.status === 401) {
      return {
        ok: false,
        extId: normalizedExtId,
        rawValue: null,
        commissionRate: null,
        rawResponse: body,
        errorCode: 'UNAUTHORIZED',
        errorMessage: 'eMAG commission/estimate 认证失败',
      };
    }
    if (resp.status === 404) {
      return {
        ok: false,
        extId: normalizedExtId,
        rawValue: null,
        commissionRate: null,
        rawResponse: body,
        errorCode: 'NOT_FOUND',
        errorMessage: `eMAG commission/estimate 未找到 extId=${normalizedExtId}`,
      };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return {
        ok: false,
        extId: normalizedExtId,
        rawValue: null,
        commissionRate: null,
        rawResponse: body,
        errorCode: `HTTP_${resp.status}`,
        errorMessage: typeof body?.message === 'string' ? body.message : `HTTP ${resp.status}`,
      };
    }
    if (body?.code != null && Number(body.code) !== 200) {
      return {
        ok: false,
        extId: normalizedExtId,
        rawValue: null,
        commissionRate: null,
        rawResponse: body,
        errorCode: String(body.code),
        errorMessage: typeof body?.message === 'string' ? body.message : 'commission/estimate 返回非 200 code',
      };
    }
    if (!parsedValue) {
      return {
        ok: false,
        extId: normalizedExtId,
        rawValue: null,
        commissionRate: null,
        rawResponse: body,
        errorCode: 'INVALID_COMMISSION_VALUE',
        errorMessage: 'commission/estimate 返回 value 缺失或不在 (0,100] 范围',
      };
    }

    return {
      ok: true,
      extId: normalizedExtId,
      rawValue: parsedValue.rawValue,
      commissionRate: parsedValue.commissionRate,
      rawResponse: body,
    };
  } catch (err: any) {
    return {
      ok: false,
      extId: normalizedExtId,
      rawValue: null,
      commissionRate: null,
      rawResponse: null,
      errorCode: err?.code ?? 'NETWORK_ERROR',
      errorMessage: err?.message ?? 'commission/estimate 请求失败',
    };
  }
}

export async function syncStoreProductCommissionRate(params: {
  shopId: number;
  storeProductId: number;
  dryRun?: boolean;
}): Promise<SyncStoreProductCommissionRateResult> {
  const dryRun = params.dryRun !== false;
  const storeProduct = await prisma.storeProduct.findFirst({
    where: { id: params.storeProductId, shopId: params.shopId, isArchived: false },
    select: {
      id: true,
      shopId: true,
      emagOfferId: true,
      commissionRate: true,
    },
  });

  if (!storeProduct) {
    return {
      ok: false,
      storeProductId: params.storeProductId,
      shopId: params.shopId,
      extId: null,
      oldCommissionRate: null,
      newCommissionRate: null,
      rawValue: null,
      updated: false,
      dryRun,
      errorCode: 'STORE_PRODUCT_NOT_FOUND',
      errorMessage: 'StoreProduct 不存在或 shopId 不匹配',
    };
  }

  if (!storeProduct.emagOfferId || !normalizeExtId(storeProduct.emagOfferId)) {
    return {
      ok: false,
      storeProductId: storeProduct.id,
      shopId: storeProduct.shopId,
      extId: storeProduct.emagOfferId,
      oldCommissionRate: storeProduct.commissionRate,
      newCommissionRate: null,
      rawValue: null,
      updated: false,
      dryRun,
      errorCode: 'MISSING_EMAG_OFFER_ID',
      errorMessage: 'StoreProduct.emagOfferId 缺失或无效',
    };
  }

  const estimate = await fetchCommissionEstimate(storeProduct.shopId, storeProduct.emagOfferId);
  if (!estimate.ok || estimate.commissionRate == null) {
    return {
      ok: false,
      storeProductId: storeProduct.id,
      shopId: storeProduct.shopId,
      extId: estimate.extId,
      oldCommissionRate: storeProduct.commissionRate,
      newCommissionRate: null,
      rawValue: estimate.rawValue,
      updated: false,
      dryRun,
      rawResponse: estimate.rawResponse,
      errorCode: estimate.errorCode,
      errorMessage: estimate.errorMessage,
    };
  }

  const oldCommissionRate = storeProduct.commissionRate;
  const newCommissionRate = estimate.commissionRate;

  if (dryRun) {
    return {
      ok: true,
      storeProductId: storeProduct.id,
      shopId: storeProduct.shopId,
      extId: estimate.extId,
      oldCommissionRate,
      newCommissionRate,
      rawValue: estimate.rawValue,
      updated: false,
      dryRun: true,
      rawResponse: estimate.rawResponse,
    };
  }

  await prisma.storeProduct.update({
    where: { id: storeProduct.id },
    data: { commissionRate: newCommissionRate },
  });

  return {
    ok: true,
    storeProductId: storeProduct.id,
    shopId: storeProduct.shopId,
    extId: estimate.extId,
    oldCommissionRate,
    newCommissionRate,
    rawValue: estimate.rawValue,
    updated: true,
    dryRun: false,
    rawResponse: estimate.rawResponse,
  };
}

/**
 * 批量同步指定店铺的 commissionRate。
 * - 只处理有 emagOfferId 的 StoreProduct。
 * - 优先处理 commissionRate 为 null 的产品（排前面）。
 * - dryRun=true 只返回计划，不写库。
 * - 并发限制 3，单个失败不中断整体。
 */
export async function batchSyncCommissionRate(params: {
  shopId: number;
  dryRun?: boolean;
  limit?: number;
}): Promise<BatchSyncCommissionRateResult> {
  const { shopId } = params;
  const dryRun = params.dryRun !== false;
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const CONCURRENCY = 3;

  // 查询：有 emagOfferId 的产品，commissionRate 为 null 的排前面
  // PostgreSQL 默认 ASC 是 nulls last，必须显式指定 nulls: 'first'
  const candidates = await prisma.storeProduct.findMany({
    where: {
      shopId,
      isArchived: false,
      emagOfferId: { not: null },
    },
    select: {
      id: true,
      sku: true,
      emagOfferId: true,
      commissionRate: true,
    },
    orderBy: [
      { commissionRate: { sort: 'asc', nulls: 'first' } },
    ],
    take: limit,
  });

  const result: BatchSyncCommissionRateResult = {
    shopId,
    dryRun,
    totalScanned: candidates.length,
    planned: 0,
    success: 0,
    skipped: 0,
    failed: 0,
    items: [],
  };

  if (candidates.length === 0) return result;

  // 并发限流器：每次最多 CONCURRENCY 个并行请求
  const tasks = [...candidates];
  while (tasks.length > 0) {
    const batch = tasks.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(async (sp) => {
        const extId = sp.emagOfferId ? normalizeExtId(sp.emagOfferId) : null;
        if (!extId) {
          result.skipped++;
          result.items.push({
            storeProductId: sp.id,
            sku: sp.sku,
            emagOfferId: sp.emagOfferId,
            oldCommissionRate: sp.commissionRate,
            newCommissionRate: null,
            status: 'SKIPPED',
            message: 'emagOfferId 缺失或无效',
          });
          return;
        }

        const estimate = await fetchCommissionEstimate(shopId, extId);
        if (!estimate.ok || estimate.commissionRate == null) {
          result.failed++;
          result.items.push({
            storeProductId: sp.id,
            sku: sp.sku,
            emagOfferId: sp.emagOfferId,
            oldCommissionRate: sp.commissionRate,
            newCommissionRate: null,
            status: 'FAILED',
            message: estimate.errorMessage ?? `commission/estimate 失败 [${estimate.errorCode}]`,
          });
          return;
        }

        if (dryRun) {
          result.planned++;
          result.items.push({
            storeProductId: sp.id,
            sku: sp.sku,
            emagOfferId: sp.emagOfferId,
            oldCommissionRate: sp.commissionRate,
            newCommissionRate: estimate.commissionRate,
            status: 'PLANNED',
          });
          return;
        }

        try {
          await prisma.storeProduct.update({
            where: { id: sp.id },
            data: { commissionRate: estimate.commissionRate },
          });
          result.success++;
          result.items.push({
            storeProductId: sp.id,
            sku: sp.sku,
            emagOfferId: sp.emagOfferId,
            oldCommissionRate: sp.commissionRate,
            newCommissionRate: estimate.commissionRate,
            status: 'SUCCESS',
          });
        } catch (dbErr: any) {
          result.failed++;
          result.items.push({
            storeProductId: sp.id,
            sku: sp.sku,
            emagOfferId: sp.emagOfferId,
            oldCommissionRate: sp.commissionRate,
            newCommissionRate: estimate.commissionRate,
            status: 'FAILED',
            message: `数据库写入失败: ${dbErr?.message ?? String(dbErr)}`,
          });
        }
      }),
    );
  }

  return result;
}
