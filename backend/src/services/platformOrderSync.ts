/**
 * 平台订单全量同步 — 循环分页拉取 eMAG 订单并写入 PlatformOrder 表
 * 全状态抓取: status 1,2,3,4,5；双轮扫描（modified + created）彻底防漏单
 * eMAG 限制: 单次查询日期范围不超过 31 天 [cite: dashboardStats]
 */
import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';
import { readOrdersForAllStatuses, mapOrderForDisplay } from './emagOrder';
import type { EmagOrder } from './emagOrder';
import { formatInTimeZone } from 'date-fns-tz';

/**
 * 将 eMAG 返回的罗马尼亚本地时间字符串转为 UTC Date 对象
 *
 * eMAG API 返回的 date 字段为罗马尼亚本地时间（EET UTC+2 / EEST UTC+3），
 * 但格式中不含时区标识（如 "2026-03-21 23:30:00"）。
 * 直接 `new Date("2026-03-21T23:30:00")` 会被解析为 UTC，导致实际存储偏移 2~3 小时。
 *
 * 本函数通过强制追加 "+02:00"（冬令 EET）或 "+03:00"（夏令 EEST）后再构造 Date，
 * 让 JS 正确转为 UTC 时间戳。
 *
 * 罗马尼亚 DST 规则：3 月最后一个周日 03:00 → +03:00，10 月最后一个周日 04:00 → +02:00
 */
function emagLocalToUtc(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const normalized = dateStr.trim().replace(' ', 'T');
  const year = parseInt(normalized.slice(0, 4), 10);
  const month = parseInt(normalized.slice(5, 7), 10);
  const day = parseInt(normalized.slice(8, 10), 10);

  const offset = isRomanianDST(year, month, day) ? '+03:00' : '+02:00';
  return new Date(`${normalized}${offset}`);
}

function isRomanianDST(year: number, month: number, day: number): boolean {
  if (month < 3 || month > 10) return false;
  if (month > 3 && month < 10) return true;
  // 3 月：最后一个周日之后
  if (month === 3) {
    const lastSunday = 31 - new Date(year, 2, 31).getDay();
    return day >= lastSunday;
  }
  // 10 月：最后一个周日之前
  const lastSunday = 31 - new Date(year, 9, 31).getDay();
  return day < lastSunday;
}

const ITEMS_PER_PAGE = 100;  // 推荐稳定值 [cite: 1384, 1397]
const MAX_DAYS_PER_CHUNK = 31;  // eMAG 单次查询最大天数
const SYNC_DAYS_FULL = 365;     // 全量同步时间窗口
const SYNC_DAYS_NEW_SHOP = 30;  // 新店首同步历史回溯天数（无本地记录时触发）
const SYNC_HOURS_INCREMENTAL = 24;  // 增量同步回溯窗口（小时）
const SYNC_MINUTES_SENTINEL = 30;   // 订单哨兵回溯窗口（分钟）
const CHUNK_DELAY_MS = 100;    // 批次间限速

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** @deprecated 使用本地时间（UTC 服务器上等同 UTC），发给 eMAG 会产生 2-3h 时区偏差，已被 toRomanianTimeStr 替代 */
function toDateTimeStr(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${toDateStr(d)} ${h}:${m}:${s}`;
}

/**
 * 将 UTC Date 转为罗马尼亚本地时间字符串（eMAG API 过滤参数专用）
 *
 * 使用 date-fns-tz formatInTimeZone + IANA tz 'Europe/Bucharest'，
 * 自动处理 EET(UTC+2) / EEST(UTC+3) 夏令冬令切换，无需手写 DST 逻辑。
 * 替代原有 toDateTimeStr（在 UTC 服务器上产生 2-3h 偏差的根因）。
 */
const RO_TZ = 'Europe/Bucharest';
function toRomanianTimeStr(utcDate: Date): string {
  return formatInTimeZone(utcDate, RO_TZ, 'yyyy-MM-dd HH:mm:ss');
}

/** 将日期范围拆分为不超过 31 天的批次 */
function splitDateRange(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cur = new Date(from + 'T00:00:00.000Z');
  const endDate = new Date(to + 'T23:59:59.999Z');

  while (cur <= endDate) {
    const chunkStart = cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + MAX_DAYS_PER_CHUNK);
    const chunkEnd = cur > endDate
      ? to
      : new Date(cur.getTime() - 1).toISOString().slice(0, 10);
    chunks.push({ from: chunkStart, to: chunkEnd });
    cur = new Date(chunkEnd + 'T00:00:00.000Z');
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return chunks;
}

export interface SyncResult {
  shopId: number;
  totalFetched: number;
  totalUpserted: number;
  orderIds: number[];
  pages: number;
  errors: string[];
}

export async function upsertOrderPublic(shopId: number, o: EmagOrder, region?: import('./emagClient').EmagRegion): Promise<void> {
  return upsertOrder(shopId, o, region);
}

async function upsertOrder(shopId: number, o: EmagOrder, region?: import('./emagClient').EmagRegion): Promise<void> {
  const mapped = mapOrderForDisplay(o, region);
  const orderTime = mapped.orderTime
    ? emagLocalToUtc(mapped.orderTime)
    : new Date(0);

  await prisma.platformOrder.upsert({
    where: { shopId_emagOrderId: { shopId, emagOrderId: BigInt(o.id) } },
    create: {
      shopId,
      emagOrderId: BigInt(o.id),
      status: mapped.status,
      statusText: mapped.status_text,
      orderTime,
      orderType: mapped.type ?? null,
      paymentMode: mapped.payment_mode ?? null,
      total: mapped.total,
      currency: mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson: JSON.stringify(o),
    },
    update: {
      status: mapped.status,
      statusText: mapped.status_text,
      orderTime,
      orderType: mapped.type ?? null,
      paymentMode: mapped.payment_mode ?? null,
      total: mapped.total,
      currency: mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson: JSON.stringify(o),
      syncedAt: new Date(),
    },
  });
}

/**
 * 对单个店铺执行订单同步（全状态 1,2,3,4,5，强制以 eMAG 为准覆盖本地）
 * @param shopId 店铺 ID
 * @param incremental 若 true，仅拉取过去 24 小时；否则拉取近 365 天
 * @param windowMinutes 可选，覆盖增量窗口为指定分钟数（如 30=订单哨兵）
 *
 * 新店自动回溯：若本地 PlatformOrder 表中该店铺无任何记录，
 * 无论 incremental 是否为 true，都强制回溯 SYNC_DAYS_NEW_SHOP(30) 天历史订单。
 */
export async function syncPlatformOrdersForShop(
  shopId: number,
  incremental = false,
  windowMinutes?: number,
): Promise<SyncResult> {
  const result: SyncResult = { shopId, totalFetched: 0, totalUpserted: 0, orderIds: [], pages: 0, errors: [] };
  let creds;
  try {
    creds = await getEmagCredentials(shopId);
  } catch (e) {
    result.errors.push(`获取店铺凭证失败: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // ── 新店检测：本地无订单时强制历史回溯 ──────────────────────────
  const localCount = await prisma.platformOrder.count({ where: { shopId } });
  const isNewShop = localCount === 0;

  const end = new Date();
  const start = new Date();
  if (windowMinutes != null) {
    start.setMinutes(start.getMinutes() - windowMinutes);
  } else if (isNewShop) {
    // 新店首同步：强制拉取 30 天历史，无论外部是否传 incremental=true
    start.setDate(start.getDate() - SYNC_DAYS_NEW_SHOP);
  } else if (incremental) {
    start.setHours(start.getHours() - SYNC_HOURS_INCREMENTAL);
  } else {
    start.setDate(start.getDate() - SYNC_DAYS_FULL);
  }
  const from = toDateStr(start);
  const to   = toDateStr(end);

  const syncMode = isNewShop
    ? `新店历史回溯(${SYNC_DAYS_NEW_SHOP}天)`
    : windowMinutes != null ? `哨兵(${windowMinutes}min)`
    : incremental ? '增量(24h)' : `全量(${SYNC_DAYS_FULL}天)`;

  console.log(
    `[Sync] shopId=${shopId} region=${creds.region} baseUrl=${creds.baseUrl}` +
    ` mode=${syncMode} window=${from}~${to}` +
    (isNewShop ? ` [新店首同步, 本地记录=${localCount}]` : ''),
  );

  const allOrders: EmagOrder[] = [];

  // ★ 嫌疑 A + B 根治：
  //   1. toRomanianTimeStr 修复时区偏差（原 toDateTimeStr 在 UTC 服务器发给 eMAG 有 2-3h 偏移）
  //   2. 同时传入 modifiedAfter + createdAfter，双轮扫描确保"新建但未修改"的订单不再漏单
  const modifiedAfter = toRomanianTimeStr(start);
  const createdAfter  = toRomanianTimeStr(start);

  // ★ readOrdersForAllStatuses 主轮（modified）失败会抛出明确错误（防漏单铁律）
  //   created 轮失败仅打印警告，不中断主流程（已在 readOrdersForAllStatuses 内部处理）
  //   此处 try/catch 兜住主轮失败，写入 result.errors 并立即返回
  let readRes: Awaited<ReturnType<typeof readOrdersForAllStatuses>>;
  try {
    readRes = await readOrdersForAllStatuses(creds, {
      itemsPerPage: ITEMS_PER_PAGE,
      modifiedAfter,
      createdAfter,
    });
  } catch (fetchErr: any) {
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error(`[Sync] shopId=${shopId} 拉取订单失败（已中止，不入库）：${errMsg}`);
    result.errors.push(errMsg);
    return result;   // ← 立即返回空结果，绝不用已拉取的部分数据做假 200
  }

  // 直接全盘接收 eMAG 按 modified.from 返回的所有订单，不再按创建日期做二次过滤
  // （原 inRange 过滤器会将跨天边界订单及昨日改状态订单错误丢弃，已拆除）
  const batch = Array.isArray(readRes.results) ? readRes.results : [];
  allOrders.push(...(batch as EmagOrder[]));
  result.pages = 1;

  const seen = new Set<number>();
  for (const o of allOrders) {
    if (!o?.id || seen.has(o.id)) continue;
    seen.add(o.id);
    try {
      await upsertOrder(shopId, o, creds.region);
      result.totalUpserted++;
      result.orderIds.push(o.id);
    } catch (e) {
      result.errors.push(`order ${o.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  result.totalFetched = allOrders.length;

  // ── 结构化同步结果日志 ────────────────────────────────────────────
  console.log(
    `[Sync] Shop: ${creds.region}, BaseURL: ${creds.baseUrl},` +
    ` Fetched: ${result.totalFetched} orders, Upserted: ${result.totalUpserted}` +
    (result.errors.length > 0 ? `, Errors: ${result.errors.length}` : ''),
  );

  return result;
}

/**
 * 强制同步单笔订单（按 id 拉取并 upsert，以 eMAG 为准覆盖）
 */
export async function syncPlatformOrderById(shopId: number, orderId: number): Promise<{ ok: boolean; total?: number; status_text?: string; error?: string }> {
  const { readOrders, mapOrderForDisplay } = await import('./emagOrder');
  const creds = await getEmagCredentials(shopId);
  const readRes = await readOrders(creds, { id: orderId });
  if (readRes.isError || !Array.isArray(readRes.results) || readRes.results.length === 0) {
    return { ok: false, error: readRes.messages?.join('; ') ?? '订单不存在' };
  }
  const o = readRes.results[0] as EmagOrder;
  await upsertOrder(shopId, o, creds.region);
  const mapped = mapOrderForDisplay(o, creds.region);
  return { ok: true, total: mapped.total, status_text: mapped.status_text };
}

/**
 * 对所有（或指定）eMAG 店铺【并发】执行订单同步
 *
 * 架构设计：
 *   - 使用 Promise.allSettled 并发启动所有店铺的同步任务
 *   - 底层 emagClient 已内置全局并发上限(5) + 令牌桶限流(12 req/s)，无需手动串行
 *   - 任意店铺失败（rejected）不会阻塞其他店铺，也不会让整个调度崩溃
 *   - 失败店铺记录到 result.errors，最终汇总日志明确区分成功/失败数量
 *
 * 并发安全：底层 emagApiCall 已有：
 *   ① TokenBucketThrottle: 订单 12 req/s、其他 3 req/s
 *   ② MAX_CONCURRENT = 5 全局并发上限
 *   ③ 网络超时 60s + 指数退避重试 3 次
 *
 * @param incremental 若 true，仅拉取过去 24 小时；新店始终强制 30 天历史回溯
 * @param windowMinutes 可选，覆盖增量窗口为指定分钟数（如 30=订单哨兵）
 * @param shopIdFilter 可选，限定同步的店铺 ID 列表；不传则同步全部活跃店铺
 */
export async function syncAllPlatformOrders(
  incremental = false,
  windowMinutes?: number,
  shopIdFilter?: number[],
): Promise<SyncResult[]> {
  const where: any = { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' };
  if (shopIdFilter && shopIdFilter.length > 0) {
    where.id = { in: shopIdFilter };
  }

  const shops = await prisma.shopAuthorization.findMany({
    where,
    select: { id: true, shopName: true, region: true },
  });

  if (shops.length === 0) {
    console.log('[Sync] 无活跃 eMAG 店铺，跳过同步');
    return [];
  }

  console.log(
    `[Sync] 开始并发同步 ${shops.length} 个店铺: ` +
    shops.map((s) => `${s.shopName}(${s.region ?? 'RO'})`).join(', '),
  );

  // ── Promise.allSettled：并发启动全部店铺，互不阻塞 ─────────────────
  const settled = await Promise.allSettled(
    shops.map((shop) => syncPlatformOrdersForShop(shop.id, incremental, windowMinutes)),
  );

  // ── 汇总结果：fulfilled → 成功，rejected → 隔离失败不传染 ──────────
  const results: SyncResult[] = [];
  let successCount = 0;
  let failCount    = 0;

  settled.forEach((outcome, idx) => {
    const shop = shops[idx];

    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      results.push(r);

      if (r.errors.length > 0) {
        // 有局部错误（如某些状态页超时），但仍入库了部分数据 → partial
        console.warn(
          `[Sync] ⚠️  shop=${shop.id}(${shop.shopName}) partial: ` +
          `入库=${r.totalUpserted} 局部错误=${r.errors.length}条`,
        );
        r.errors.forEach((e) => console.warn(`   └─ ${e}`));
        failCount++;
      } else {
        console.log(
          `[Sync] ✅ shop=${shop.id}(${shop.shopName}) 成功: ` +
          `入库=${r.totalUpserted} 拉取=${r.totalFetched}`,
        );
        successCount++;
      }
    } else {
      // Promise 被 reject：记录明确错误，不影响其他店铺
      const errMsg = outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
      console.error(
        `[Sync] ❌ shop=${shop.id}(${shop.shopName}) 失败（已隔离）: ${errMsg}`,
      );
      results.push({
        shopId:        shop.id,
        totalFetched:  0,
        totalUpserted: 0,
        orderIds:      [],
        pages:         0,
        errors:        [errMsg],
      });
      failCount++;
    }
  });

  // ── 汇总日志 ─────────────────────────────────────────────────────────
  const totalUpserted = results.reduce((s, r) => s + r.totalUpserted, 0);
  console.log(
    `[Sync] 全部完成: ${shops.length} 个店铺 ` +
    `(成功=${successCount} 失败/partial=${failCount}), ` +
    `共入库 ${totalUpserted} 条订单`,
  );

  return results;
}
