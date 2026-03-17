/**
 * 实时业绩看板 — 多维度时间统计服务
 *
 * 【数据源】优先使用本地 platform_orders（已同步），fallback 到 eMAG API
 * 状态: 0=已取消, 1=新订单, 2=处理中, 3=已准备, 4=已完成, 5=已退货
 */

import { prisma } from '../lib/prisma';
import { EmagCredentials } from './emagClient';
import { readOrders, EmagOrder } from './emagOrder';

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
  results: number[];           // eMAG 返回的订单 ID 列表（空即无数据，如新授权店铺）
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
  results: number[];
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

  const results = orders.map((o) => o.emagOrderId);

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
  const results = orders.map((o) => o.id);

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
