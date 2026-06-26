/**
 * eMAG 佣金 API 同步服务（commission_refresh）
 *
 * 官方接口（Swagger 确认）：
 *   GET https://marketplace.emag.{region}/api/v1/commission/estimate/{emagOfferId}
 *   响应：{ code: 200, data: { value: "18.00", created: "...", priority: "..." } }
 *   value = 佣金率百分比字符串，使用时 parseFloat(value) / 100
 *
 * 核心规则：
 *   - emagOfferId 必须非空且为纯数字字符串
 *   - 正常模式：commissionSyncedAt 为空 OR 超 30 天，且 commissionLastAttemptAt 为空 OR 超 24h
 *   - force 模式：忽略 30 天成功缓存，但仍遵守 24h lastAttempt 冷却
 *   - 单条失败（404/422/格式错误）仅更新 lastAttemptAt，不清空已有 commissionRate
 *   - 批次完成后，成功数量 > 0 时统一调用一次 recalcProfitForShop（不逐条调）
 *
 * Migration B 依赖字段：
 *   commissionSyncedAt, commissionLastAttemptAt, commissionApiCreatedRaw, commissionApiPriority
 *   （Migration B 执行前这些字段在 DB 中不存在；执行前请确保 Migration B 已部署）
 */

import { prisma } from '../lib/prisma';
import { getEmagCredentials, emagRestGet } from './emagClient';
import { recalcProfitForShop } from './profitCalculator';

// ─── 常量 ────────────────────────────────────────────────────────────
const COMMISSION_API_PATH  = '/api/v1/commission/estimate';

/** 成功缓存有效期：30 天 */
const CACHE_VALID_DAYS = 30;
const CACHE_VALID_MS   = CACHE_VALID_DAYS * 24 * 60 * 60 * 1000;

/** 失败冷却期：24 小时（防止失败商品高频重试浪费配额） */
const ATTEMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 单次批处理量上限（防止 Cron 超时） */
const DEFAULT_MAX_PER_SHOP = 500;

/** 有效佣金率范围 [0, 100] 百分比 */
const VALID_COMMISSION_MIN = 0;
const VALID_COMMISSION_MAX = 100;

// ─── 类型 ────────────────────────────────────────────────────────────

export interface CommissionSyncOptions {
  /** 忽略 30 天成功缓存，强制刷新（仍遵守 24h lastAttempt 冷却） */
  force?: boolean;
  /** 本次最多处理条数（不传则使用 DEFAULT_MAX_PER_SHOP=500） */
  limit?: number;
}

export interface CommissionSyncResult {
  shopId: number;
  region: string;
  candidates:   number;   // 查询到的待处理数量
  succeeded:    number;   // 成功写入 commissionRate 的数量
  failed:       number;   // API 报错或格式异常的数量
  skipped:      number;   // 缓存命中跳过（force=false 时）
  noOfferId:    number;   // emagOfferId 为空/非纯数字，跳过
  profitRecalc: boolean;  // 是否触发了利润重算
  durationMs:   number;
  error?:       string;   // 店铺级别异常
}

// ─── 工具函数 ────────────────────────────────────────────────────────

/** 脱敏 emagOfferId（保留后 4 位）*/
function maskOfferId(offerId: string): string {
  if (offerId.length <= 4) return '****';
  return '*'.repeat(offerId.length - 4) + offerId.slice(-4);
}

/** 判断是否为纯数字字符串 */
function isPureDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** 判断 30 天成功缓存是否有效 */
function isSuccessCacheValid(commissionSyncedAt: Date | null): boolean {
  if (!commissionSyncedAt) return false;
  return Date.now() - commissionSyncedAt.getTime() < CACHE_VALID_MS;
}

/** 判断 24h 失败冷却是否仍在生效 */
function isAttemptOnCooldown(commissionLastAttemptAt: Date | null): boolean {
  if (!commissionLastAttemptAt) return false;
  return Date.now() - commissionLastAttemptAt.getTime() < ATTEMPT_COOLDOWN_MS;
}

// ─── 核心同步函数 ────────────────────────────────────────────────────

/**
 * 对指定店铺执行佣金 API 同步
 *
 * 正常流程：
 *   1. 查询该店铺所有 isArchived=false 且 emagOfferId 非空的 StoreProduct
 *   2. 按规则过滤（缓存/冷却）
 *   3. 串行调用 GET /api/v1/commission/estimate/{emagOfferId}
 *   4. 成功：写入 commissionRate, commissionRateSource, commissionSyncedAt, commissionLastAttemptAt,
 *            commissionApiCreatedRaw, commissionApiPriority
 *   5. 失败：只更新 commissionLastAttemptAt
 *   6. 批次结束后，成功数 > 0 时异步触发一次 recalcProfitForShop
 */
export async function syncCommissionForShop(
  shopId: number,
  options: CommissionSyncOptions = {},
): Promise<CommissionSyncResult> {
  const { force = false, limit = DEFAULT_MAX_PER_SHOP } = options;
  const startMs = Date.now();

  let creds: Awaited<ReturnType<typeof getEmagCredentials>>;
  try {
    creds = await getEmagCredentials(shopId);
  } catch (e: any) {
    return {
      shopId, region: 'UNKNOWN', candidates: 0, succeeded: 0, failed: 0,
      skipped: 0, noOfferId: 0, profitRecalc: false, durationMs: Date.now() - startMs,
      error: e.message,
    };
  }

  const region = creds.region;

  // ── 时间边界计算（用于 DB 层过滤） ──────────────────────────────────────
  const now30daysAgo  = new Date(Date.now() - CACHE_VALID_MS);    // 30 天前
  const now24hAgo     = new Date(Date.now() - ATTEMPT_COOLDOWN_MS); // 24 小时前

  // 查询候选产品（在 DB 层直接过滤，避免 take 过小导致遗漏）
  // force=true  → 忽略 30 天成功缓存，仅排除 24h 冷却
  // force=false → 同时排除 30 天成功缓存和 24h 冷却
  let candidates: Array<{
    id: number;
    pnk: string;
    emagOfferId: string | null;
    commissionRate: number | null;
    commissionSyncedAt: Date | null;
    commissionLastAttemptAt: Date | null;
  }>;

  try {
    const syncedAtCondition = force
      ? {}  // force=true 不过滤 syncedAt
      : {
          // 未同步过 OR 同步时间超过 30 天
          OR: [
            { commissionSyncedAt: null },
            { commissionSyncedAt: { lt: now30daysAgo } },
          ],
        };

    candidates = await prisma.storeProduct.findMany({
      where: {
        shopId,
        isArchived: false,
        emagOfferId: { not: null },
        // 24h 冷却过滤（force 也不绕过，防 API 过载）
        OR: [
          { commissionLastAttemptAt: null },
          { commissionLastAttemptAt: { lt: now24hAgo } },
        ],
        ...(force ? {} : {
          AND: [
            {
              OR: [
                { commissionSyncedAt: null },
                { commissionSyncedAt: { lt: now30daysAgo } },
              ],
            },
          ],
        }),
      },
      select: {
        id: true,
        pnk: true,
        emagOfferId: true,
        commissionRate: true,
        commissionSyncedAt: true,
        commissionLastAttemptAt: true,
      },
      take: limit, // DB 层已过滤，直接取 limit 条
      orderBy: [
        { commissionSyncedAt: 'asc' },  // 最旧的优先处理（null 排最前）
        { id: 'asc' },                  // 次要排序保证确定性
      ],
    });
  } catch (e: any) {
    // Migration B 未执行时，commissionSyncedAt 等字段不存在会报错
    console.warn(`[commissionSync] shop=${shopId} 查询候选产品失败（Migration B 可能未执行）: ${e.message?.slice(0, 200)}`);
    return {
      shopId, region, candidates: 0, succeeded: 0, failed: 0,
      skipped: 0, noOfferId: 0, profitRecalc: false, durationMs: Date.now() - startMs,
      error: `Migration B 可能未执行：${e.message?.slice(0, 150)}`,
    };
  }

  // 计算 skipped 数量（DB 层已过滤缓存/冷却；这里只统计 noOfferId）
  // 注意：由于 DB 层过滤，skipped 计数改为"DB 层过滤掉的数量"
  // 为了保持 skipped 统计的准确性，额外查询总数
  let totalInShop = 0;
  try {
    totalInShop = await prisma.storeProduct.count({
      where: { shopId, isArchived: false, emagOfferId: { not: null } },
    });
  } catch { /* 非关键，允许失败 */ }

  let candidateCount = 0;
  let succeeded      = 0;
  let failed         = 0;
  let noOfferId      = 0;
  // skipped = total - candidates.length - noOfferId（估算，DB 层已过滤）
  const dbFilteredSkipped = Math.max(0, totalInShop - candidates.length);

  for (const sp of candidates) {
    // offerId 有效性校验（非纯数字字符串，DB 无法精确过滤）
    if (!sp.emagOfferId || !isPureDigits(sp.emagOfferId)) {
      noOfferId++;
      continue;
    }

    candidateCount++;

    const now = new Date();
    const maskedId = maskOfferId(sp.emagOfferId);
    const path     = `${COMMISSION_API_PATH}/${sp.emagOfferId}`;

    try {
      const resp = await emagRestGet<{ value?: string; created?: string; priority?: string }>(
        creds, path, { timeout: 15_000 },
      );

      // ── 4. 响应校验 ──
      if (resp.code !== 200 || resp.data == null) {
        console.warn(`[commissionSync] shop=${shopId} offerId=${maskedId} 非 200 或 data 为空: code=${resp.code}`);
        await prisma.storeProduct.update({
          where: { id: sp.id },
          data: { commissionLastAttemptAt: now },
        });
        failed++;
        continue;
      }

      const valueStr = resp.data.value;
      if (typeof valueStr !== 'string' && typeof valueStr !== 'number') {
        console.warn(`[commissionSync] shop=${shopId} offerId=${maskedId} value 字段缺失或类型异常: ${JSON.stringify(resp.data).slice(0, 100)}`);
        await prisma.storeProduct.update({
          where: { id: sp.id },
          data: { commissionLastAttemptAt: now },
        });
        failed++;
        continue;
      }

      const valuePct = parseFloat(String(valueStr));
      if (isNaN(valuePct) || valuePct < VALID_COMMISSION_MIN || valuePct > VALID_COMMISSION_MAX) {
        console.warn(`[commissionSync] shop=${shopId} offerId=${maskedId} value 超出有效范围 [0,100]: "${valueStr}"`);
        await prisma.storeProduct.update({
          where: { id: sp.id },
          data: { commissionLastAttemptAt: now },
        });
        failed++;
        continue;
      }

      const commissionRate = valuePct / 100;

      // ── 5. 成功写入（包含所有 Migration B 新字段）──
      await prisma.storeProduct.update({
        where: { id: sp.id },
        data: {
          commissionRate,
          commissionRateSource:    'EMAG_API_ESTIMATE',
          commissionSyncedAt:      now,
          commissionLastAttemptAt: now,
          commissionApiCreatedRaw: resp.data.created ?? null,
          commissionApiPriority:   resp.data.priority != null ? String(resp.data.priority) : null,
        },
      });

      console.log(`[commissionSync] ✅ shop=${shopId} offerId=${maskedId} pnk=${sp.pnk} → commissionRate=${commissionRate} (${valuePct}%)`);
      succeeded++;

    } catch (err: any) {
      // ── 6. 单条失败：只记录 lastAttemptAt，保留历史 commissionRate ──
      const errMsg = err.message?.slice(0, 200) ?? 'unknown error';
      console.warn(`[commissionSync] ❌ shop=${shopId} offerId=${maskedId} pnk=${sp.pnk} 失败: ${errMsg}`);
      try {
        await prisma.storeProduct.update({
          where: { id: sp.id },
          data: { commissionLastAttemptAt: now },
        });
      } catch (dbErr: any) {
        console.error(`[commissionSync] 更新 lastAttemptAt 失败: ${dbErr.message?.slice(0, 100)}`);
      }
      failed++;
    }
  }

  const durationMs = Date.now() - startMs;

  // ── 7. 批次结束：成功数 > 0 时触发一次利润重算 ──
  let profitRecalc = false;
  if (succeeded > 0) {
    profitRecalc = true;
    // fire-and-forget：不阻塞当前批次返回
    recalcProfitForShop(shopId).catch((e: any) => {
      console.error(`[commissionSync] shop=${shopId} 触发利润重算失败: ${e.message?.slice(0, 150)}`);
    });
  }

  const result: CommissionSyncResult = {
    shopId,
    region,
    candidates:   candidateCount,
    succeeded,
    failed,
    skipped:      dbFilteredSkipped,
    noOfferId,
    profitRecalc,
    durationMs,
  };

  console.log(
    `[commissionSync] shop=${shopId}(${region}) 完成 — ` +
    `候选=${candidateCount} 成功=${succeeded} 失败=${failed} 跳过=${dbFilteredSkipped} ` +
    `无OfferId=${noOfferId} 重算=${profitRecalc} 耗时=${durationMs}ms`,
  );

  return result;
}

/**
 * 对所有活跃 eMAG 店铺执行佣金同步（Cron 场景）
 * 店铺之间串行，单店异常不影响其他店铺
 */
export async function syncCommissionForAllShops(
  options: CommissionSyncOptions = {},
): Promise<CommissionSyncResult[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true, shopName: true },
    orderBy: { id: 'asc' },
  });

  console.log(`[commissionSync] 全店铺同步开始，共 ${shops.length} 个店铺（串行）`);
  const results: CommissionSyncResult[] = [];

  for (const shop of shops) {
    console.log(`[commissionSync] → 开始店铺 "${shop.shopName}" (shopId=${shop.id})`);
    const res = await syncCommissionForShop(shop.id, options);
    results.push(res);
  }

  return results;
}
