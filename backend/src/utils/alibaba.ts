import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const GATEWAY_URL    = 'https://gw.open.1688.com/openapi';
const AUTH_URL       = 'https://auth.1688.com/oauth/authorize';

const APP_KEY        = process.env.ALIBABA_APP_KEY        ?? '';
const APP_SECRET     = process.env.ALIBABA_APP_SECRET     ?? '';
const REDIRECT_URI   = process.env.ALIBABA_REDIRECT_URI   ?? '';

const prisma = new PrismaClient();

function sign(apiPath: string, params: Record<string, string>): string {
  const sorted = Object.keys(params).sort();
  const factor = apiPath + '/' + APP_KEY + sorted.map((k) => k + params[k]).join('');
  return crypto
    .createHmac('sha1', APP_SECRET)
    .update(factor, 'utf8')
    .digest('hex')
    .toUpperCase();
}

export interface AlibabaAPIResult<T = unknown> {
  success: boolean;
  data: T | null;
  errorCode?: string;
  errorMessage?: string;
  raw?: unknown;
}

/**
 * 通用 1688 API 调用方法
 *
 * @param apiPath  协议级路径，如 "param2/1/system/currentTime/1234567"
 * @param bizParams  业务参数（不含系统参数，系统参数由本方法自动注入）
 * @param accessToken  部分需要授权的接口需要传入
 */
export async function callAlibabaAPI<T = unknown>(
  apiPath: string,
  bizParams: Record<string, string> = {},
  accessToken?: string,
): Promise<AlibabaAPIResult<T>> {
  const sysParams: Record<string, string> = {
    _aop_signature: '',
  };

  if (accessToken) {
    sysParams.access_token = accessToken;
  }

  const allParams: Record<string, string> = { ...bizParams, ...sysParams };
  delete allParams._aop_signature;

  const signature = sign(apiPath, allParams);

  const url = `${GATEWAY_URL}/${apiPath}/${APP_KEY}`;

  const queryParams: Record<string, string> = {
    ...allParams,
    _aop_signature: signature,
  };

  try {
    const response = await axios.get(url, {
      params: queryParams,
      timeout: 15000,
    });

    const body = response.data;

    if (body?.error_code || body?.errorCode) {
      const ec = body.error_code ?? body.errorCode;
      const em = body.error_message ?? body.errorMessage ?? '未知错误';
      console.error(`[1688 API GET] ${apiPath} 业务错误 → code=${ec}, msg=${em}`);
      console.error('[1688 API GET] 完整响应体:', JSON.stringify(body, null, 2).slice(0, 2000));
      return { success: false, data: null, errorCode: ec, errorMessage: em, raw: body };
    }

    return { success: true, data: body as T, raw: body };
  } catch (err: unknown) {
    const axErr = err as { response?: { data?: unknown; status?: number }; message?: string };
    console.error(`[1688 API GET] ${apiPath} 网络/HTTP异常 → status=${axErr.response?.status}, msg=${axErr.message}`);
    if (axErr.response?.data) {
      console.error('[1688 API GET] 异常响应体:', JSON.stringify(axErr.response.data, null, 2).slice(0, 2000));
    }
    return {
      success: false, data: null,
      errorCode: String(axErr.response?.status ?? 'NETWORK_ERROR'),
      errorMessage: axErr.message ?? '网络请求失败',
      raw: axErr.response?.data,
    };
  }
}

/**
 * 快捷：POST 方式调用 1688 API（部分业务接口要求 POST）
 */
export async function callAlibabaAPIPost<T = unknown>(
  apiPath: string,
  bizParams: Record<string, string> = {},
  accessToken?: string,
): Promise<AlibabaAPIResult<T>> {
  const sysParams: Record<string, string> = {};
  if (accessToken) sysParams.access_token = accessToken;

  const allParams: Record<string, string> = { ...bizParams, ...sysParams };
  const signature = sign(apiPath, allParams);

  const url = `${GATEWAY_URL}/${apiPath}/${APP_KEY}`;

  const formData = new URLSearchParams({ ...allParams, _aop_signature: signature });

  console.log('\n\n🔥🔥🔥 === 1688 最终发包全量参数 === 🔥🔥🔥');
  console.log('API 方法:', apiPath);
  console.log('完整参数:', JSON.stringify(bizParams, null, 2));
  console.log('URL:', url);
  console.log('FormBody (脱敏 access_token):', formData.toString().replace(/access_token=[^&]+/, 'access_token=***'));
  console.log('🔥🔥🔥 ============================== 🔥🔥🔥\n\n');

  try {
    const response = await axios.post(url, formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    const body = response.data;

    if (body?.error_code || body?.errorCode) {
      const ec = body.error_code ?? body.errorCode;
      const em = body.error_message ?? body.errorMessage ?? '未知错误';
      console.error(`[1688 API POST] ${apiPath} 业务错误 → code=${ec}, msg=${em}`);
      console.log('❌❌❌ 1688 深层报错响应（完整）❌❌❌', JSON.stringify(body, null, 2));
      return { success: false, data: null, errorCode: ec, errorMessage: em, raw: body };
    }

    console.log(`[1688 API POST] ${apiPath} 成功, 响应摘要:`, JSON.stringify(body).slice(0, 300));
    return { success: true, data: body as T, raw: body };
  } catch (err: unknown) {
    const axErr = err as { response?: { data?: unknown; status?: number }; message?: string; stack?: string };
    console.log('❌❌❌ 1688 深层报错响应（Catch 完整）❌❌❌', axErr.response ? JSON.stringify(axErr.response.data ?? axErr.response, null, 2) : err);
    console.error(`[1688 API POST] ${apiPath} 网络/HTTP异常 → status=${axErr.response?.status}, msg=${axErr.message}`);
    if (axErr.stack) console.error('[1688 API POST] 完整堆栈:', axErr.stack);
    if (axErr.response?.data) {
      console.error('[1688 API POST] 异常响应体:', JSON.stringify(axErr.response.data, null, 2));
    }
    return {
      success: false, data: null,
      errorCode: String(axErr.response?.status ?? 'NETWORK_ERROR'),
      errorMessage: axErr.message ?? '网络请求失败',
      raw: axErr.response?.data,
    };
  }
}

// ── OAuth 2.0 ────────────────────────────────────────────────

/** 构造 1688 OAuth 授权跳转 URL */
export function buildAuthorizeUrl(state = 'emag'): string {
  const params = new URLSearchParams({
    client_id:    APP_KEY,
    site:         '1688',
    redirect_uri: REDIRECT_URI,
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;       // access_token 有效期（秒）
  aliId?:        string;
  memberId?:     string;
  resource_owner?: string;     // 授权账号登录名
  refresh_token_timeout?: string; // refresh_token 过期时间戳（ms）
}

/** 用 authorization_code 换取 access_token */
export async function exchangeCodeForToken(code: string): Promise<TokenResponse> {
  const apiPath = 'param2/1/system.oauth2/getToken';
  const bizParams: Record<string, string> = {
    grant_type:          'authorization_code',
    need_refresh_token:  'true',
    client_id:           APP_KEY,
    client_secret:       APP_SECRET,
    redirect_uri:        REDIRECT_URI,
    code,
  };

  const signature = sign(apiPath, bizParams);
  const url = `${GATEWAY_URL}/${apiPath}/${APP_KEY}`;

  const form = new URLSearchParams({ ...bizParams, _aop_signature: signature });

  const { data } = await axios.post(url, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  if (data?.error_code || data?.error) {
    throw new Error(data.error_message ?? data.error_description ?? JSON.stringify(data));
  }
  return data as TokenResponse;
}

/** 用 refresh_token 刷新 access_token */
export async function refreshAccessToken(rt: string): Promise<TokenResponse> {
  const apiPath = 'param2/1/system.oauth2/getToken';
  const bizParams: Record<string, string> = {
    grant_type:     'refresh_token',
    client_id:      APP_KEY,
    client_secret:  APP_SECRET,
    refresh_token:  rt,
  };

  const signature = sign(apiPath, bizParams);
  const url = `${GATEWAY_URL}/${apiPath}/${APP_KEY}`;

  const form = new URLSearchParams({ ...bizParams, _aop_signature: signature });

  const { data } = await axios.post(url, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  if (data?.error_code || data?.error) {
    throw new Error(data.error_message ?? data.error_description ?? JSON.stringify(data));
  }
  return data as TokenResponse;
}

/**
 * 将 Token 响应持久化到 AlibabaAuth 表
 * 表中只保留最新的一条记录（单系统单账号模式）
 */
export async function persistToken(token: TokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const refreshTokenExpiresAt = token.refresh_token_timeout
    ? new Date(Number(token.refresh_token_timeout))
    : null;

  const payload = {
    appKey:                APP_KEY,
    appSecret:             APP_SECRET,
    accessToken:           token.access_token,
    refreshToken:          token.refresh_token,
    expiresAt,
    refreshTokenExpiresAt,
    memberId:              token.memberId ?? null,
    aliId:                 token.aliId ?? null,
    loginId:               token.resource_owner ?? null,
  };

  const existing = await prisma.alibabaAuth.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (existing) {
    await prisma.alibabaAuth.update({ where: { id: existing.id }, data: payload });
  } else {
    await prisma.alibabaAuth.create({ data: payload });
  }
}

/**
 * 获取当前有效的 access_token
 * - 距过期 < 30 分钟时，自动使用 refresh_token 刷新
 * - refresh_token 也过期则返回 null（需要重新授权）
 */
export async function getValidAccessToken(): Promise<string | null> {
  const auth = await prisma.alibabaAuth.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!auth) return null;

  const now = Date.now();
  const BUFFER_MS = 30 * 60 * 1000; // 30 分钟缓冲

  if (auth.expiresAt.getTime() - now > BUFFER_MS) {
    return auth.accessToken;
  }

  // refresh_token 是否还有效
  if (auth.refreshTokenExpiresAt && auth.refreshTokenExpiresAt.getTime() < now) {
    console.warn('[1688 Token] refresh_token 已过期，需要重新授权');
    return null;
  }

  try {
    console.log('[1688 Token] access_token 即将过期，正在自动刷新...');
    const newToken = await refreshAccessToken(auth.refreshToken);
    await persistToken(newToken);
    console.log('[1688 Token] 自动刷新成功');
    return newToken.access_token;
  } catch (err) {
    console.error('[1688 Token] 自动刷新失败', err);
    return null;
  }
}

export { APP_KEY, APP_SECRET, GATEWAY_URL, REDIRECT_URI, AUTH_URL };
