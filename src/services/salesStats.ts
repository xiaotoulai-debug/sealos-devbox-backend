/**
 * 平台产品销量统计 Service
 *
 * 使用原始 SQL 直接聚合 platform_orders.products_json
 * 状态：必须包含 status=4(已完成)，即 status IN (1,2,3,4)
 * SKU 清理：TRIM(REPLACE(REPLACE(sku, '\r', ''), '\n', ''))
 */

import { prisma } from '../lib/prisma';

export interface SalesStats {
  d7: number;
  d14: number;
  d30: number;
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
async function aggregateSalesForShop(shopId: number): Promise<{ map: Map<string, SalesStats>; skusWithSales: string[] }> {
  const now = new Date();
  const d7 = new Date(now);
  d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now);
  d14.setDate(d14.getDate() - 14);
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 30);

  const baseWhere = `shop_id = ${shopId} AND (status = 4 OR status IN (1,2,3,4))`;
  const skuExpr = `LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\\\r', ''), E'\\\\n', '')))`;
  const qtyExpr = `COALESCE((elem->>'quantity')::int, 0)`;

  const [d7Rows, d14Rows, d30Rows] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ sku: string; total: string | number }>>(
      `SELECT ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseWhere} AND order_time >= '${d7.toISOString().slice(0, 10)}' GROUP BY 1`
    ),
    prisma.$queryRawUnsafe<Array<{ sku: string; total: string | number }>>(
      `SELECT ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseWhere} AND order_time >= '${d14.toISOString().slice(0, 10)}' GROUP BY 1`
    ),
    prisma.$queryRawUnsafe<Array<{ sku: string; total: string | number }>>(
      `SELECT ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseWhere} AND order_time >= '${d30.toISOString().slice(0, 10)}' GROUP BY 1`
    ),
  ]);

  const skuStats = new Map<string, { d7: number; d14: number; d30: number }>();

  const merge = (rows: Array<{ sku: string; total: string | number }>, key: 'd7' | 'd14' | 'd30') => {
    for (const row of rows) {
      const sku = normalizeSku(row.sku);
      if (!sku) continue;
      const qty = Number(row.total) || 0;
      const s = skuStats.get(sku) ?? { d7: 0, d14: 0, d30: 0 };
      s[key] = qty;
      skuStats.set(sku, s);
    }
  };
  merge(d7Rows, 'd7');
  merge(d14Rows, 'd14');
  merge(d30Rows, 'd30');

  const sampleSkus = ['cpb01', 'tngj01', 'cdx04'];
  for (const sku of sampleSkus) {
    const s = skuStats.get(sku);
    const d30Match = d30Rows.find((r) => normalizeSku(r.sku) === sku);
    const orderMatchTotal = d30Match ? Number(d30Match.total) : 0;
    console.log(`[Sales Diagnostic] SKU: ${sku} | 订单库匹配数量: ${orderMatchTotal} | 最终计算销量: ${s?.d30 ?? 0}`);
  }

  const skusWithSales = [...skuStats.keys()];
  return { map: skuStats, skusWithSales };
}

/**
 * 为单个 StoreProduct 获取销量（合并 sku 与 vendorSku，忽略大小写）
 */
export function getSalesForProduct(
  salesMap: Map<string, SalesStats>,
  sku: string | null,
  vendorSku: string | null
): SalesStats {
  const keys = new Set(
    [(sku ?? '').trim(), (vendorSku ?? '').trim()]
      .filter(Boolean)
      .map((k) => k.toLowerCase())
  );
  let d7 = 0, d14 = 0, d30 = 0;
  for (const k of keys) {
    const s = salesMap.get(k);
    if (s) {
      d7 += s.d7;
      d14 += s.d14;
      d30 += s.d30;
    }
  }
  return { d7, d14, d30 };
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
