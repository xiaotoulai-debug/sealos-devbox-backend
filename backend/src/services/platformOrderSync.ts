/**
 * 平台订单全量同步 — 循环分页拉取 eMAG 订单并写入 PlatformOrder 表
 * 全状态抓取: status 1,2,3,4,5；24h 回溯窗口防漏单；本地状态以 eMAG 为准覆盖
 * eMAG 限制: 单次查询日期范围不超过 31 天 [cite: dashboardStats]
 */
import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';
import { readOrdersForAllStatuses, mapOrderForDisplay } from './emagOrder';
import type { EmagOrder } from './emagOrder';

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

function toDateTimeStr(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${toDateStr(d)} ${h}:${m}:${s}`;
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

async function upsertOrder(shopId: number, o: EmagOrder, region?: import('./emagClient').EmagRegion): Promise<void> {
  const mapped = mapOrderForDisplay(o, region);
  const orderTime = mapped.orderTime
    ? new Date(mapped.orderTime.replace(' ', 'T'))
    : new Date(0);

  await prisma.platformOrder.upsert({
    where: { shopId_emagOrderId: { shopId, emagOrderId: o.id } },
    create: {
      shopId,
      emagOrderId: o.id,
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
  const modifiedAfter = toDateTimeStr(start);
  const readRes = await readOrdersForAllStatuses(creds, {
    itemsPerPage: ITEMS_PER_PAGE,
    modifiedAfter,
  });

  if (readRes.isError && readRes.messages?.length) {
    result.errors.push(...readRes.messages);
  }

  const batch = Array.isArray(readRes.results) ? readRes.results : [];
  const inRange = batch.filter((o: any) => {
    const d = (o.date ?? o.created_at ?? '').toString().slice(0, 10);
    return d >= from && d <= to;
  });
  allOrders.push(...(inRange as EmagOrder[]));
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
 * 对所有（或指定）eMAG 店铺并发执行订单同步
 * @param incremental 若 true，仅拉取过去 24 小时（Cron 用）；新店始终强制 30 天历史回溯
 * @param windowMinutes 可选，覆盖为指定分钟数（如 30=订单哨兵）
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

  console.log(`[Sync] 开始并发同步 ${shops.length} 个店铺: ${shops.map((s) => `${s.shopName}(${s.region ?? 'RO'})`).join(', ')}`);

  // 并发同步所有店铺，单个失败不影响其他
  const settled = await Promise.allSettled(
    shops.map((shop) => syncPlatformOrdersForShop(shop.id, incremental, windowMinutes)),
  );

  const results: SyncResult[] = settled.map((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      const r = outcome.value;
      if (r.errors.length > 0) {
        r.errors.forEach((e) => console.error(`  [Sync] shop=${r.shopId} 错误: ${e}`));
      }
      return r;
    } else {
      const shopId = shops[i].id;
      const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.error(`[Sync] shop=${shopId} 同步异常: ${errMsg}`);
      return { shopId, totalFetched: 0, totalUpserted: 0, orderIds: [], pages: 0, errors: [errMsg] } as SyncResult;
    }
  });

  const total = results.reduce((s, r) => s + r.totalUpserted, 0);
  console.log(`[Sync] 全部完成: ${shops.length} 个店铺, 共入库 ${total} 条订单`);
  return results;
}
