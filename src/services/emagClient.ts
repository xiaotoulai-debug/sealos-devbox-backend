import axios from 'axios';
import { prisma } from '../lib/prisma';
import { decrypt } from '../utils/shopCrypto';
import { updateRateLimitFromHeaders, shouldDelayNextSync, setDelayMultiplier } from './emagRateLimit';

// ═══════════════════════════════════════════════════════════════════
// 代理策略：物理隔离，仅在 emagApiCall 内部按需构建 httpsAgent
//
// 全局 axios.defaults  → 绝不触碰
// http.globalAgent      → 绝不触碰
// https.globalAgent     → 绝不触碰
// 模块顶层             → 不做任何代理初始化（防止加载失败拖垮 Express）
//
// 代理仅在 emagApiCall() 的 per-request 配置中注入 httpsAgent，
// auth/login、1688、数据库等所有其他请求完全不受影响。
// ═══════════════════════════════════════════════════════════════════

/** 懒加载的代理 Agent 缓存（首次 eMAG 请求时才初始化，而非模块加载时）*/
let _cachedProxyAgent: any = undefined;     // undefined=未初始化, null=无代理/初始化失败, Agent=可用
let _proxyInitialized = false;

/**
 * 懒加载获取 eMAG 专属 httpsAgent（首次调用时才 require + 初始化）
 * 返回 Agent 实例或 null（无代理配置/初始化失败时直连）
 * 绝不修改全局任何对象
 */
function getEmagProxyAgent(): any {
  if (_proxyInitialized) return _cachedProxyAgent;
  _proxyInitialized = true;

  const proxyUrl = process.env.EMAG_PROXY_URL?.trim();
  if (!proxyUrl) {
    _cachedProxyAgent = null;
    return null;
  }

  try {
    // 延迟 require，模块加载阶段完全无副作用
    const HttpsProxyAgent = require('https-proxy-agent');
    const createAgent = typeof HttpsProxyAgent === 'function' ? HttpsProxyAgent
      : HttpsProxyAgent.default ?? HttpsProxyAgent.HttpsProxyAgent;
    _cachedProxyAgent = createAgent(proxyUrl);
    const masked = proxyUrl.replace(/:([^@/]+)@/, ':***@');
    console.log(`[eMAG 代理] 已就绪（仅用于 eMAG API 请求）: ${masked}`);
  } catch (e) {
    console.error('[eMAG 代理] 初始化失败，eMAG 请求将直连:', e instanceof Error ? e.message : e);
    _cachedProxyAgent = null;
  }

  return _cachedProxyAgent;
}

// ═══════════════════════════════════════════════════════════════════
// eMAG Marketplace API v4.5.0 — 核心客户端
//
//  架构: 无全局单例，每次调用通过 getEmagCredentials(shopId) 实时读取
//        shop.region，动态分配 BaseURL（.ro / .bg / .hu）
//  认证: Basic Authorization  base64(username:password)
//  规范: 所有请求均为 POST, 业务参数包裹在 mandatory "data" key 中
//  响应: 统一检查 isError === false
//  限流: Orders 12 req/sec, 其他 3 req/sec
//  安全: 密码从 AES-256 加密存储读取, Authorization 报头绝不明文输出
//  错误: 401/403/404 绝不静默，抛出并 [EMAG API ERROR] 大写打印
// ═══════════════════════════════════════════════════════════════════

// ─── 全局 eMAG API 适配器配置（单一数据源，无硬编码）────────────────

export type EmagRegion = 'RO' | 'BG' | 'HU';

/** BaseURL 后缀映射，Adapter 通过 shop.region 查表获取，禁止 if/else 特判 */
export const REGION_BASE_SUFFIX: Record<EmagRegion, string> = {
  RO: '.ro',
  BG: '.bg',
  HU: '.hu',
};

/** 站点货币映射（保加利亚 2026 年加入欧元区，BG 已切换为 EUR） */
export const REGION_CURRENCY: Record<EmagRegion, string> = {
  RO: 'RON',
  BG: 'EUR',
  HU: 'HUF',
};

/** 站点前台域名（商品页 URL） */
export const REGION_DOMAIN: Record<EmagRegion, string> = {
  RO: 'emag.ro',
  BG: 'emag.bg',
  HU: 'emag.hu',
};

/** API BaseURL 完整映射，由 REGION_BASE_SUFFIX 推导 */
const REGION_ENDPOINTS: Record<EmagRegion, string> = {
  RO: 'https://marketplace-api.emag.ro/api-3',
  BG: 'https://marketplace-api.emag.bg/api-3',
  HU: 'https://marketplace-api.emag.hu/api-3',
};

const SANDBOX_ENDPOINTS: Record<EmagRegion, string> = {
  RO: 'https://sandbox-marketplace-api.emag.ro/api-3',
  BG: 'https://sandbox-marketplace-api.emag.bg/api-3',
  HU: 'https://sandbox-marketplace-api.emag.hu/api-3',
};

export function resolveRegion(shopName: string): EmagRegion {
  const upper = shopName.toUpperCase();
  if (upper.includes('BG') || upper.includes('保加利亚') || upper.includes('BULGAR')) return 'BG';
  if (upper.includes('HU') || upper.includes('匈牙利') || upper.includes('HUNGAR')) return 'HU';
  return 'RO';
}

// ─── 令牌桶限流器 (线程安全的串行队列) ───────────────────────────
//
// 多个并发 acquire() 通过 FIFO 队列排队, 保证不超发令牌

class TokenBucketThrottle {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefill: number;
  private pending: Array<() => void> = [];
  private draining = false;

  constructor(maxPerSecond: number) {
    this.maxTokens = maxPerSecond;
    this.tokens = maxPerSecond;
    this.refillRate = maxPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
      this.drain();
    });
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;

    const tick = () => {
      this.refill();
      while (this.pending.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this.pending.shift()!();
      }
      if (this.pending.length > 0) {
        const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
        setTimeout(tick, Math.max(waitMs, 10));
      } else {
        this.draining = false;
      }
    };
    tick();
  }
}

const orderThrottle   = new TokenBucketThrottle(12);  // Orders: 12 req/sec
const generalThrottle = new TokenBucketThrottle(3);   // 其他: 3 req/sec

/** 并发限制：同一时间最多 5 个请求 */
const MAX_CONCURRENT = 5;
let concurrentCount = 0;
const concurrentQueue: Array<() => void> = [];

async function acquireConcurrent(): Promise<void> {
  if (concurrentCount < MAX_CONCURRENT) {
    concurrentCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    concurrentQueue.push(resolve);
  });
  concurrentCount++;
}

function releaseConcurrent(): void {
  concurrentCount--;
  if (concurrentQueue.length > 0) {
    const next = concurrentQueue.shift();
    if (next) next();
  }
}

function isOrderRoute(resource: string): boolean {
  return resource.startsWith('order');
}

// ─── eMAG API 响应类型 ──────────────────────────────────────────

export interface EmagApiResponse<T = any> {
  isError: boolean;
  messages?: string[];
  results?: T;
  errors?: any[];
}

// ─── 凭证加载 ────────────────────────────────────────────────────

export interface EmagCredentials {
  shopId: number;
  username: string;
  password: string;
  baseUrl: string;
  region: EmagRegion;
  isSandbox: boolean;
}

/**
 * 获取数据库中第一个已授权的 eMAG 店铺 ID（用于 shopId 未传时的默认值）
 */
export async function getFirstEmagShopId(): Promise<number | null> {
  const shop = await prisma.shopAuthorization.findFirst({
    where: { platform: { equals: 'emag', mode: 'insensitive' } },
    select: { id: true },
  });
  return shop?.id ?? null;
}

/**
 * 创建 eMAG 客户端（通用 Adapter，无 region 特判）
 * 等价于 getEmagCredentials，BaseURL 完全依赖 shop.region 查表
 */
export async function createEmagClient(shopId: number): Promise<EmagCredentials> {
  return getEmagCredentials(shopId);
}

/**
 * 从数据库加密存储中读取 eMAG 店铺凭证
 * 密码经 AES-256-CBC 解密, 绝不记录明文
 * BaseURL 根据店铺 region 字段动态选择，未设置时默认 RO
 */
export async function getEmagCredentials(shopId: number): Promise<EmagCredentials> {
  const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`店铺 ID ${shopId} 不存在`);
  if (shop.platform.toLowerCase() !== 'emag') throw new Error(`店铺 "${shop.shopName}" 不是 eMAG 平台`);

  const username = decrypt(shop.apiKey);
  const password = decrypt(shop.apiSecret);
  // 无 region 时默认 RO，保证老店不掉线（https://marketplace-api.emag.ro）
  const region: EmagRegion = shop.region && ['RO', 'BG', 'HU'].includes(shop.region)
    ? (shop.region as EmagRegion)
    : 'RO';
  const baseUrl  = shop.isSandbox ? SANDBOX_ENDPOINTS[region] : REGION_ENDPOINTS[region];

  return { shopId, username, password, baseUrl, region, isSandbox: shop.isSandbox };
}

// ─── 安全日志 (脱敏) ─────────────────────────────────────────────

function safeLogTag(creds: EmagCredentials): string {
  const u = creds.username.length > 4
    ? creds.username.slice(0, 2) + '***' + creds.username.slice(-2)
    : '****';
  return `[eMAG shop=${creds.shopId} ${creds.region}${creds.isSandbox ? '/sandbox' : ''} user=${u}]`;
}

/**
 * 从 axios 错误中安全提取信息, 剥离 Authorization 报头
 */
function safeErrorDetail(err: any): string {
  const respData = err.response?.data;
  if (respData) {
    const msgs = respData.messages ?? respData.errors ?? respData;
    return typeof msgs === 'string' ? msgs : JSON.stringify(msgs).slice(0, 600);
  }
  return err.message ?? 'Unknown error';
}

// ─── 核心 POST 请求 ─────────────────────────────────────────────
//
// eMAG API v4.5.0:
//   - 所有接口均为 POST
//   - Body 必须包含 mandatory "data" key: { data: <业务参数> }
//   - 认证: Authorization: Basic base64(username:password)
//   - 响应: { isError: bool, messages: [], results: ..., errors: [] }

const MAX_RETRIES_429 = 5;
const BACKOFF_BASE_MS = 1000;

// 网络层可重试的错误码（代理超时、连接重置等）
const RETRYABLE_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET',
]);
const MAX_NET_RETRIES = 3;
const NET_RETRY_DELAY_MS = 3000;

function isRetryableNetworkError(err: any): boolean {
  const code = err?.code ?? err?.cause?.code ?? '';
  if (RETRYABLE_NET_CODES.has(code)) return true;
  const msg = String(err?.message ?? '');
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|stream has been aborted/i.test(msg);
}

export async function emagApiCall<T = any>(
  creds: EmagCredentials,
  resource: string,
  action: string,
  data: any = {},
  options: { timeout?: number } = {},
): Promise<EmagApiResponse<T>> {
  const throttle = isOrderRoute(resource) ? orderThrottle : generalThrottle;
  await throttle.acquire();
  await acquireConcurrent();

  const url = `${creds.baseUrl}/${resource}/${action}`;
  const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const tag = safeLogTag(creds);

  console.log(`[eMAG] POST ${url}  shop=${creds.region} resource=${resource}/${action}`);

  const doRequest = async (): Promise<{ data: any; headers: Record<string, any>; status: number }> => {
    const proxyAgent = getEmagProxyAgent();

    const resp = await axios.post(url, { data }, {
      headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/json' },
      timeout: options.timeout ?? 30000,
      validateStatus: () => true,
      ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
    });
    return { data: resp.data, headers: resp.headers ?? {}, status: resp.status };
  };

  /**
   * 带网络层自动重试的请求执行器
   * ETIMEDOUT / ECONNRESET / socket hang up → 等待 3 秒后重试，最多 3 次
   */
  const doRequestWithNetRetry = async (): Promise<{ data: any; headers: Record<string, any>; status: number }> => {
    for (let netAttempt = 0; netAttempt < MAX_NET_RETRIES; netAttempt++) {
      try {
        return await doRequest();
      } catch (netErr: any) {
        if (isRetryableNetworkError(netErr) && netAttempt < MAX_NET_RETRIES - 1) {
          console.warn(`${tag} ${resource}/${action} 网络错误(${netErr.code ?? netErr.message?.slice(0, 40)}) — ${NET_RETRY_DELAY_MS}ms 后重试 (${netAttempt + 1}/${MAX_NET_RETRIES})`);
          await new Promise((r) => setTimeout(r, NET_RETRY_DELAY_MS));
          continue;
        }
        throw netErr;
      }
    }
    throw new Error('unreachable');
  };

  const startMs = Date.now();
  let lastErr: Error | null = null;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES_429; attempt++) {
      const { data: body, headers, status } = await doRequestWithNetRetry();
      const elapsed = Date.now() - startMs;

      if (status === 429) {
        const waitMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
        if (attempt < MAX_RETRIES_429) {
          console.warn(`${tag} ${resource}/${action} 429 — 指数退避 ${waitMs}ms 后重试 (${attempt + 1}/${MAX_RETRIES_429})`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        console.error(`${tag} ${resource}/${action} 429 已达最大重试次数`);
        setDelayMultiplier(2);
        throw new Error(`eMAG API 429 Rate Limit，已退避重试 ${MAX_RETRIES_429} 次`);
      }

      if (status === 401) {
        const msg = 'API 账号或密码无效，请检查凭证';
        console.error(`\n========== [EMAG API ERROR] Shop: ${creds.region}, Status: 401 ==========`);
        console.error(`${tag} ${resource}/${action} 401 未授权`);
        const err = new Error(msg) as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      if (status === 403) {
        const msg = 'API 账号或密码无效，请检查凭证';
        console.error(`\n========== [EMAG API ERROR] Shop: ${creds.region}, Status: 403 ==========`);
        console.error(`${tag} ${resource}/${action} 403 禁止访问`);
        const err = new Error(msg) as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      if (status === 404) {
        const apiMsg = (body as any)?.messages?.join('; ') ?? 'Not Found';
        const msg = `[EMAG API ERROR] Shop: ${creds.region}, Status: 404, Message: ${apiMsg}`;
        console.error(`\n========== ${msg} ==========`);
        console.error(`${tag} ${resource}/${action} 404 资源不存在`);
        throw new Error(msg);
      }

      updateRateLimitFromHeaders(headers);
      if (shouldDelayNextSync()) setDelayMultiplier(2);

      const apiBody: EmagApiResponse<T> = body;
      if (resource === 'order' && action === 'read' && !apiBody.isError) {
        const raw = body as any;
        const res = apiBody.results as any;
        const totalResults = raw?.totalResults ?? raw?.noOfItems ?? res?.totalResults ?? res?.noOfItems ?? (Array.isArray(res) ? res.length : null);
        const pageCount = Array.isArray(res) ? res.length : (res?.length ?? res?.items?.length ?? 0);
        console.log(`[eMAG order/read] totalResults=${totalResults ?? 'N/A'} (本页${pageCount}条)`);
      }

      if (apiBody.isError) {
        const msgs = apiBody.messages ?? [];
        console.error(`${tag} ${resource}/${action} FAILED (${elapsed}ms) — isError: true`);
        if (msgs.length > 0) msgs.forEach((m: string, i: number) => console.error(`  [eMAG messages][${i}]`, m));
        if (apiBody.errors?.length) console.error('  [eMAG errors]', JSON.stringify(apiBody.errors).slice(0, 800));
      } else {
        console.log(`${tag} ${resource}/${action} OK (${elapsed}ms)`);
      }

      return apiBody;
    }
  } catch (err: any) {
    lastErr = err;
    const status = err?.response?.status;
    if (status === 401) console.error(`${tag} ${resource}/${action} 401 未授权 — 请检查凭证或 IP 白名单`);
    throw err;
  } finally {
    releaseConcurrent();
  }

  throw lastErr ?? new Error('eMAG API 请求失败');
}

// ─── 便捷方法 ────────────────────────────────────────────────────

export async function emagRead<T = any>(
  creds: EmagCredentials, resource: string, filters: any = {},
): Promise<EmagApiResponse<T>> {
  return emagApiCall<T>(creds, resource, 'read', filters);
}

export async function emagSave<T = any>(
  creds: EmagCredentials, resource: string, payload: any,
): Promise<EmagApiResponse<T>> {
  return emagApiCall<T>(creds, resource, 'save', payload);
}

export async function emagCount(
  creds: EmagCredentials, resource: string, filters: any = {},
): Promise<EmagApiResponse<{ noOfItems: number }>> {
  return emagApiCall(creds, resource, 'count', filters);
}

// ─── 连接验证 ────────────────────────────────────────────────────

export interface VerifyResult {
  verified: boolean;
  region: EmagRegion;
  sandbox: boolean;
  detail: string;
  categoryCount?: number;
}

/**
 * 验证 eMAG 授权连接
 * 使用 category/read 接口 (分页1条) 确认凭证有效, 同时计数类目总数
 *
 * 安全提醒: 请确保服务器公网 IP 已加入 eMAG 后台 IP 白名单, 否则返回 403
 */
export async function verifyConnection(creds: EmagCredentials): Promise<VerifyResult> {
  const tag = safeLogTag(creds);
  try {
    const readRes = await emagApiCall(
      creds, 'category', 'read',
      { currentPage: 1, itemsPerPage: 1 },
      { timeout: 15000 },
    );

    if (readRes.isError) {
      return {
        verified: false,
        region: creds.region,
        sandbox: creds.isSandbox,
        detail: `API 返回错误: ${readRes.messages?.join('; ') ?? '未知'}`,
      };
    }

    const countRes = await emagCount(creds, 'category');
    const catCount = countRes.isError ? undefined : (countRes.results?.noOfItems ?? undefined);

    const detail = [
      `eMAG ${creds.region} 站点连接成功 (API v4.5.0, POST + Basic Auth)`,
      catCount !== undefined ? `类目总数: ${catCount}` : null,
      creds.isSandbox ? '当前为沙箱环境' : null,
      '请确保服务器 IP 已加入 eMAG Marketplace 后台 IP 白名单',
    ].filter(Boolean).join('。');

    console.log(`${tag} verifyConnection PASSED — categories: ${catCount ?? 'N/A'}`);
    return { verified: true, region: creds.region, sandbox: creds.isSandbox, detail, categoryCount: catCount };
  } catch (e: any) {
    console.error(`${tag} verifyConnection FAILED:`, e.message);
    const hint = e.message?.includes('403') || e.message?.includes('Forbidden')
      ? '。可能原因: 服务器 IP 未加入 eMAG 后台白名单'
      : '';
    return {
      verified: false,
      region: creds.region,
      sandbox: creds.isSandbox,
      detail: `eMAG 连接失败: ${e.message?.slice(0, 400)}${hint}`,
    };
  }
}
