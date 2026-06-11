import { AlibabaAuth, AlibabaTokenType, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

/** 企业自用永久 token 使用的远期过期时间 */
export const ENTERPRISE_STATIC_FAR_EXPIRY = new Date('2099-12-31T23:59:59.000Z');

export function maskAccessToken(token: string | null | undefined): string {
  const value = String(token ?? '').trim();
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 6)}***${value.slice(-4)}`;
}

export function formatAlibabaAccount(auth: AlibabaAuth) {
  const now = new Date();
  const tokenExpired = now >= auth.expiresAt;
  const refreshExpired = auth.refreshTokenExpiresAt ? now >= auth.refreshTokenExpiresAt : false;
  const authorized = auth.tokenType === 'enterprise_static'
    ? auth.isEnabled
    : !refreshExpired;

  return {
    id: auth.id,
    accountName: auth.accountName,
    loginId: auth.loginId,
    memberId: auth.memberId,
    aliId: auth.aliId,
    tokenType: auth.tokenType,
    accessTokenMasked: maskAccessToken(auth.accessToken),
    expiresAt: auth.expiresAt,
    refreshExpiresAt: auth.refreshTokenExpiresAt,
    tokenExpired,
    refreshExpired,
    authorized,
    isEnabled: auth.isEnabled,
    isDefault: auth.isDefault,
    remark: auth.remark,
    lastValidatedAt: auth.lastValidatedAt,
    createdAt: auth.createdAt,
    updatedAt: auth.updatedAt,
  };
}

export async function resolveAlibabaAuthRecord(alibabaAuthId?: number | null): Promise<AlibabaAuth | null> {
  if (alibabaAuthId != null) {
    return prisma.alibabaAuth.findFirst({
      where: { id: alibabaAuthId, isEnabled: true },
    });
  }

  const defaultAccount = await prisma.alibabaAuth.findFirst({
    where: { isEnabled: true, isDefault: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (defaultAccount) return defaultAccount;

  return prisma.alibabaAuth.findFirst({
    where: { isEnabled: true },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function clearOtherDefaultAccounts(exceptId: number, tx: Prisma.TransactionClient = prisma) {
  await tx.alibabaAuth.updateMany({
    where: { id: { not: exceptId }, isDefault: true },
    data: { isDefault: false },
  });
}

export async function setDefaultAlibabaAccount(id: number) {
  return prisma.$transaction(async (tx) => {
    const target = await tx.alibabaAuth.findUnique({ where: { id } });
    if (!target) throw new Error('1688 账号不存在');
    if (!target.isEnabled) throw new Error('已禁用的账号不能设为默认');

    await clearOtherDefaultAccounts(id, tx);
    return tx.alibabaAuth.update({
      where: { id },
      data: { isDefault: true },
    });
  });
}

export interface CreateEnterpriseAccountInput {
  accountName: string;
  accessToken: string;
  loginId?: string | null;
  memberId?: string | null;
  aliId?: string | null;
  remark?: string | null;
  isDefault?: boolean;
  appKey: string;
  appSecret: string;
}

export async function createEnterpriseStaticAccount(input: CreateEnterpriseAccountInput) {
  const accountName = input.accountName.trim();
  const accessToken = input.accessToken.trim();
  if (!accountName) throw new Error('accountName 不能为空');
  if (!accessToken) throw new Error('accessToken 不能为空');

  return prisma.$transaction(async (tx) => {
    const created = await tx.alibabaAuth.create({
      data: {
        accountName,
        appKey: input.appKey,
        appSecret: input.appSecret,
        accessToken,
        refreshToken: null,
        tokenType: AlibabaTokenType.enterprise_static,
        expiresAt: ENTERPRISE_STATIC_FAR_EXPIRY,
        refreshTokenExpiresAt: null,
        loginId: input.loginId?.trim() || null,
        memberId: input.memberId?.trim() || null,
        aliId: input.aliId?.trim() || null,
        remark: input.remark?.trim() || null,
        isEnabled: true,
        isDefault: !!input.isDefault,
      },
    });

    if (input.isDefault) {
      await clearOtherDefaultAccounts(created.id, tx);
      return tx.alibabaAuth.findUniqueOrThrow({ where: { id: created.id } });
    }

    const hasDefault = await tx.alibabaAuth.count({ where: { isDefault: true, isEnabled: true } });
    if (hasDefault === 0) {
      return tx.alibabaAuth.update({
        where: { id: created.id },
        data: { isDefault: true },
      });
    }

    return created;
  });
}

export async function disableAlibabaAccount(id: number) {
  const linkedCount = await prisma.purchaseOrder.count({ where: { alibabaAuthId: id } });
  const account = await prisma.alibabaAuth.findUnique({ where: { id } });
  if (!account) throw new Error('1688 账号不存在');

  if (account.isDefault) {
    throw new Error('默认账号不能直接禁用，请先设置其他账号为默认');
  }

  const updated = await prisma.alibabaAuth.update({
    where: { id },
    data: { isEnabled: false },
  });

  return { account: updated, linkedPurchaseOrderCount: linkedCount };
}
