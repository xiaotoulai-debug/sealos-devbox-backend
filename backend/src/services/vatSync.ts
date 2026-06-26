/**
 * VAT 快照同步服务
 *
 * 职责：
 *   1. 调用 eMAG vat/read 获取店铺 VAT 映射列表
 *   2. 将结果 upsert 到 VatMapping 表（shopId + vatId 唯一键）
 *   3. 按 shopId + vatId 批量回填 StoreProduct.vatRate / vatSyncedAt
 *
 * 架构规则：
 *   - 必须复用 emagApiCall / generalThrottle / 代理 / 重试能力，禁止新建独立 axios
 *   - VAT 失败不阻断产品同步，降级为 STALE_FALLBACK 状态
 *   - vatRate 统一存小数：21% → 0.21；raw=1 视为 AMBIGUOUS，保留旧值
 *   - 缓存策略：7 天内有效映射默认不重复调用 API
 *   - VAT 不参与利润计算，VAT 同步不触发利润重算
 */

import { prisma } from '../lib/prisma';
import { getEmagCredentials, emagApiCall } from './emagClient';

/** VAT 同步单次结果 */
export interface VatSyncResult {
  shopId: number;
  shopName: string;
  status: 'SUCCESS' | 'CACHE_HIT' | 'FAILED' | 'PARTIAL';
  vatMappingsUpserted: number;   // 成功写入/更新的 VatMapping 条数
  productsBackfilled: number;    // StoreProduct 回填 vatRate/vatSyncedAt 条数
  productsCleared: number;       // vatId 无有效映射，vatRate 被清空的产品数
  ambiguousCount: number;        // vat_rate=1 歧义，跳过写入的条数
  invalidCount: number;          // 非法税率，跳过写入的条数
  errorMessage?: string;
}

/** vat/read 原始返回结构（已通过探测确认）*/
interface RawVatEntry {
  vat_id: number;
  vat_rate: number;
  is_default: number;
}

/** VAT 税率标准化规则 */
type NormalizeResult =
  | { ok: true; rate: number }
  | { ok: false; reason: 'AMBIGUOUS' | 'INVALID' };

function normalizeVatRate(raw: unknown): NormalizeResult {
  const val = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(val)) {
    return { ok: false, reason: 'INVALID' };
  }

  if (val === 0) {
    return { ok: true, rate: 0 };
  }

  if (val === 1) {
    return { ok: false, reason: 'AMBIGUOUS' }; // 可能是 1% 或 100%，待真实数据确认
  }

  if (val > 0 && val < 1) {
    return { ok: true, rate: val }; // 已是小数形式（如 0.21）
  }

  if (val > 1 && val <= 100) {
    return { ok: true, rate: +(val / 100).toFixed(6) }; // 整数形式（如 21 → 0.21）
  }

  return { ok: false, reason: 'INVALID' }; // val < 0 或 val > 100
}

/** 分块写入延迟（防连接池打满） */
const WRITE_CHUNK_SIZE  = 100;
const WRITE_CHUNK_DELAY = 50; // ms
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** VAT 缓存有效期（7 天） */
const VAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 检查当前店铺 VAT 缓存是否完全有效。
 *
 * 必须同时满足两个条件才能 CACHE_HIT：
 *   1. 7 天内有成功同步的 VatMapping 记录（缓存未过期）
 *   2. 当前店铺所有 StoreProduct 的非空 vatId，
 *      在 VatMapping 中都已存在对应记录
 *
 * 若发现任意 vatId 缺少 VatMapping（新增或未同步），
 * 必须触发店铺级 vat/read 刷新，不允许 CACHE_HIT。
 */
async function isVatCacheValid(shopId: number): Promise<boolean> {
  const since = new Date(Date.now() - VAT_CACHE_TTL_MS);

  // 条件 1：时间维度缓存检查
  const freshCount = await prisma.vatMapping.count({
    where: { shopId, syncedAt: { gte: since } },
  });
  if (freshCount === 0) return false; // 缓存过期，必须刷新

  // 条件 2：覆盖度检查 — 当前产品的所有 vatId 是否都有映射
  // 取当前店铺所有非归档产品的不重复 vatId
  const productVatIds = await prisma.storeProduct.findMany({
    where:  { shopId, isArchived: false, vatId: { not: null } },
    select: { vatId: true },
    distinct: ['vatId'],
  });
  const uniqueVatIds = productVatIds.map((p) => p.vatId as number);

  if (uniqueVatIds.length === 0) return true; // 没有产品有 vatId，缓存视为有效

  // 检查是否所有产品 vatId 都在 VatMapping 中
  const mappedCount = await prisma.vatMapping.count({
    where: { shopId, vatId: { in: uniqueVatIds } },
  });

  if (mappedCount < uniqueVatIds.length) {
    const missing = uniqueVatIds.length - mappedCount;
    console.log(
      `[VatSync] shopId=${shopId} 缓存覆盖度不足：` +
      `产品侧共 ${uniqueVatIds.length} 个不同 vatId，` +
      `VatMapping 仅覆盖 ${mappedCount} 个，缺失 ${missing} 个，强制刷新`,
    );
    return false; // 有 vatId 无对应映射，必须刷新
  }

  return true; // 缓存时间有效 + 覆盖度完整 → 允许 CACHE_HIT
}

/**
 * 为指定店铺同步 VAT 映射。
 *
 * @param shopId   店铺 ID
 * @param force    true = 强制刷新（忽略 7 天缓存）；false/undefined = 缓存未过期时跳过
 */
export async function syncVatMappingsForShop(
  shopId: number,
  options?: { force?: boolean },
): Promise<VatSyncResult> {
  const force = options?.force ?? false;

  // 获取店铺名称（用于日志）
  const shop = await prisma.shopAuthorization.findUnique({
    where: { id: shopId },
    select: { shopName: true, region: true },
  });
  const shopName = shop?.shopName ?? `shopId=${shopId}`;
  const region   = shop?.region  ?? 'UNKNOWN';

  // ── 缓存命中判断 ─────────────────────────────────────────────────
  if (!force) {
    const isCached = await isVatCacheValid(shopId);
    if (isCached) {
      console.log(`[VatSync] shopId=${shopId}(${shopName}) 缓存有效（7天内 + 全量覆盖），跳过 vat/read`);
      return {
        shopId, shopName, status: 'CACHE_HIT',
        vatMappingsUpserted: 0, productsBackfilled: 0, productsCleared: 0,
        ambiguousCount: 0, invalidCount: 0,
      };
    }
  }

  // ── 调用 vat/read ─────────────────────────────────────────────────
  let rawEntries: RawVatEntry[] = [];
  try {
    const creds = await getEmagCredentials(shopId);
    const resp  = await emagApiCall<RawVatEntry[]>(creds, 'vat', 'read', {});

    if (resp.isError) {
      const errMsg = (resp.messages ?? []).join('; ') || 'vat/read isError=true';
      console.error(`[VatSync] shopId=${shopId}(${shopName}) vat/read 失败: ${errMsg}`);
      return {
        shopId, shopName, status: 'FAILED',
        vatMappingsUpserted: 0, productsBackfilled: 0, productsCleared: 0,
        ambiguousCount: 0, invalidCount: 0,
        errorMessage: errMsg,
      };
    }

    if (!Array.isArray(resp.results)) {
      console.error(`[VatSync] shopId=${shopId}(${shopName}) vat/read 返回结构异常（results 非数组）`);
      return {
        shopId, shopName, status: 'FAILED',
        vatMappingsUpserted: 0, productsBackfilled: 0, productsCleared: 0,
        ambiguousCount: 0, invalidCount: 0,
        errorMessage: 'vat/read results 非数组',
      };
    }

    rawEntries = resp.results;
    console.log(`[VatSync] shopId=${shopId}(${shopName}) vat/read OK，共 ${rawEntries.length} 条`);
  } catch (err: any) {
    console.error(`[VatSync] shopId=${shopId}(${shopName}) vat/read 网络异常:`, err.message ?? err);
    return {
      shopId, shopName, status: 'FAILED',
      vatMappingsUpserted: 0, productsBackfilled: 0, productsCleared: 0,
      ambiguousCount: 0, invalidCount: 0,
      errorMessage: err.message ?? String(err),
    };
  }

  // ── 标准化并 upsert VatMapping ────────────────────────────────────
  let upserted    = 0;
  let ambiguous   = 0;
  let invalid     = 0;
  const now       = new Date();
  const validVatIds: number[] = []; // 成功写入的 vatId 列表（用于回填）

  for (const entry of rawEntries) {
    const vatId = entry.vat_id;
    if (!Number.isInteger(vatId) || vatId <= 0) {
      console.warn(`[VatSync] shopId=${shopId} 跳过非法 vatId: ${vatId}`);
      invalid++;
      continue;
    }

    const normalized = normalizeVatRate(entry.vat_rate);
    if (!normalized.ok) {
      if (normalized.reason === 'AMBIGUOUS') {
        console.warn(
          `[VatSync] shopId=${shopId} vatId=${vatId} raw vat_rate=1 歧义，保留旧映射，待确认`,
        );
        ambiguous++;
        // AMBIGUOUS：保留旧记录，不写入新税率，但记录 vatId 以便后续跟踪
        continue;
      } else {
        console.warn(
          `[VatSync] shopId=${shopId} vatId=${vatId} vat_rate=${entry.vat_rate} 非法，跳过写入`,
        );
        invalid++;
        continue;
      }
    }

    // 正常税率：upsert VatMapping
    try {
      await prisma.vatMapping.upsert({
        where:  { shopId_vatId: { shopId, vatId } },
        create: { shopId, region, vatId, vatRate: normalized.rate, syncedAt: now },
        update: { vatRate: normalized.rate, syncedAt: now, region },
      });
      upserted++;
      validVatIds.push(vatId);
    } catch (err: any) {
      console.error(`[VatSync] shopId=${shopId} vatId=${vatId} upsert 失败:`, err.message ?? err);
      invalid++;
    }
  }

  console.log(
    `[VatSync] shopId=${shopId}(${shopName}) VatMapping 写入完成：upserted=${upserted}, ambiguous=${ambiguous}, invalid=${invalid}`,
  );

  // ── 批量回填 StoreProduct.vatRate / vatSyncedAt ───────────────────
  // 只更新当前 shopId 下，vatId 在 validVatIds 中的产品
  let backfilled = 0;
  if (validVatIds.length > 0) {
    // 加载本次成功写入的 VatMapping（包含最新 vatRate + syncedAt）
    const mappings = await prisma.vatMapping.findMany({
      where: { shopId, vatId: { in: validVatIds } },
      select: { vatId: true, vatRate: true, syncedAt: true },
    });
    const mappingMap = new Map<number, { vatRate: number | null; syncedAt: Date | null }>();
    for (const m of mappings) {
      mappingMap.set(m.vatId, {
        vatRate:   m.vatRate ? Number(m.vatRate) : null,
        syncedAt:  m.syncedAt,
      });
    }

    // 找出需要回填的 StoreProduct（有 vatId 且 vatId 在 validVatIds 中）
    const spsToUpdate = await prisma.storeProduct.findMany({
      where: { shopId, isArchived: false, vatId: { in: validVatIds } },
      select: { id: true, vatId: true },
    });

    // 分块写入
    for (let i = 0; i < spsToUpdate.length; i += WRITE_CHUNK_SIZE) {
      const chunk = spsToUpdate.slice(i, i + WRITE_CHUNK_SIZE);
      try {
        await prisma.$transaction(
          chunk.map((sp) => {
            const mapping = mappingMap.get(sp.vatId!);
            return prisma.storeProduct.update({
              where: { id: sp.id },
              data:  {
                vatRate:     mapping?.vatRate    ?? null,
                vatSyncedAt: mapping?.syncedAt   ?? null,
              },
            });
          }),
        );
        backfilled += chunk.length;
      } catch (err: any) {
        console.error(`[VatSync] StoreProduct 回填 chunk[${i}] 失败:`, err.message ?? err);
      }
      if (i + WRITE_CHUNK_SIZE < spsToUpdate.length) await sleep(WRITE_CHUNK_DELAY);
    }

    console.log(`[VatSync] shopId=${shopId}(${shopName}) StoreProduct 回填完成：${backfilled} 条`);
  }

  // ── 清空无有效映射的产品 vatRate（API 成功后才执行，失败场景不触发）──
  //
  // 规则：API 调用已成功（rawEntries 来自真实 vat/read 响应）
  //   → 产品 vatId 不在 validVatIds 中（包括 AMBIGUOUS / INVALID / 未出现在 API 响应）
  //   → vatRate = null, vatSyncedAt = null
  //
  // 禁止把旧 VAT 税率继续挂在无有效映射的 vatId 上。
  // 仅在 vat/read 临时失败（整个 API 调用失败，提前 return）时保留旧映射。
  let cleared = 0;
  {
    // 找出当前店铺中 vatId 不在 validVatIds 中、但 vatRate 不为 null 的产品
    const staleWhere = {
      shopId,
      isArchived: false,
      vatId: { not: null },
      vatRate: { not: null },
      ...(validVatIds.length > 0 ? { NOT: { vatId: { in: validVatIds } } } : {}),
    };

    const staleProducts = await prisma.storeProduct.findMany({
      where:  staleWhere,
      select: { id: true, vatId: true },
    });

    if (staleProducts.length > 0) {
      const staleVatIds = [...new Set(staleProducts.map((p) => p.vatId))];
      console.log(
        `[VatSync] shopId=${shopId}(${shopName}) 检测到 ${staleProducts.length} 条产品 vatId 无有效映射，清空 vatRate/vatSyncedAt。` +
        `涉及 vatId: ${staleVatIds.join(', ')}`,
      );

      for (let i = 0; i < staleProducts.length; i += WRITE_CHUNK_SIZE) {
        const chunk = staleProducts.slice(i, i + WRITE_CHUNK_SIZE);
        try {
          await prisma.$transaction(
            chunk.map((sp) =>
              prisma.storeProduct.update({
                where: { id: sp.id },
                data:  { vatRate: null, vatSyncedAt: null },
              }),
            ),
          );
          cleared += chunk.length;
        } catch (err: any) {
          console.error(`[VatSync] 清空 stale vatRate chunk[${i}] 失败:`, err.message ?? err);
        }
        if (i + WRITE_CHUNK_SIZE < staleProducts.length) await sleep(WRITE_CHUNK_DELAY);
      }

      console.log(`[VatSync] shopId=${shopId}(${shopName}) 无效 vatRate 清空完成：${cleared} 条`);
    }
  }

  const finalStatus: VatSyncResult['status'] =
    (invalid > 0 || ambiguous > 0) && upserted > 0 ? 'PARTIAL'
    : upserted > 0 ? 'SUCCESS'
    : 'FAILED';

  return {
    shopId, shopName,
    status: upserted > 0 ? finalStatus : 'FAILED',
    vatMappingsUpserted: upserted,
    productsBackfilled: backfilled,
    productsCleared: cleared,
    ambiguousCount: ambiguous,
    invalidCount: invalid,
  };
}

/**
 * 批量同步所有 active eMAG 店铺的 VAT 映射。
 */
export async function syncVatMappingsForAllShops(
  options?: { force?: boolean },
): Promise<VatSyncResult[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
  });

  const results: VatSyncResult[] = [];
  for (const shop of shops) {
    const result = await syncVatMappingsForShop(shop.id, options);
    results.push(result);
  }

  const total = results.reduce((s, r) => s + r.vatMappingsUpserted, 0);
  const backfillTotal = results.reduce((s, r) => s + r.productsBackfilled, 0);
  console.log(
    `[VatSync] 全量完成：${shops.length} 家店铺，` +
    `upserted=${total}, backfilled=${backfillTotal}`,
  );

  return results;
}
