/**
 * 实时业绩看板 — 多维度时间统计服务
 *
 * 【数据源】优先使用本地 platform_orders（已同步），fallback 到 eMAG API
 * 状态: 0=已取消, 1=新订单, 2=处理中, 3=已准备, 4=已完成, 5=已退货
 */

import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { EmagCredentials } from './emagClient';
import { readOrders, EmagOrder } from './emagOrder';

// ── 多店铺聚合统计类型 ────────────────────────────────────────────────

export interface ShopDailyStat {
  date: string;        // YYYY-MM-DD
  orderCount: number;
}

export interface ShopStats {
  shopId: number;
  shopName: string;
  region: string | null;
  totalOrders: number;
  daily: ShopDailyStat[];
}

export interface MultiShopStats {
  startDate: string;
  endDate: string;
  totalOrders: number;
  /** 每天大盘汇总 + 各店分量（用于前端多折线图） */
  trend_data: Array<{
    date: string;                        // MM-DD 格式，方便前端做图表 X 轴
    order_count: number;                 // 当天全部店铺合计
    by_shop: Record<string, number>;     // shopId(string) → 当天单量
  }>;
  /** 每家店铺独立汇总（用于前端排行/饼图） */
  byShop: ShopStats[];
  dataSource: 'platform_orders';
}

// ── 全局大盘双块统计类型（新版，废弃 GMV）───────────────────────────

/** 数据块 A：某天某店铺的订单量（用于前端多折线图） */
export interface DailyTrendItem {
  date: string;        // YYYY-MM-DD
  shopId: number;      // 唯一标识（同名不同区域的店铺通过此字段区分）
  shopName: string;
  region: string;
  orderCount: number;  // camelCase
  order_count: number; // snake_case 别名（兼容前端约定）
}

/** 数据块 B：某店铺在昨日 / 近7天 / 近30天的汇总单量（用于数据表格） */
export interface StoreSummaryItem {
  shopId: number;
  shopName: string;
  region: string;
  // camelCase（标准）
  yesterdayOrders:  number;
  last7DaysOrders:  number;
  last30DaysOrders: number;
  // snake_case 别名（兼容前端约定）
  yesterday_orders:    number;
  last_7_days_orders:  number;
  last_30_days_orders: number;
}

export interface GlobalDashboardStats {
  /** 基准日期（今天 UTC，YYYY-MM-DD） */
  today: string;
  /** 数据块 A：近30天每日×每店铺单量序列 */
  dailyTrends: DailyTrendItem[];
  /** 数据块 B：每店昨日/近7天/近30天单量汇总 */
  storeSummaries: StoreSummaryItem[];
  dataSource: 'platform_orders';
}

// 订单状态: 1=New, 2=In progress, 3=Prepared, 4=Finalized, 5=Cancelled
const STATUS_NEW = 1;
const STATUS_IN_PROGRESS = 2;
const STATUS_PREPARED = 3;
const STATUS_FINALIZED = 4;
const STATUS_CANCELLED = 5;

/** eMAG 单次查询最大天数 */
const MAX_DAYS_PER_CHUNK = 31;

/** 批次间间隔(ms)，确保不超 12 req/sec */
const CHUNK_DELAY_MS = 100;

export interface DailyStat {
  date: string;           // YYYY-MM-DD
  orders: number;
  gmv: number;
  byStatus: {
    new: number;
    inProgress: number;
    prepared: number;
    finalized: number;
    cancelled: number;
  };
}

export interface DashboardStats {
  startDate: string;
  endDate: string;
  totalOrders: number;
  totalGmv: number;
  daily: DailyStat[];
  results: string[];           // eMAG 订单 ID 列表（BigInt 序列化为字符串，防 JS 精度丢失）
  dataSource: 'emag_api' | 'platform_orders';  // emag_api=API 拉取，platform_orders=本地已同步
}

/** 兼容旧版：单日统计（无 startDate/endDate 时） */
export interface DashboardStatsLegacy {
  date: string;
  totalOrders: number;
  gmv: number;
  byStatus: {
    new: number;
    inProgress: number;
    prepared: number;
    finalized: number;
    cancelled: number;
  };
  results: string[];
  dataSource: 'emag_api' | 'platform_orders';
}

/**
 * 获取今日起止时间 (UTC)
 */
function getTodayRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;
  return { from: dateStr, to: dateStr };
}

/**
 * 解析日期字符串，返回 YYYY-MM-DD
 */
function parseDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 将日期范围拆分为不超过 31 天的批次
 */
function splitDateRange(start: string, end: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cur = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');

  while (cur <= endDate) {
    const chunkStart = cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + MAX_DAYS_PER_CHUNK);
    const chunkEnd = cur > endDate
      ? end
      : new Date(cur.getTime() - 1).toISOString().slice(0, 10);
    chunks.push({ from: chunkStart, to: chunkEnd });
    cur = new Date(chunkEnd + 'T00:00:00.000Z');
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return chunks;
}

/**
 * 计算单笔订单 GMV: 产品销售额 + 运费 - 优惠券折扣
 * 数据来源: 仅用 eMAG 订单中的 products[].sale_price/quantity，不依赖本地 Product/StoreProduct
 * 即便 ERP 尚未同步该产品，也先统计 GMV 金额
 */
function calcOrderGmv(order: EmagOrder): number {
  let productsTotal = 0;
  if (Array.isArray(order.products)) {
    for (const p of order.products) {
      const price = Number(p.sale_price ?? 0);
      const qty = Number(p.quantity ?? 0);
      productsTotal += price * qty;
    }
  }
  const shipping = Number(
    order.shipping_cost ?? order.shipping_cost_vat ?? order.shipping ?? 0
  );
  const voucher = Number(
    order.voucher ?? order.voucher_amount ?? order.discount ?? order.coupon ?? 0
  );
  return productsTotal + shipping - voucher;
}

/**
 * 分页拉取指定日期范围内的订单（遵守 12 req/sec 限速）
 */
async function fetchOrdersInRange(
  creds: EmagCredentials,
  from: string,
  to: string,
): Promise<EmagOrder[]> {
  const PAGE_SIZE = 100;
  const all: EmagOrder[] = [];
  let page = 1;

  while (true) {
    const r = await readOrders(creds, {
      createdAfter: `${from} 00:00:00`,
      createdBefore: `${to} 23:59:59`,
      currentPage: page,
      itemsPerPage: PAGE_SIZE,
    });

    if (r.isError || !Array.isArray(r.results)) break;
    const batch = r.results;
    for (const o of batch) {
      const orderDate = (o.date ?? o.created_at ?? '').toString().slice(0, 10);
      if (orderDate >= from && orderDate <= to) all.push(o);
    }
    if (batch.length < PAGE_SIZE) break;
    page++;
    if (page > 100) break; // 安全上限
  }

  return all;
}

/**
 * 无日期筛选时拉取订单（兼容 eMAG API 不支持 created 筛选的环境）
 */
async function fetchOrdersInRangeFallback(
  creds: EmagCredentials,
  from: string,
  to: string,
): Promise<EmagOrder[]> {
  const PAGE_SIZE = 100;
  const all: EmagOrder[] = [];
  let page = 1;

  while (true) {
    const r = await readOrders(creds, { currentPage: page, itemsPerPage: PAGE_SIZE });
    if (r.isError || !Array.isArray(r.results)) break;
    for (const o of r.results) {
      const orderDate = (o.date ?? o.created_at ?? '').toString().slice(0, 10);
      if (orderDate >= from && orderDate <= to) all.push(o);
    }
    if (r.results.length < PAGE_SIZE) break;
    page++;
    if (page > 50) break;
  }

  return all;
}

/**
 * 拉取日期范围内的全部订单（分批调用，突破 31 天限制）
 */
async function fetchOrdersInRangeBatched(
  creds: EmagCredentials,
  startDate: string,
  endDate: string,
): Promise<EmagOrder[]> {
  const chunks = splitDateRange(startDate, endDate);
  const all: EmagOrder[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { from, to } = chunks[i];
    let orders: EmagOrder[] = [];
    try {
      orders = await fetchOrdersInRange(creds, from, to);
      if (orders.length === 0 && i === 0) {
        orders = await fetchOrdersInRangeFallback(creds, from, to);
      }
    } catch {
      orders = await fetchOrdersInRangeFallback(creds, from, to);
    }
    all.push(...orders);
    if (i < chunks.length - 1) {
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    }
  }

  return all;
}

/**
 * 按日期汇总订单
 */
function aggregateByDate(orders: EmagOrder[]): Map<string, DailyStat> {
  const map = new Map<string, DailyStat>();

  const emptyStat = (): DailyStat['byStatus'] => ({
    new: 0,
    inProgress: 0,
    prepared: 0,
    finalized: 0,
    cancelled: 0,
  });

  for (const o of orders) {
    const dateStr = (o.date ?? o.created_at ?? '').toString().slice(0, 10);
    if (!dateStr) continue;

    let stat = map.get(dateStr);
    if (!stat) {
      stat = { date: dateStr, orders: 0, gmv: 0, byStatus: emptyStat() };
      map.set(dateStr, stat);
    }

    stat.orders++;
    const s = Number(o.status ?? 0);
    if (s === STATUS_NEW) stat.byStatus.new++;
    else if (s === STATUS_IN_PROGRESS) stat.byStatus.inProgress++;
    else if (s === STATUS_PREPARED) stat.byStatus.prepared++;
    else if (s === STATUS_FINALIZED) stat.byStatus.finalized++;
    else if (s === STATUS_CANCELLED) stat.byStatus.cancelled++;

    if (s !== STATUS_CANCELLED) {
      stat.gmv += calcOrderGmv(o);
    }
  }

  for (const stat of map.values()) {
    stat.gmv = Math.round(stat.gmv * 100) / 100;
  }

  return map;
}

/**
 * 从本地 platform_orders 获取仪表盘统计（优先使用，数据已同步）
 * 时间字段: order_time；排除 status=0(已取消)
 */
export async function getStatsFromLocalDB(
  shopId: number,
  startDate: string,
  endDate: string,
): Promise<DashboardStats> {
  const rangeStart = parseDate(startDate) || startDate;
  const rangeEnd = parseDate(endDate) || endDate;

  const orderTimeGte = new Date(`${rangeStart}T00:00:00.000Z`);
  const orderTimeLte = new Date(`${rangeEnd}T23:59:59.999Z`);

  const orders = await prisma.platformOrder.findMany({
    where: {
      shopId,
      orderTime: { gte: orderTimeGte, lte: orderTimeLte },
    },
    select: { id: true, emagOrderId: true, status: true, total: true, orderTime: true },
  });

  const dailyMap = new Map<string, DailyStat>();
  const emptyStat = (): DailyStat['byStatus'] => ({
    new: 0,
    inProgress: 0,
    prepared: 0,
    finalized: 0,
    cancelled: 0,
  });

  let totalOrders = 0;
  let totalGmv = 0;

  for (const o of orders) {
    const s = Number(o.status);
    const dateStr = o.orderTime.toISOString().slice(0, 10);

    let stat = dailyMap.get(dateStr);
    if (!stat) {
      stat = { date: dateStr, orders: 0, gmv: 0, byStatus: emptyStat() };
      dailyMap.set(dateStr, stat);
    }

    stat.orders++;
    totalOrders++;
    if (s === STATUS_NEW) stat.byStatus.new++;
    else if (s === STATUS_IN_PROGRESS) stat.byStatus.inProgress++;
    else if (s === STATUS_PREPARED) stat.byStatus.prepared++;
    else if (s === STATUS_FINALIZED) stat.byStatus.finalized++;
    else if (s === 0) stat.byStatus.cancelled++;

    if (s !== 0 && s !== STATUS_CANCELLED) {
      // 排除 0(已取消)、5(已退货)，GMV 仅统计有效订单
      const gmv = Number(o.total) || 0;
      stat.gmv += gmv;
      totalGmv += gmv;
    }
  }

  for (const stat of dailyMap.values()) {
    stat.gmv = Math.round(stat.gmv * 100) / 100;
  }

  const daily: DailyStat[] = [];
  const cur = new Date(rangeStart + 'T00:00:00.000Z');
  const end = new Date(rangeEnd + 'T00:00:00.000Z');
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    daily.push(
      dailyMap.get(d) ?? {
        date: d,
        orders: 0,
        gmv: 0,
        byStatus: emptyStat(),
      },
    );
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const results = orders.map((o) => String(o.emagOrderId));

  return {
    startDate: rangeStart,
    endDate: rangeEnd,
    totalOrders,
    totalGmv: Math.round(totalGmv * 100) / 100,
    daily,
    results,
    dataSource: 'platform_orders',
  };
}

/**
 * 获取指定日期范围内的业绩统计（分天汇总）
 */
export async function getStatsByDateRange(
  creds: EmagCredentials,
  startDate: string,
  endDate: string,
): Promise<DashboardStats> {
  const rangeStart = parseDate(startDate) || startDate;
  const rangeEnd = parseDate(endDate) || endDate;

  if (rangeStart > rangeEnd) {
    return {
      startDate: rangeStart,
      endDate: rangeEnd,
      totalOrders: 0,
      totalGmv: 0,
      daily: [],
      results: [],
      dataSource: 'emag_api',
    };
  }

  let orders: EmagOrder[] = [];
  try {
    orders = await fetchOrdersInRangeBatched(creds, rangeStart, rangeEnd);
  } catch (e) {
    console.error('[dashboardStats] fetchOrdersInRangeBatched 失败:', e instanceof Error ? e.message : e);
  }

  const dailyMap = aggregateByDate(orders);
  const daily: DailyStat[] = [];
  const cur = new Date(rangeStart + 'T00:00:00.000Z');
  const end = new Date(rangeEnd + 'T00:00:00.000Z');

  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10);
    daily.push(
      dailyMap.get(d) ?? {
        date: d,
        orders: 0,
        gmv: 0,
        byStatus: { new: 0, inProgress: 0, prepared: 0, finalized: 0, cancelled: 0 },
      },
    );
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const totalOrders = daily.reduce((s, x) => s + x.orders, 0);
  const totalGmv = daily.reduce((s, x) => s + x.gmv, 0);
  const results = orders.map((o) => String(o.id));

  return {
    startDate: rangeStart,
    endDate: rangeEnd,
    totalOrders,
    totalGmv: Math.round(totalGmv * 100) / 100,
    daily,
    results,
    dataSource: 'emag_api',
  };
}

/**
 * 多店铺聚合统计（全局大盘 + 按店分组）
 * - 不计 GMV，只做 count
 * - 在应用层按 shopId + date 分组，无需 raw SQL
 */
export async function getMultiShopStats(
  shopMeta: Array<{ id: number; shopName: string; region: string | null }>,
  startDate: string,
  endDate: string,
): Promise<MultiShopStats> {
  const rangeStart = parseDate(startDate) || startDate;
  const rangeEnd   = parseDate(endDate)   || endDate;

  const orderTimeGte = new Date(`${rangeStart}T00:00:00.000Z`);
  const orderTimeLte = new Date(`${rangeEnd}T23:59:59.999Z`);
  const shopIds      = shopMeta.map((s) => s.id);

  // 一次性拉取全部相关订单（仅需极少字段）
  const orders = await prisma.platformOrder.findMany({
    where: {
      shopId:    { in: shopIds },
      orderTime: { gte: orderTimeGte, lte: orderTimeLte },
    },
    select: { shopId: true, orderTime: true },
  });

  // ── 在应用层双重分组：shopId × date ────────────────────────────────
  // shopCountMap: shopId → (date → count)
  const shopCountMap = new Map<number, Map<string, number>>();
  for (const id of shopIds) shopCountMap.set(id, new Map());

  for (const o of orders) {
    const date = o.orderTime.toISOString().slice(0, 10);
    const dayMap = shopCountMap.get(o.shopId)!;
    dayMap.set(date, (dayMap.get(date) ?? 0) + 1);
  }

  // ── 构造连续日期轴（含零值补全）────────────────────────────────────
  const dates: string[] = [];
  const cur = new Date(rangeStart + 'T00:00:00.000Z');
  const end = new Date(rangeEnd   + 'T00:00:00.000Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // ── trend_data：大盘合计 + by_shop 分量 ────────────────────────────
  const trend_data = dates.map((date) => {
    const by_shop: Record<string, number> = {};
    let dayTotal = 0;
    for (const id of shopIds) {
      const cnt = shopCountMap.get(id)?.get(date) ?? 0;
      by_shop[String(id)] = cnt;
      dayTotal += cnt;
    }
    return {
      date:        date.slice(5),  // MM-DD
      order_count: dayTotal,
      by_shop,
    };
  });

  // ── byShop：每店汇总 + 每日序列 ────────────────────────────────────
  const shopMetaMap = new Map(shopMeta.map((s) => [s.id, s]));
  const byShop: ShopStats[] = shopIds.map((id) => {
    const meta    = shopMetaMap.get(id)!;
    const dayMap  = shopCountMap.get(id)!;
    const daily   = dates.map((date) => ({ date, orderCount: dayMap.get(date) ?? 0 }));
    const total   = daily.reduce((s, d) => s + d.orderCount, 0);
    return {
      shopId:      id,
      shopName:    meta.shopName,
      region:      meta.region,
      totalOrders: total,
      daily,
    };
  });

  // 按总单量降序，方便前端直接渲染排行
  byShop.sort((a, b) => b.totalOrders - a.totalOrders);

  return {
    startDate:   rangeStart,
    endDate:     rangeEnd,
    totalOrders: orders.length,
    trend_data,
    byShop,
    dataSource:  'platform_orders',
  };
}

/**
 * 获取今日业绩统计（兼容旧接口，无参数时）
 */
export async function getTodayStats(creds: EmagCredentials): Promise<DashboardStatsLegacy> {
  const range = getTodayRange();
  const result = await getStatsByDateRange(creds, range.from, range.to);

  const day = result.daily[0];
  return {
    date: range.from,
    totalOrders: result.totalOrders,
    gmv: result.totalGmv,
    byStatus: day?.byStatus ?? {
      new: 0,
      inProgress: 0,
      prepared: 0,
      finalized: 0,
      cancelled: 0,
    },
    results: result.results,
    dataSource: 'emag_api',
  };
}

/**
 * 全局大盘统计（新版，无 GMV，双块数据）
 *
 * 实现策略：
 *   1. 单次 Prisma 查询：拉取近30天所有活跃店铺的订单（仅 shopId + orderTime 两字段）
 *   2. 内存双层分组（shopId × date），派生出数据块 A 和数据块 B
 *   无需 raw SQL，无需多次并发查询，数据库压力极低。
 */
export async function getGlobalDashboardStats(): Promise<GlobalDashboardStats> {
  // ── 取所有活跃 eMAG 店铺 ─────────────────────────────────────────────
  const shops = await prisma.shopAuthorization.findMany({
    where:   { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select:  { id: true, shopName: true, region: true },
    orderBy: { shopName: 'asc' },
  });

  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  if (shops.length === 0) {
    return { today: todayStr, dailyTrends: [], storeSummaries: [], dataSource: 'platform_orders' };
  }

  const shopIds = shops.map((s) => s.id);

  // ── 计算关键日期边界（UTC 精确，避免 DST 误差）──────────────────────
  // 近30天：从 29 天前 00:00:00.000Z 至今天 23:59:59.999Z
  const start30 = new Date(now);
  start30.setUTCDate(now.getUTCDate() - 29);
  start30.setUTCHours(0, 0, 0, 0);

  const endOfToday = new Date(now);
  endOfToday.setUTCHours(23, 59, 59, 999);

  // 昨日、近7天的起始日期字符串（用于内存过滤，无需再查 DB）
  const yesterdayDate = new Date(now);
  yesterdayDate.setUTCDate(now.getUTCDate() - 1);
  const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

  const start7Date = new Date(now);
  start7Date.setUTCDate(now.getUTCDate() - 6);
  const start7Str = start7Date.toISOString().slice(0, 10);

  // ── 单次查询：近30天全部订单（极简字段）─────────────────────────────
  const orders = await prisma.platformOrder.findMany({
    where: {
      shopId:    { in: shopIds },
      orderTime: { gte: start30, lte: endOfToday },
    },
    select: { shopId: true, orderTime: true },
  });

  // ── 内存双层分组：shopId → (dateStr → count) ────────────────────────
  const shopDateMap = new Map<number, Map<string, number>>();
  for (const s of shops) shopDateMap.set(s.id, new Map());

  for (const o of orders) {
    const date   = o.orderTime.toISOString().slice(0, 10);
    const dayMap = shopDateMap.get(o.shopId);
    if (dayMap) dayMap.set(date, (dayMap.get(date) ?? 0) + 1);
  }

  // ── 生成连续30天日期轴（确保折线图无断点）──────────────────────────
  const dates: string[] = [];
  const cur = new Date(start30);
  while (cur <= endOfToday) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // ── 数据块 A：dailyTrends ────────────────────────────────────────────
  // 展开为平铺数组：每个 (date, shopId) 组合一条记录
  // 含零值记录，确保前端折线图连续；shopId 是唯一维度（同名跨区域店铺不重叠）
  // ★ 同时输出 camelCase(orderCount) 和 snake_case(order_count) 双命名，防字段名约定不一致
  const dailyTrends: DailyTrendItem[] = [];
  for (const date of dates) {
    for (const s of shops) {
      const cnt = shopDateMap.get(s.id)?.get(date) ?? 0;
      dailyTrends.push({
        date,
        shopId:      s.id,
        shopName:    s.shopName,
        region:      s.region ?? 'RO',
        orderCount:  cnt,
        order_count: cnt,
      });
    }
  }

  // ── 数据块 B：storeSummaries ─────────────────────────────────────────
  // 从已分组的内存数据中直接派生三个时间段，无需再查 DB
  // ★ 同时输出 camelCase 和 snake_case 双命名，防字段名约定不一致
  const storeSummaries: StoreSummaryItem[] = shops.map((s) => {
    const dayMap = shopDateMap.get(s.id)!;

    let yesterdayOrders  = 0;
    let last7DaysOrders  = 0;
    let last30DaysOrders = 0;

    for (const [date, count] of dayMap) {
      last30DaysOrders += count;
      if (date >= start7Str)     last7DaysOrders  += count;
      if (date === yesterdayStr) yesterdayOrders  += count;
    }

    return {
      shopId:              s.id,
      shopName:            s.shopName,
      region:              s.region ?? 'RO',
      // camelCase（标准）
      yesterdayOrders,
      last7DaysOrders,
      last30DaysOrders,
      // snake_case 别名
      yesterday_orders:    yesterdayOrders,
      last_7_days_orders:  last7DaysOrders,
      last_30_days_orders: last30DaysOrders,
    };
  });

  // 按近30天单量降序，方便前端表格默认排序
  storeSummaries.sort((a, b) => b.last30DaysOrders - a.last30DaysOrders);

  console.log(
    `[GlobalDashboard] today=${todayStr} shops=${shops.length} orders(30d)=${orders.length}` +
    ` dailyTrends=${dailyTrends.length} storeSummaries=${storeSummaries.length}`,
  );

  return {
    today: todayStr,
    dailyTrends,
    storeSummaries,
    dataSource: 'platform_orders',
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 新版一站式全局大盘接口（GET /api/dashboard/global-stats）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** $queryRaw 返回的聚合行结构 */
interface RawDailyGroup {
  shopId:     number;
  date:       string;   // YYYY-MM-DD（PostgreSQL DATE::text）
  orderCount: number;
}

export interface GlobalStatsV2 {
  generatedAt: string;
  dateRange:   { start: string; end: string };
  /**
   * 顶部卡片全局总计
   * ★ 使用固定周期（昨日/7天/30天），与趋势图日期参数无关
   */
  globalTotals: {
    totalOrders:     number;   // dateRange 趋势区间内合计
    yesterday:       number;   // 昨日全局单量
    week7:           number;   // 近7天全局单量
    month30:         number;   // 近30天全局单量
  };
  /** 向后兼容别名 */
  globalSummary: GlobalStatsV2['globalTotals'];
  /**
   * 各店汇总表（块 B）
   * ★ 字段名与前端表格列严格对齐：yesterday / week7 / month30
   * ★ 独立于 dateRange，固定统计昨日/7天/30天
   */
  storeSummaries: Array<{
    shopId:    number;
    shopName:  string;
    region:    string;
    yesterday: number;
    week7:     number;
    month30:   number;
  }>;
  /** 走势明细（块 A），dateRange 内每日×每店 */
  dailyTrends: Array<{
    date:        string;
    shopId:      number;
    shopName:    string;
    region:      string;
    orderCount:  number;
    order_count: number;   // snake_case 别名
  }>;
  dataSource: 'platform_orders';
}

/**
 * 一站式全局大盘聚合（新版）
 *
 * 实现策略（严格 2 次数据库操作，全程无 for 循环查库）：
 *   Query-1 (metadata)  : shopAuthorization.findMany — 取活跃店铺元数据
 *   Query-2 (aggregation): $queryRaw GROUP BY shop_id, DATE(order_time)
 *                         — 直接在 DB 层聚合，返回每日每店单量
 *
 * 两查通过 Promise.all 并行发起；内存派生 globalSummary / storeSummaries / dailyTrends。
 */
export async function getGlobalStatsV2(
  startDate?: string,
  endDate?:   string,
): Promise<GlobalStatsV2> {
  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // ── 1. 计算各关键日期边界 ───────────────────────────────────────────
  const toUTC = (dStr: string, endOfDay = false) =>
    new Date(`${dStr}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);

  // 固定统计周期（不受 startDate/endDate 影响）
  const yesterdayStr  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
  const start7Str     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6)).toISOString().slice(0, 10);
  const start30Str    = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);

  // 趋势图日期区间（前端传入，默认近 7 天）
  const trendStart = startDate ?? start7Str;
  const trendEnd   = endDate   ?? todayStr;

  // 趋势图查询范围（仅覆盖 trendStart ~ trendEnd，不扩展到30天）
  const queryEndStr = trendEnd > todayStr ? trendEnd : todayStr;

  // ── 固定时间边界（表格列独立于趋势图区间）────────────────────────────
  const ydayStart    = toUTC(yesterdayStr);
  const ydayEnd      = toUTC(yesterdayStr, true);
  const week7Start   = toUTC(start7Str);
  const month30Start = toUTC(start30Str);
  const endOfToday   = toUTC(todayStr, true);

  // ── Promise.all 并行 5 查（全程无阻塞）──────────────────────────────
  //   Q1  shopAuthorization.findMany         — 店铺元数据
  //   Q2  $queryRaw GROUP BY date+shopId     — 趋势图每日明细
  //   Q3  groupBy shopId  昨日              — 表格固定列 yesterday
  //   Q4  groupBy shopId  近7天             — 表格固定列 week7
  //   Q5  groupBy shopId  近30天            — 表格固定列 month30
  const [shops, rawGroups, ydayGroups, week7Groups, month30Groups] = await Promise.all([
    // Q1
    prisma.shopAuthorization.findMany({
      where:   { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
      select:  { id: true, shopName: true, region: true },
      orderBy: { shopName: 'asc' },
    }),
    // Q2 — 趋势图每日分组（$queryRaw 支持 GROUP BY DATE）
    prisma.$queryRaw<RawDailyGroup[]>(
      Prisma.sql`
        SELECT
          shop_id::int            AS "shopId",
          DATE(order_time)::text  AS date,
          COUNT(*)::int           AS "orderCount"
        FROM platform_orders
        WHERE order_time >= ${toUTC(trendStart)}
          AND order_time <= ${toUTC(queryEndStr, true)}
        GROUP BY shop_id, DATE(order_time)
        ORDER BY date ASC, shop_id ASC
      `,
    ),
    // Q3 — 昨日固定统计（groupBy 轻量聚合）
    prisma.platformOrder.groupBy({
      by:     ['shopId'],
      _count: { id: true },
      where:  { orderTime: { gte: ydayStart, lte: ydayEnd } },
    }),
    // Q4 — 近7天固定统计
    prisma.platformOrder.groupBy({
      by:     ['shopId'],
      _count: { id: true },
      where:  { orderTime: { gte: week7Start, lte: endOfToday } },
    }),
    // Q5 — 近30天固定统计
    prisma.platformOrder.groupBy({
      by:     ['shopId'],
      _count: { id: true },
      where:  { orderTime: { gte: month30Start, lte: endOfToday } },
    }),
  ]);

  if (shops.length === 0) {
    const emptyTotals = { totalOrders: 0, yesterday: 0, week7: 0, month30: 0 };
    return {
      generatedAt:    now.toISOString(),
      dateRange:      { start: trendStart, end: trendEnd },
      globalTotals:   emptyTotals,
      globalSummary:  emptyTotals,
      storeSummaries: [],
      dailyTrends:    [],
      dataSource:     'platform_orders',
    };
  }

  // ── 建立活跃店铺 Set ──────────────────────────────────────────────────
  const activeShopIds = new Set(shops.map((s) => s.id));

  // ── 数据块 B：storeSummaries（表格固定列）────────────────────────────
  // 直接从 3 次 groupBy 结果建 Map，O(1) 查找
  const ydayMap    = new Map(ydayGroups.map(r    => [r.shopId, r._count.id]));
  const week7Map   = new Map(week7Groups.map(r   => [r.shopId, r._count.id]));
  const month30Map = new Map(month30Groups.map(r => [r.shopId, r._count.id]));

  const storeSummaries: GlobalStatsV2['storeSummaries'] = shops
    .map((s) => ({
      shopId:    s.id,
      shopName:  s.shopName,
      region:    s.region ?? 'RO',
      yesterday: ydayMap.get(s.id)    ?? 0,   // 昨日（固定）
      week7:     week7Map.get(s.id)   ?? 0,   // 近7天（固定）
      month30:   month30Map.get(s.id) ?? 0,   // 近30天（固定）
    }))
    .sort((a, b) => b.month30 - a.month30);

  // ── 趋势图内存分组：shopId → date → count ─────────────────────────
  const shopDateMap = new Map<number, Map<string, number>>();
  for (const s of shops) shopDateMap.set(s.id, new Map());

  for (const row of rawGroups) {
    const sid = Number(row.shopId);
    if (!activeShopIds.has(sid)) continue;
    shopDateMap.get(sid)?.set(row.date, Number(row.orderCount));
  }

  // ── 数据块 A：dailyTrends（连续日期轴，含零值，折线图无断点）────────
  const trendDates: string[] = [];
  const cur     = new Date(trendStart + 'T00:00:00.000Z');
  const endCur  = new Date(trendEnd   + 'T00:00:00.000Z');
  while (cur <= endCur) {
    trendDates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const dailyTrends: GlobalStatsV2['dailyTrends'] = [];
  for (const date of trendDates) {
    for (const s of shops) {
      const cnt = shopDateMap.get(s.id)?.get(date) ?? 0;
      dailyTrends.push({
        date,
        shopId:      s.id,
        shopName:    s.shopName,
        region:      s.region ?? 'RO',
        orderCount:  cnt,
        order_count: cnt,
      });
    }
  }

  // ── 顶部卡片全局总计（从 storeSummaries 汇总，与表格数据源一致）────
  const globalTotals: GlobalStatsV2['globalTotals'] = {
    totalOrders: dailyTrends.reduce((s, r) => s + r.orderCount, 0),
    yesterday:   storeSummaries.reduce((s, r) => s + r.yesterday, 0),
    week7:       storeSummaries.reduce((s, r) => s + r.week7,     0),
    month30:     storeSummaries.reduce((s, r) => s + r.month30,   0),
  };

  console.log(
    `[global-stats] trend=${trendStart}~${trendEnd}` +
    ` | totalOrders=${globalTotals.totalOrders}` +
    ` | yday=${globalTotals.yesterday}` +
    ` | 7d=${globalTotals.week7}` +
    ` | 30d=${globalTotals.month30}` +
    ` | shops=${shops.length} trendRows=${rawGroups.length}`,
  );

  return {
    generatedAt:   now.toISOString(),
    dateRange:     { start: trendStart, end: trendEnd },
    globalTotals,
    globalSummary: globalTotals,   // 向后兼容别名
    storeSummaries,
    dailyTrends,
    dataSource: 'platform_orders',
  };
}
