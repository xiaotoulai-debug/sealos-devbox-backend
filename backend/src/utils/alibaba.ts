import crypto from 'crypto';
import axios from 'axios';
import { AlibabaTokenType, PrismaClient } from '@prisma/client';
import {
  ENTERPRISE_STATIC_FAR_EXPIRY,
  resolveAlibabaAuthRecord,
} from '../services/alibabaAuthService';

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

export interface GetValidAccessTokenOptions {
  alibabaAuthId?: number | null;
}

/**
 * 通用 1688 API 调用方法
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
      return { success: false, data: null, errorCode: ec, errorMessage: em, raw: body };
    }

    return { success: true, data: body as T, raw: body };
  } catch (err: unknown) {
    const axErr = err as { response?: { data?: unknown; status?: number }; message?: string };
    console.error(`[1688 API GET] ${apiPath} 网络/HTTP异常 → status=${axErr.response?.status}, msg=${axErr.message}`);
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

  console.log(`[1688 API POST] ${apiPath} 请求中（access_token 已脱敏）`);

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
      return { success: false, data: null, errorCode: ec, errorMessage: em, raw: body };
    }

    return { success: true, data: body as T, raw: body };
  } catch (err: unknown) {
    const axErr = err as { response?: { data?: unknown; status?: number }; message?: string };
    const rawBody = axErr.response?.data as Record<string, unknown> | undefined;
    const bizErrorCode = rawBody?.error_code ?? rawBody?.errorCode;
    const bizErrorMsg  = rawBody?.error_message ?? rawBody?.errorMessage;

    console.error(`[1688 API POST] ${apiPath} HTTP异常 → status=${axErr.response?.status} bizCode=${bizErrorCode ?? 'N/A'}`);

    return {
      success: false, data: null,
      errorCode:    bizErrorCode ? String(bizErrorCode) : String(axErr.response?.status ?? 'NETWORK_ERROR'),
      errorMessage: bizErrorMsg  ? String(bizErrorMsg)  : (axErr.message ?? '网络请求失败'),
      raw: rawBody,
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
  expires_in:    number;
  aliId?:        string;
  memberId?:     string;
  resource_owner?: string;
  refresh_token_timeout?: string;
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
 * 将 OAuth Token 响应持久化到 AlibabaAuth 表（兼容多账号：按 loginId 匹配或更新默认 OAuth 账号）
 */
export async function persistToken(token: TokenResponse, targetAuthId?: number): Promise<void> {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);
  const refreshTokenExpiresAt = token.refresh_token_timeout
    ? new Date(Number(token.refresh_token_timeout))
    : null;

  const accountName = token.resource_owner?.trim() || token.memberId?.trim() || 'OAuth账号';

  const payload = {
    appKey:                APP_KEY,
    appSecret:             APP_SECRET,
    accessToken:           token.access_token,
    refreshToken:          token.refresh_token,
    tokenType:             AlibabaTokenType.oauth,
    expiresAt,
    refreshTokenExpiresAt,
    memberId:              token.memberId ?? null,
    aliId:                 token.aliId ?? null,
    loginId:               token.resource_owner ?? null,
    accountName,
    isEnabled:             true,
  };

  if (targetAuthId != null) {
    await prisma.alibabaAuth.update({ where: { id: targetAuthId }, data: payload });
    return;
  }

  const loginId = token.resource_owner?.trim();
  const existing = loginId
    ? await prisma.alibabaAuth.findFirst({ where: { loginId, tokenType: AlibabaTokenType.oauth } })
    : await prisma.alibabaAuth.findFirst({ where: { isDefault: true, tokenType: AlibabaTokenType.oauth } });

  if (existing) {
    await prisma.alibabaAuth.update({ where: { id: existing.id }, data: payload });
    return;
  }

  const hasDefault = await prisma.alibabaAuth.count({ where: { isDefault: true, isEnabled: true } });
  await prisma.alibabaAuth.create({
    data: {
      ...payload,
      isDefault: hasDefault === 0,
    },
  });
}

/**
 * 获取当前有效的 access_token
 * - enterprise_static：直接返回，不 refresh
 * - oauth：保留原自动刷新逻辑
 */
export async function getValidAccessToken(options?: GetValidAccessTokenOptions): Promise<string | null> {
  const auth = await resolveAlibabaAuthRecord(options?.alibabaAuthId ?? null);
  if (!auth) return null;

  if (auth.tokenType === AlibabaTokenType.enterprise_static) {
    return auth.accessToken;
  }

  const now = Date.now();
  const BUFFER_MS = 30 * 60 * 1000;

  if (auth.expiresAt.getTime() - now > BUFFER_MS) {
    return auth.accessToken;
  }

  if (auth.refreshTokenExpiresAt && auth.refreshTokenExpiresAt.getTime() < now) {
    console.warn(`[1688 Token] 账号 ${auth.accountName}(#${auth.id}) refresh_token 已过期，需要重新授权`);
    return null;
  }

  if (!auth.refreshToken) {
    console.warn(`[1688 Token] 账号 ${auth.accountName}(#${auth.id}) 缺少 refresh_token，无法自动刷新`);
    return null;
  }

  try {
    console.log(`[1688 Token] 账号 ${auth.accountName}(#${auth.id}) access_token 即将过期，正在自动刷新...`);
    const newToken = await refreshAccessToken(auth.refreshToken);
    await persistToken(newToken, auth.id);
    console.log(`[1688 Token] 账号 ${auth.accountName}(#${auth.id}) 自动刷新成功`);
    return newToken.access_token;
  } catch (err) {
    console.error(`[1688 Token] 账号 ${auth.accountName}(#${auth.id}) 自动刷新失败`, err instanceof Error ? err.message : err);
    return null;
  }
}

export { APP_KEY, APP_SECRET, GATEWAY_URL, REDIRECT_URI, AUTH_URL, ENTERPRISE_STATIC_FAR_EXPIRY };
