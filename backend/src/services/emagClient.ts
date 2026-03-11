import axios from 'axios';
import { prisma } from '../lib/prisma';
import { decrypt } from '../utils/shopCrypto';

// ═══════════════════════════════════════════════════════════════════
// eMAG Marketplace API v4.5.0 — 核心客户端
//
//  认证: Basic Authorization  base64(username:password)
//  规范: 所有请求均为 POST, 业务参数包裹在 mandatory "data" key 中
//  响应: 统一检查 isError === false
//  限流: Orders 12 req/sec, 其他 3 req/sec
//  安全: 密码从 AES-256 加密存储读取, Authorization 报头绝不明文输出
// ═══════════════════════════════════════════════════════════════════

// ─── 多站点 Endpoint 映射 ────────────────────────────────────────

export type EmagRegion = 'RO' | 'BG' | 'HU';

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
 * 从数据库加密存储中读取 eMAG 店铺凭证
 * 密码经 AES-256-CBC 解密, 绝不记录明文
 */
export async function getEmagCredentials(shopId: number): Promise<EmagCredentials> {
  const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`店铺 ID ${shopId} 不存在`);
  if (shop.platform.toLowerCase() !== 'emag') throw new Error(`店铺 "${shop.shopName}" 不是 eMAG 平台`);

  const username = decrypt(shop.apiKey);
  const password = decrypt(shop.apiSecret);
  const region   = resolveRegion(shop.shopName);
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

export async function emagApiCall<T = any>(
  creds: EmagCredentials,
  resource: string,
  action: string,
  data: any = {},
  options: { timeout?: number } = {},
): Promise<EmagApiResponse<T>> {
  const throttle = isOrderRoute(resource) ? orderThrottle : generalThrottle;
  await throttle.acquire();

  const url = `${creds.baseUrl}/${resource}/${action}`;
  const basicAuth = Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
  const tag = safeLogTag(creds);

  const startMs = Date.now();
  try {
    const resp = await axios.post(
      url,
      { data },
      {
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/json',
        },
        timeout: options.timeout ?? 30000,
      },
    );

    const body: EmagApiResponse<T> = resp.data;
    const elapsed = Date.now() - startMs;

    // order/read 时打印 eMAG 原始 totalResults 便于核对
    if (resource === 'order' && action === 'read' && !body.isError) {
      const raw = resp.data as any;
      const res = body.results as any;
      const totalResults = raw?.totalResults ?? raw?.noOfItems ?? res?.totalResults ?? res?.noOfItems ?? (Array.isArray(res) ? res.length : null);
      const pageCount = Array.isArray(res) ? res.length : (res?.length ?? res?.items?.length ?? 0);
      console.log(`[eMAG order/read] totalResults=${totalResults ?? 'N/A'} (本页${pageCount}条)`);
    }

    if (body.isError) {
      const msgs = body.messages ?? [];
      console.error(`${tag} ${resource}/${action} FAILED (${elapsed}ms) — isError: true`);
      if (msgs.length > 0) {
        msgs.forEach((m: string, i: number) => console.error(`  [eMAG messages][${i}]`, m));
      }
      if (body.errors?.length) {
        console.error('  [eMAG errors]', JSON.stringify(body.errors).slice(0, 800));
      }
    } else {
      console.log(`${tag} ${resource}/${action} OK (${elapsed}ms)`);
    }

    return body;
  } catch (err: any) {
    const elapsed = Date.now() - startMs;
    const detail = safeErrorDetail(err);
    console.error(`${tag} ${resource}/${action} ERROR (${elapsed}ms) →`, detail);
    throw new Error(`eMAG API 请求失败 [${resource}/${action}]: ${detail}`);
  }
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
