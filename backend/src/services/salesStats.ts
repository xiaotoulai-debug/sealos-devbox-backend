/**
 * 平台产品销量统计 Service
 *
 * 使用原始 SQL 直接聚合 platform_orders.products_json
 * 状态：必须包含 status=4(已完成)，即 status IN (1,2,3,4)
 * SKU 清理：TRIM(REPLACE(REPLACE(sku, '\r', ''), '\n', ''))
 */

import { prisma } from '../lib/prisma';

export interface SalesStats {
  d3: number;
  d7: number;
  d14: number;
  d30: number;
  d60: number;
  d90: number;
  d180?: number;
  lastOrderAt?: Date | string | null;
}

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 分钟
const cache = new Map<number, { data: Map<string, SalesStats>; expiresAt: number }>();

function normalizeSku(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .trim()
    .toLowerCase();
}

function normalizePnk(s: string | null | undefined): string {
  return normalizeSku(s);
}

function pnkKey(pnk: string): string {
  return `pnk:${pnk}`;
}

function emptySalesStats(): SalesStats {
  return { d3: 0, d7: 0, d14: 0, d30: 0, d60: 0, d90: 0, d180: 0, lastOrderAt: null };
}

function mergeStats(target: SalesStats, source: SalesStats): SalesStats {
  return {
    d3: target.d3 + source.d3,
    d7: target.d7 + source.d7,
    d14: target.d14 + source.d14,
    d30: target.d30 + source.d30,
    d60: target.d60 + source.d60,
    d90: target.d90 + source.d90,
    d180: Number(target.d180 ?? 0) + Number(source.d180 ?? 0),
    lastOrderAt: [target.lastOrderAt, source.lastOrderAt]
      .map((d) => d instanceof Date ? d : (d ? new Date(d) : null))
      .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  };
}

export interface SalesStatsResult {
  map: Map<string, SalesStats>;
  skusWithSales: string[];
}

/**
 * 清除销量缓存
 */
export function clearSalesCache(shopId?: number): void {
  if (shopId != null) cache.delete(shopId);
  else cache.clear();
}

/**
 * 获取指定店铺的 SKU 销量统计
 */
export async function getSalesStatsByShop(shopId: number, forceRefresh = false): Promise<SalesStatsResult> {
  if (forceRefresh) cache.delete(shopId);
  const now = Date.now();
  const cached = cache.get(shopId);
  if (cached && cached.expiresAt > now) {
    return { map: cached.data, skusWithSales: [...cached.data.keys()] };
  }

  const { map, skusWithSales } = await aggregateSalesForShop(shopId);
  cache.set(shopId, { data: map, expiresAt: now + CACHE_TTL_MS });
  return { map, skusWithSales };
}

/**
 * 原始 SQL 聚合：platform_orders.products_json 等价于 order_items
 * SELECT sku, SUM(CAST(quantity AS INT)) FROM platform_orders (解析 JSON) GROUP BY sku
 */
async function aggregateSalesForShop(shopId: number): Promise<{ map: Map<string, SalesStats>; skusWithSales: string[] }> { // shopId 用于通用诊断日志
  const now = new Date();
  const d3 = new Date(now);
  d3.setDate(d3.getDate() - 3);
  const d7 = new Date(now);
  d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now);
  d14.setDate(d14.getDate() - 14);
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);
  const d60 = new Date(now);
  d60.setDate(d60.getDate() - 60);
  const d90 = new Date(now);
  d90.setDate(d90.getDate() - 90);
  const d180 = new Date(now);
  d180.setDate(d180.getDate() - 180);

  const baseWhere = `shop_id = ${shopId} AND (status = 4 OR status IN (1,2,3,4)) AND order_time >= '${d180.toISOString().slice(0, 10)}'`;
  const skuExpr = `LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\\\r', ''), E'\\\\n', '')))`;
  const pnkExpr = `LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'pnk', ''), E'\\\\r', ''), E'\\\\n', '')))`;
  const qtyExpr = `COALESCE((elem->>'quantity')::int, 0)`;

  const rows = await prisma.$queryRawUnsafe<Array<{
    sku: string | null;
    pnk: string | null;
    d3: string | number;
    d7: string | number;
    d14: string | number;
    d30: string | number;
    d60: string | number;
    d90: string | number;
    d180: string | number;
    last_order_at: Date | string | null;
  }>>(
    `SELECT ${skuExpr} as sku,
            ${pnkExpr} as pnk,
            SUM(CASE WHEN order_time >= '${d3.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d3,
            SUM(CASE WHEN order_time >= '${d7.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d7,
            SUM(CASE WHEN order_time >= '${d14.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d14,
            SUM(CASE WHEN order_time >= '${d30.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d30,
            SUM(CASE WHEN order_time >= '${d60.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d60,
            SUM(CASE WHEN order_time >= '${d90.toISOString().slice(0, 10)}' THEN ${qtyExpr} ELSE 0 END) as d90,
            SUM(${qtyExpr}) as d180,
            MAX(order_time) as last_order_at
       FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem
      WHERE ${baseWhere}
      GROUP BY 1, 2`
  );

  const skuStats = new Map<string, SalesStats>();

  const addStats = (key: string, stats: SalesStats) => {
    const existing = skuStats.get(key) ?? emptySalesStats();
    skuStats.set(key, mergeStats(existing, stats));
  };

  for (const row of rows) {
    const stats: SalesStats = {
      d3: Number(row.d3) || 0,
      d7: Number(row.d7) || 0,
      d14: Number(row.d14) || 0,
      d30: Number(row.d30) || 0,
      d60: Number(row.d60) || 0,
      d90: Number(row.d90) || 0,
      d180: Number(row.d180) || 0,
      lastOrderAt: row.last_order_at ? new Date(row.last_order_at) : null,
    };
    const sku = normalizeSku(row.sku);
    if (sku) addStats(sku, stats);
    const pnk = normalizePnk(row.pnk);
    if (pnk) addStats(pnkKey(pnk), stats);
  }

  // 通用诊断：打印 top3 有销量 SKU（全站通用，无硬编码）
  const skusWithSales = [...skuStats.keys()];
  const topSample = skusWithSales.slice(0, 3);
  if (topSample.length > 0) {
    console.log(`[Sales shopId=${shopId}] 30天 Top3 SKU: ${topSample.map(k => `${k}(d30=${skuStats.get(k)?.d30 ?? 0},d60=${skuStats.get(k)?.d60 ?? 0},d90=${skuStats.get(k)?.d90 ?? 0})`).join(', ')}`);
  } else {
    console.log(`[Sales shopId=${shopId}] 30天内无有效订单销量`);
  }

  return { map: skuStats, skusWithSales };
}

/**
 * 为单个 StoreProduct 获取销量（合并 sku 与 vendorSku，忽略大小写）
 */
export function getSalesForProduct(
  salesMap: Map<string, SalesStats>,
  sku: string | null,
  vendorSku: string | null,
  pnk?: string | null,
): SalesStats {
  const keys = new Set(
    [(sku ?? '').trim(), (vendorSku ?? '').trim()]
      .filter(Boolean)
      .map((k) => k.toLowerCase())
  );
  let stats = emptySalesStats();
  for (const k of keys) {
    const s = salesMap.get(k);
    if (s) {
      stats = mergeStats(stats, s);
    }
  }
  if (Number(stats.d180 ?? 0) > 0 || stats.lastOrderAt) return stats;

  const normalizedPnk = normalizePnk(pnk);
  if (normalizedPnk) {
    const pnkStats = salesMap.get(pnkKey(normalizedPnk));
    if (pnkStats) return pnkStats;
  }
  return stats;
}

/**
 * 诊断：当某产品销量为 0 时，打印 SKU 与有销量的订单 SKU 样本对比
 */
export function logZeroSalesDiagnostic(
  productSku: string | null,
  productVendorSku: string | null,
  salesMap: Map<string, SalesStats>,
  sampleSkusWithSales: string[]
): void {
  const stats = getSalesForProduct(salesMap, productSku, productVendorSku);
  if (stats.d30 > 0) return;
  const skuDisplay = productSku ?? productVendorSku ?? 'null';
  const sample = sampleSkusWithSales.slice(0, 5).join(', ');
  console.log(`[Sales Diagnostic] Product SKU="${skuDisplay}" -> 0 sales. Sample order SKUs with sales: [${sample}]`);
}
