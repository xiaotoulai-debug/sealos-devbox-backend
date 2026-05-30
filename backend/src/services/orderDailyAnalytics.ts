import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { loadExchangeRateMap } from './exchangeRateSync';
import {
  calculateOrderProfitBreakdowns,
  PROFIT_FORMULA_VERSION,
  SALES_TAX_MODE,
  type CostReliabilityStatus,
} from './orderProfitCalculator';
import { guessCommissionRate } from '../utils/commissionMatcher';
import { DEFAULT_COMMISSION_RATE } from '../config/commissionMap';

export type AnalyticsSite = 'RO' | 'BG' | 'HU' | 'ALL';
export type OrderStatusMode = 'valid' | 'all' | 'completed_only';
export type CurrencyMode = 'original' | 'grouped_by_currency' | 'converted';
export type ProfitDisplayStatus = 'complete' | 'estimated' | 'partial' | 'unavailable';
type Metric = {
  orderCount: number;
  itemCount: number;
  costStatus: 'complete' | 'partial' | 'missing';
  costMatchedItemCount: number;
  costMissingItemCount: number;
  grossProfitReliable: boolean;
  amountWithVat: number;
  grossSales: number;
  vatAmount: number;
  refundOrderCount: number;
  refundAmount: number;
  netSales: number;
  productCost: number;
  commissionCost: number;
  fulfillmentCost: number;
  firstLegCost: number;
  returnLossCost: number;
  grossProfit: number;
  grossMargin: number;
  avgOrderValue: number;
  hasMissingCost: boolean;
  profitWarnings: string[];
  costReliabilityStatus: CostReliabilityStatus;
  profitDisplayable: boolean;
  profitDisplayStatus: ProfitDisplayStatus;
};

export type OrderDailySummary = Metric & {
  month: string;
  currency: string;
  salesTaxMode: 'ex_vat';
  profitFormulaVersion: 'order_profit_v2_ex_vat_full_cost_phase3b';
};

export type OrderDailyDay = Metric & {
  date: string;
  currency: string;
  salesTaxMode: 'ex_vat';
  profitFormulaVersion: 'order_profit_v2_ex_vat_full_cost_phase3b';
};

export type CurrencyGroup = {
  site: Exclude<AnalyticsSite, 'ALL'> | 'ALL';
  region: string | null;
  currency: string;
  shopId: number | null;
  shopIds: number[];
  shopName: string | null;
  shopNames: string[];
  summary: OrderDailySummary;
  days: OrderDailyDay[];
};

export type OrderDailyAnalyticsParams = {
  shopId?: number;
  shopIds?: number[];
  site?: AnalyticsSite;
  month: string;
  statusMode?: OrderStatusMode;
  currencyMode?: CurrencyMode;
  baseCurrency?: string;
};

export type OrderDailyAnalyticsResult = {
  summary: OrderDailySummary;
  days: OrderDailyDay[];
  currencyGroups: CurrencyGroup[];
  warnings: string[];
  timezoneMode: 'site_local_date';
  dataSource: 'platform_orders';
  generatedAt: string;
};

type PlatformOrderForAnalytics = {
  id: number;
  shopId: number;
  status: number;
  orderTime: Date;
  total: Prisma.Decimal;
  currency: string | null;
  productsJson: string | null;
  rawJson: string | null;
  shop: { region: string | null; shopName?: string | null };
};

type ParsedOrder = {
  order: PlatformOrderForAnalytics;
  localDate: string;
  currency: string;
  products: Array<Record<string, unknown>>;
  raw: Record<string, unknown> | null;
  productParseFailed: boolean;
};

const SITE_TIMEZONE: Record<Exclude<AnalyticsSite, 'ALL'>, string> = {
  RO: 'Europe/Bucharest',
  BG: 'Europe/Sofia',
  HU: 'Europe/Budapest',
};

const SITE_CURRENCY: Record<Exclude<AnalyticsSite, 'ALL'>, string> = {
  RO: 'RON',
  BG: 'EUR',
  HU: 'HUF',
};

const VALID_STATUSES = new Set([1, 2, 3, 4]);
const COMPLETED_STATUS = 4;
const REFUND_OR_RETURN_STATUS = 5;
const BROAD_RANGE_PADDING_DAYS = 2;

function assertMonth(month: string): void {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('month 格式无效，请使用 YYYY-MM');
  }
  const m = Number(month.slice(5, 7));
  if (m < 1 || m > 12) {
    throw new Error('month 月份无效，请使用 YYYY-MM');
  }
}

function normalizeSite(site?: AnalyticsSite): AnalyticsSite {
  return site ?? 'ALL';
}

function getTimeZone(region: string | null | undefined): string {
  const key = String(region ?? 'RO').toUpperCase();
  if (key === 'BG' || key === 'HU' || key === 'RO') return SITE_TIMEZONE[key];
  return SITE_TIMEZONE.RO;
}

function formatLocalDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function getMonthDates(month: string): string[] {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const result: string[] = [];
  const cur = new Date(Date.UTC(year, monthIndex, 1));
  while (cur.getUTCMonth() === monthIndex) {
    result.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return result;
}

function getBroadUtcRange(month: string): { start: Date; end: Date } {
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7)) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  start.setUTCDate(start.getUTCDate() - BROAD_RANGE_PADDING_DAYS);
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  end.setUTCDate(end.getUTCDate() + BROAD_RANGE_PADDING_DAYS);
  return { start, end };
}

function emptyMetric(): Metric {
  return {
    orderCount: 0,
    itemCount: 0,
    costStatus: 'complete',
    costMatchedItemCount: 0,
    costMissingItemCount: 0,
    grossProfitReliable: true,
    amountWithVat: 0,
    grossSales: 0,
    vatAmount: 0,
    refundOrderCount: 0,
    refundAmount: 0,
    netSales: 0,
    productCost: 0,
    commissionCost: 0,
    fulfillmentCost: 0,
    firstLegCost: 0,
    returnLossCost: 0,
    grossProfit: 0,
    grossMargin: 0,
    avgOrderValue: 0,
    hasMissingCost: false,
    profitWarnings: [],
    costReliabilityStatus: 'complete',
    profitDisplayable: false,
    profitDisplayStatus: 'unavailable',
  };
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function finalizeMetric(metric: Metric): Metric {
  const netSales = metric.grossSales - metric.refundAmount;
  const grossProfit = netSales
    - metric.productCost
    - metric.commissionCost
    - metric.fulfillmentCost
    - metric.firstLegCost
    - metric.returnLossCost;
  const costStatus = resolveCostStatus(metric);
  const vatAmount = metric.amountWithVat - metric.grossSales;
  const costReliabilityStatus = resolveCostReliabilityStatus(metric, costStatus);
  const grossMargin = netSales > 0 ? (grossProfit / netSales) * 100 : 0;
  const profitDisplay = buildProfitDisplayStatus({
    netSales,
    productCost: metric.productCost,
    grossProfit,
    grossMargin,
    costStatus,
    costReliabilityStatus,
    grossProfitReliable: costReliabilityStatus === 'complete',
  });
  return {
    ...metric,
    costStatus,
    costReliabilityStatus,
    grossProfitReliable: costReliabilityStatus === 'complete',
    profitDisplayable: profitDisplay.profitDisplayable,
    profitDisplayStatus: profitDisplay.profitDisplayStatus,
    amountWithVat: round2(metric.amountWithVat),
    grossSales: round2(metric.grossSales),
    vatAmount: round2(vatAmount),
    refundAmount: round2(metric.refundAmount),
    netSales: round2(netSales),
    productCost: round2(metric.productCost),
    commissionCost: round2(metric.commissionCost),
    fulfillmentCost: round2(metric.fulfillmentCost),
    firstLegCost: round2(metric.firstLegCost),
    returnLossCost: round2(metric.returnLossCost),
    grossProfit: round2(grossProfit),
    grossMargin: round2(grossMargin),
    avgOrderValue: metric.orderCount > 0 ? round2(metric.grossSales / metric.orderCount) : 0,
  };
}

function buildProfitDisplayStatus(input: {
  netSales: number;
  productCost: number;
  grossProfit: number;
  grossMargin: number;
  costStatus: Metric['costStatus'];
  costReliabilityStatus: CostReliabilityStatus;
  grossProfitReliable: boolean;
}): Pick<Metric, 'profitDisplayable' | 'profitDisplayStatus'> {
  const hasValidProfit =
    Number.isFinite(input.grossProfit) &&
    Number.isFinite(input.grossMargin);

  if (input.netSales <= 0 || !hasValidProfit) {
    return { profitDisplayable: false, profitDisplayStatus: 'unavailable' };
  }

  if (input.productCost <= 0 && input.netSales > 0) {
    return { profitDisplayable: false, profitDisplayStatus: 'unavailable' };
  }

  if (input.costStatus === 'missing') {
    return { profitDisplayable: false, profitDisplayStatus: 'unavailable' };
  }

  if (input.costReliabilityStatus === 'complete' && input.grossProfitReliable) {
    return { profitDisplayable: true, profitDisplayStatus: 'complete' };
  }

  if (input.costReliabilityStatus === 'estimated') {
    return { profitDisplayable: true, profitDisplayStatus: 'estimated' };
  }

  if (input.costReliabilityStatus === 'partial') {
    return { profitDisplayable: true, profitDisplayStatus: 'partial' };
  }

  if (input.productCost > 0 && input.netSales > 0 && hasValidProfit) {
    return { profitDisplayable: true, profitDisplayStatus: 'estimated' };
  }

  return { profitDisplayable: false, profitDisplayStatus: 'unavailable' };
}

function resolveCostStatus(metric: Metric): Metric['costStatus'] {
  if (metric.orderCount <= 0 || metric.itemCount <= 0) return 'complete';
  if (metric.costMissingItemCount <= 0) return 'complete';
  if (metric.costMatchedItemCount > 0) return 'partial';
  return 'missing';
}

function resolveCostReliabilityStatus(metric: Metric, costStatus: Metric['costStatus']): CostReliabilityStatus {
  if (metric.orderCount <= 0 || metric.itemCount <= 0) return 'complete';
  if (costStatus === 'missing') return 'missing';
  if (costStatus === 'partial') return 'partial';
  const reliabilityWarnings = metric.profitWarnings.filter((warning) => !warning.includes('returnLossRate'));
  return reliabilityWarnings.length > 0 ? 'estimated' : 'complete';
}

function makeSummary(month: string, currency: string, metric: Metric): OrderDailySummary {
  return { month, currency, salesTaxMode: SALES_TAX_MODE, profitFormulaVersion: PROFIT_FORMULA_VERSION, ...finalizeMetric(metric) };
}

function makeDay(date: string, currency: string, metric: Metric): OrderDailyDay {
  return { date, currency, salesTaxMode: SALES_TAX_MODE, profitFormulaVersion: PROFIT_FORMULA_VERSION, ...finalizeMetric(metric) };
}

function parseJsonObject(raw: string | null, onFail: () => void): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    onFail();
    return null;
  }
}

function parseJsonArray(raw: string | null, onFail: () => void): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => item && typeof item === 'object' && !Array.isArray(item))
      : [];
  } catch {
    onFail();
    return [];
  }
}

function numberFrom(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function rawKey(value: unknown): string {
  return String(value ?? '').trim();
}

function rawItemSku(item: Record<string, unknown>): string {
  return rawKey(item.sku ?? item.ext_part_number ?? item.part_number);
}

function rawItemPnk(item: Record<string, unknown>): string {
  return rawKey(item.pnk ?? item.part_number_key);
}

function itemQuantity(item: Record<string, unknown>): number {
  const qty = numberFrom(item.quantity);
  return qty > 0 ? qty : 0;
}

function itemSku(item: Record<string, unknown>): string {
  return normalizeKey(rawItemSku(item));
}

function itemPnk(item: Record<string, unknown>): string {
  return normalizeKey(rawItemPnk(item));
}

function rawRefundAmount(raw: Record<string, unknown> | null): number {
  return numberFrom(raw?.refunded_amount ?? raw?.refund_amount);
}

function itemSalePrice(item: Record<string, unknown>): number {
  return numberFrom(item.sale_price ?? item.price);
}

function itemVatRate(item: Record<string, unknown>): number {
  const raw = numberFrom(item.vat_rate ?? item.vat);
  return raw > 1 ? raw / 100 : raw;
}

function itemSalesExVat(item: Record<string, unknown>): number {
  return itemSalePrice(item) * itemQuantity(item);
}

function itemAmountWithVat(item: Record<string, unknown>): number {
  return itemSalePrice(item) * (1 + itemVatRate(item)) * itemQuantity(item);
}

function refundAmountExVat(raw: Record<string, unknown> | null): { amount: number; source: 'items' | 'raw' | 'none' } {
  const products = raw?.products;
  if (Array.isArray(products)) {
    const amount = products.reduce((sum, item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return sum;
      const product = item as Record<string, unknown>;
      const stornoQty = numberFrom(product.storno_qty);
      const qty = stornoQty > 0 ? stornoQty : 0;
      return sum + itemSalePrice(product) * qty;
    }, 0);
    if (amount > 0) return { amount, source: 'items' };
  }

  const rawAmount = rawRefundAmount(raw);
  return rawAmount > 0 ? { amount: rawAmount, source: 'raw' } : { amount: 0, source: 'none' };
}

function numericDecimal(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveCommissionRate(
  storeProduct: { commissionRate: number | null; name: string } | undefined,
  product: { category: string | null } | undefined,
): { rate: number; source: 'exact' | 'dictionary' | 'default' } {
  if (storeProduct?.commissionRate != null) {
    return { rate: storeProduct.commissionRate, source: 'exact' };
  }
  const guessed = guessCommissionRate(storeProduct?.name ?? '', product?.category ?? null);
  if (guessed != null) return { rate: guessed, source: 'dictionary' };
  return { rate: DEFAULT_COMMISSION_RATE, source: 'default' };
}

function localProductDimensions(product: {
  length: Prisma.Decimal | null;
  width: Prisma.Decimal | null;
  height: Prisma.Decimal | null;
  actualWeight: Prisma.Decimal | null;
}) {
  return {
    length: numericDecimal(product.length),
    width: numericDecimal(product.width),
    height: numericDecimal(product.height),
    actualWeight: numericDecimal(product.actualWeight),
  };
}

function orderIncludedByStatus(status: number, statusMode: OrderStatusMode): boolean {
  if (statusMode === 'all') return true;
  if (statusMode === 'completed_only') return status === COMPLETED_STATUS;
  return VALID_STATUSES.has(status);
}

function addMetric(target: Metric, source: Metric): void {
  target.orderCount += source.orderCount;
  target.itemCount += source.itemCount;
  target.amountWithVat += source.amountWithVat;
  target.grossSales += source.grossSales;
  target.vatAmount += source.vatAmount;
  target.refundOrderCount += source.refundOrderCount;
  target.refundAmount += source.refundAmount;
  target.costMatchedItemCount += source.costMatchedItemCount;
  target.costMissingItemCount += source.costMissingItemCount;
  target.productCost += source.productCost;
  target.commissionCost += source.commissionCost;
  target.fulfillmentCost += source.fulfillmentCost;
  target.firstLegCost += source.firstLegCost;
  target.returnLossCost += source.returnLossCost;
  target.hasMissingCost = target.hasMissingCost || source.hasMissingCost;
  for (const warning of source.profitWarnings) {
    if (!target.profitWarnings.includes(warning)) target.profitWarnings.push(warning);
  }
}

function addWarning(warnings: Set<string>, message: string): void {
  warnings.add(message);
}

function addProfitWarning(metric: Metric, message: string): void {
  if (!metric.profitWarnings.includes(message)) metric.profitWarnings.push(message);
}

function resolveDefaultCurrency(site: AnalyticsSite, parsedOrders: ParsedOrder[]): string {
  if (site !== 'ALL') return SITE_CURRENCY[site];
  const currencies = [...new Set(parsedOrders.map((o) => o.currency))];
  return currencies.length === 1 ? currencies[0] : 'MULTI';
}

function normalizeRegion(region: string | null | undefined): Exclude<AnalyticsSite, 'ALL'> | null {
  const key = String(region ?? '').toUpperCase();
  return key === 'RO' || key === 'BG' || key === 'HU' ? key : null;
}

function singleOrNull<T>(values: T[]): T | null {
  return values.length === 1 ? values[0] : null;
}

async function buildCostLookup(parsedOrders: ParsedOrder[]) {
  const shopIds = [...new Set(parsedOrders.map((o) => o.order.shopId))];
  const storeProducts = shopIds.length > 0
    ? await prisma.storeProduct.findMany({
        where: { shopId: { in: shopIds }, isArchived: false },
        select: {
          shopId: true,
          sku: true,
          vendorSku: true,
          pnk: true,
          name: true,
          commissionRate: true,
          mappedInventorySku: true,
        },
      })
    : [];

  const storeBySku = new Map<string, (typeof storeProducts)[number]>();
  const storeByVendorSku = new Map<string, (typeof storeProducts)[number]>();
  const productSkus = new Set<string>();

  for (const sp of storeProducts) {
    const sku = normalizeKey(sp.sku);
    const vendorSku = normalizeKey(sp.vendorSku);
    if (sku) storeBySku.set(`${sp.shopId}|${sku}`, sp);
    if (vendorSku) storeByVendorSku.set(`${sp.shopId}|${vendorSku}`, sp);

    for (const candidate of [sp.mappedInventorySku, sp.vendorSku, sp.sku]) {
      const raw = rawKey(candidate);
      if (raw) productSkus.add(raw);
    }
  }

  for (const parsed of parsedOrders) {
    for (const item of parsed.products) {
      const sku = rawItemSku(item);
      const pnk = rawItemPnk(item);
      if (sku) productSkus.add(sku);
      if (pnk) productSkus.add(pnk);
    }
  }

  const productsBySku = productSkus.size > 0
    ? await prisma.product.findMany({
        where: { sku: { in: [...productSkus] }, isDeleted: false },
        select: {
          sku: true,
          pnk: true,
          purchasePrice: true,
          fbeFee: true,
          length: true,
          width: true,
          height: true,
          actualWeight: true,
          category: true,
          returnLossRate: true,
        },
      })
    : [];

  const productBySku = new Map(productsBySku.map((p) => [normalizeKey(p.sku), p]));

  return { storeBySku, storeByVendorSku, productBySku };
}

export async function getOrderDailyAnalytics(params: OrderDailyAnalyticsParams): Promise<OrderDailyAnalyticsResult> {
  assertMonth(params.month);
  const statusMode = params.statusMode ?? 'valid';
  const currencyMode = params.currencyMode ?? 'original';
  const site = normalizeSite(params.site);
  const warnings = new Set<string>();
  const monthDates = getMonthDates(params.month);
  const { start, end } = getBroadUtcRange(params.month);

  if (commissionWarningNeeded()) {
    addWarning(warnings, 'commissionCost 已按订单不含 VAT 成交额逐商品计算；佣金率缺失时使用平台产品字典/默认值估算');
  }
  addWarning(warnings, 'fulfillmentCost 代表 FBE 运费，沿用平台产品公式口径：products.fbe_fee 按订单站点币种处理');
  addWarning(warnings, 'Phase 3B：grossSales/netSales 为不含 VAT 商品成交额；毛利已计入采购、佣金、头程、FBE 与退货损耗估算，不代表最终净利润');

  const shopWhere: Prisma.ShopAuthorizationWhereInput = {
    platform: { equals: 'emag', mode: 'insensitive' },
    status: 'active',
  };
  if (params.shopIds && params.shopIds.length > 0) shopWhere.id = { in: params.shopIds };
  else if (params.shopId != null) shopWhere.id = params.shopId;
  if (site !== 'ALL') shopWhere.region = site;

  const shops = await prisma.shopAuthorization.findMany({
    where: shopWhere,
    select: { id: true, region: true, shopName: true },
  });
  const shopIds = shops.map((s) => s.id);

  if (shopIds.length === 0) {
    const currency = site !== 'ALL' ? SITE_CURRENCY[site] : 'MULTI';
    return {
      summary: makeSummary(params.month, currency, emptyMetric()),
      days: monthDates.map((date) => makeDay(date, currency, emptyMetric())),
      currencyGroups: [],
      warnings: [...warnings],
      timezoneMode: 'site_local_date',
      dataSource: 'platform_orders',
      generatedAt: new Date().toISOString(),
    };
  }

  const orders = await prisma.platformOrder.findMany({
    where: {
      shopId: { in: shopIds },
      orderTime: { gte: start, lt: end },
    },
    orderBy: { orderTime: 'asc' },
    include: { shop: { select: { region: true, shopName: true } } },
  });

  let productParseFailures = 0;
  let rawParseFailures = 0;
  const parsedOrders: ParsedOrder[] = [];

  for (const order of orders) {
    const localDate = formatLocalDate(order.orderTime, getTimeZone(order.shop.region));
    if (!localDate.startsWith(params.month)) continue;
    let productParseFailed = false;
    const products = parseJsonArray(order.productsJson, () => {
      productParseFailed = true;
      productParseFailures++;
    });
    const raw = parseJsonObject(order.rawJson, () => {
      rawParseFailures++;
    });
    parsedOrders.push({
      order,
      localDate,
      currency: order.currency ?? SITE_CURRENCY[(order.shop.region as Exclude<AnalyticsSite, 'ALL'> | null) ?? 'RO'] ?? 'RON',
      products,
      raw,
      productParseFailed,
    });
  }

  if (productParseFailures > 0) {
    addWarning(warnings, '部分订单 products_json 解析失败，相关商品成本未计入');
  }
  if (rawParseFailures > 0) {
    addWarning(warnings, '部分订单 raw_json 解析失败，退款金额可能未完整计入');
  }

  const rateMap = await loadExchangeRateMap();
  const profitResults = await calculateOrderProfitBreakdowns({
    orders: parsedOrders.map((parsed) => parsed.order),
    rateMap,
  });
  let missingCostCount = 0;
  const missingReasons = {
    missing_product_count: 0,
    missing_purchase_price_count: 0,
    missing_exchange_rate_count: 0,
    missing_store_product_count: 0,
  };

  const grouped = new Map<string, {
    summary: Metric;
    days: Map<string, Metric>;
    shopIds: Set<number>;
    shopNames: Set<string>;
    regions: Set<Exclude<AnalyticsSite, 'ALL'>>;
  }>();
  const ensureCurrencyGroup = (currency: string) => {
    const existing = grouped.get(currency);
    if (existing) return existing;
    const created = {
      summary: emptyMetric(),
      days: new Map<string, Metric>(),
      shopIds: new Set<number>(),
      shopNames: new Set<string>(),
      regions: new Set<Exclude<AnalyticsSite, 'ALL'>>(),
    };
    for (const date of monthDates) created.days.set(date, emptyMetric());
    grouped.set(currency, created);
    return created;
  };

  for (const parsed of parsedOrders) {
    const included = orderIncludedByStatus(Number(parsed.order.status), statusMode);
    const currency = parsed.currency;
    const group = ensureCurrencyGroup(currency);
    group.shopIds.add(parsed.order.shopId);
    if (parsed.order.shop.shopName) group.shopNames.add(parsed.order.shop.shopName);
    const region = normalizeRegion(parsed.order.shop.region);
    if (region) group.regions.add(region);
    const dayMetric = group.days.get(parsed.localDate) ?? emptyMetric();
    group.days.set(parsed.localDate, dayMetric);

    const refund = refundAmountExVat(parsed.raw);
    const refundAmount = refund.amount;
    const isRefundLike = Number(parsed.order.status) === REFUND_OR_RETURN_STATUS || rawRefundAmount(parsed.raw) > 0 || refundAmount > 0;
    if (isRefundLike) {
      group.summary.refundOrderCount++;
      dayMetric.refundOrderCount++;
      group.summary.refundAmount += refundAmount;
      dayMetric.refundAmount += refundAmount;
      if (refund.source === 'items') {
        addWarning(warnings, '退款金额已按 raw_json.products[].sale_price × storno_qty 折算为不含 VAT 口径');
      } else if (refund.source === 'raw') {
        addWarning(warnings, '退款金额税口径待确认：raw_json.refunded_amount 可能为含 VAT 金额');
      }
    }

    if (!included) continue;

    const profit = profitResults.get(parsed.order.id);
    const profitSummary = profit?.profitSummary;
    if (!profitSummary) continue;
    group.summary.orderCount++;
    dayMetric.orderCount++;
    group.summary.amountWithVat += profitSummary.amountWithVat;
    dayMetric.amountWithVat += profitSummary.amountWithVat;
    group.summary.grossSales += profitSummary.grossSales;
    dayMetric.grossSales += profitSummary.grossSales;
    group.summary.vatAmount += profitSummary.vatAmount;
    dayMetric.vatAmount += profitSummary.vatAmount;
    group.summary.itemCount += profitSummary.costMatchedItemCount + profitSummary.costMissingItemCount;
    dayMetric.itemCount += profitSummary.costMatchedItemCount + profitSummary.costMissingItemCount;
    group.summary.costMatchedItemCount += profitSummary.costMatchedItemCount;
    dayMetric.costMatchedItemCount += profitSummary.costMatchedItemCount;
    group.summary.costMissingItemCount += profitSummary.costMissingItemCount;
    dayMetric.costMissingItemCount += profitSummary.costMissingItemCount;
    group.summary.productCost += profitSummary.productCost;
    dayMetric.productCost += profitSummary.productCost;
    group.summary.commissionCost += profitSummary.commissionCost;
    dayMetric.commissionCost += profitSummary.commissionCost;
    group.summary.firstLegCost += profitSummary.firstLegCost;
    dayMetric.firstLegCost += profitSummary.firstLegCost;
    group.summary.fulfillmentCost += profitSummary.fulfillmentCost;
    dayMetric.fulfillmentCost += profitSummary.fulfillmentCost;
    group.summary.returnLossCost += profitSummary.returnLossCost;
    dayMetric.returnLossCost += profitSummary.returnLossCost;
    for (const warning of profitSummary.profitWarnings) {
      addProfitWarning(group.summary, warning);
      addProfitWarning(dayMetric, warning);
    }
    missingCostCount += profitSummary.costMissingItemCount;
    if (parsed.productParseFailed || profitSummary.hasMissingCost) {
      group.summary.hasMissingCost = true;
      dayMetric.hasMissingCost = true;
    }
  }

  if (missingCostCount > 0) {
    addWarning(warnings, '部分订单商品未匹配到本地 SKU 成本，毛利为估算值');
    addWarning(warnings, '当前商品成本缺失较多，毛利率不应作为真实经营利润参考');
  }
  if (missingReasons.missing_exchange_rate_count > 0) {
    addWarning(warnings, '部分订单商品缺少 CNY 到订单币种的汇率，成本未计入');
  }
  if (missingCostCount > 0) {
    console.warn(
      `[OrderDailyAnalytics] cost missing summary month=${params.month} shopId=${params.shopId ?? 'ALL'} site=${site}: ` +
      JSON.stringify(missingReasons),
    );
  }

  const currencyGroups = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, data]) => {
      const groupShopIds = [...data.shopIds].sort((a, b) => a - b);
      const groupRegions = [...data.regions].sort();
      const groupShopNames = [...data.shopNames].sort();
      const region = singleOrNull(groupRegions);
      const groupSite: Exclude<AnalyticsSite, 'ALL'> | 'ALL' = region ?? 'ALL';
      return {
        site: groupSite,
        region,
        currency,
        shopId: singleOrNull(groupShopIds),
        shopIds: groupShopIds,
        shopName: singleOrNull(groupShopNames),
        shopNames: groupShopNames,
        summary: makeSummary(params.month, currency, data.summary),
        days: monthDates.map((date) => makeDay(date, currency, data.days.get(date) ?? emptyMetric())),
      };
    });

  return buildResponseByCurrencyMode({
    params,
    site,
    monthDates,
    parsedOrders,
    currencyGroups,
    warnings,
    rateMap,
  });
}

function commissionWarningNeeded(): boolean {
  return true;
}

function buildResponseByCurrencyMode(input: {
  params: OrderDailyAnalyticsParams;
  site: AnalyticsSite;
  monthDates: string[];
  parsedOrders: ParsedOrder[];
  currencyGroups: CurrencyGroup[];
  warnings: Set<string>;
  rateMap: Map<string, number>;
}): OrderDailyAnalyticsResult {
  const { params, site, monthDates, parsedOrders, currencyGroups, warnings, rateMap } = input;
  const currencyMode = params.currencyMode ?? 'original';
  const currencies = currencyGroups.map((g) => g.currency);
  const defaultCurrency = resolveDefaultCurrency(site, parsedOrders);

  if (currencyMode === 'converted' && params.baseCurrency) {
    const converted = convertGroups(params.month, params.baseCurrency, monthDates, currencyGroups, rateMap, warnings);
    return {
      summary: converted.summary,
      days: converted.days,
      currencyGroups,
      warnings: [...warnings],
      timezoneMode: 'site_local_date',
      dataSource: 'platform_orders',
      generatedAt: new Date().toISOString(),
    };
  }

  if (currencyMode === 'converted' && !params.baseCurrency) {
    addWarning(warnings, 'currencyMode=converted 需要 baseCurrency，当前未做统一折算');
  }

  if (currencies.length === 1) {
    const only = currencyGroups[0];
    return {
      summary: only?.summary ?? makeSummary(params.month, defaultCurrency, emptyMetric()),
      days: only?.days ?? monthDates.map((date) => makeDay(date, defaultCurrency, emptyMetric())),
      currencyGroups,
      warnings: [...warnings],
      timezoneMode: 'site_local_date',
      dataSource: 'platform_orders',
      generatedAt: new Date().toISOString(),
    };
  }

  if (currencies.length > 1) {
    addWarning(warnings, '全部站点包含多币种，summary 不做混合币种合计，请查看 currencyGroups');
  }

  const countOnly = combineCountsOnly(params.month, monthDates, currencyGroups);
  return {
    summary: countOnly.summary,
    days: countOnly.days,
    currencyGroups,
    warnings: [...warnings],
    timezoneMode: 'site_local_date',
    dataSource: 'platform_orders',
    generatedAt: new Date().toISOString(),
  };
}

function combineCountsOnly(month: string, monthDates: string[], currencyGroups: CurrencyGroup[]) {
  const summary = emptyMetric();
  const days = new Map(monthDates.map((date) => [date, emptyMetric()]));
  for (const group of currencyGroups) {
    summary.orderCount += group.summary.orderCount;
    summary.itemCount += group.summary.itemCount;
    summary.refundOrderCount += group.summary.refundOrderCount;
    summary.costMatchedItemCount += group.summary.costMatchedItemCount;
    summary.costMissingItemCount += group.summary.costMissingItemCount;
    summary.hasMissingCost = summary.hasMissingCost || group.summary.hasMissingCost;
    for (const warning of group.summary.profitWarnings) {
      addProfitWarning(summary, warning);
    }
    for (const day of group.days) {
      const target = days.get(day.date);
      if (!target) continue;
      target.orderCount += day.orderCount;
      target.itemCount += day.itemCount;
      target.refundOrderCount += day.refundOrderCount;
      target.costMatchedItemCount += day.costMatchedItemCount;
      target.costMissingItemCount += day.costMissingItemCount;
      target.hasMissingCost = target.hasMissingCost || day.hasMissingCost;
      for (const warning of day.profitWarnings) {
        addProfitWarning(target, warning);
      }
    }
  }
  return {
    summary: makeSummary(month, 'MULTI', summary),
    days: monthDates.map((date) => makeDay(date, 'MULTI', days.get(date) ?? emptyMetric())),
  };
}

function convertGroups(
  month: string,
  baseCurrency: string,
  monthDates: string[],
  currencyGroups: CurrencyGroup[],
  rateMap: Map<string, number>,
  warnings: Set<string>,
) {
  const summary = emptyMetric();
  const days = new Map(monthDates.map((date) => [date, emptyMetric()]));

  const convert = (amount: number, source: string): number | null => {
    if (source === baseCurrency) return amount;
    const rate = rateMap.get(`${source}→${baseCurrency}`);
    if (!rate) return null;
    return amount * rate;
  };

  for (const group of currencyGroups) {
    const convertedSummary = convertMetric(group.summary, group.currency, convert);
    if (!convertedSummary) {
      addWarning(warnings, `缺少 ${group.currency}→${baseCurrency} 汇率，当前未做统一折算`);
      return combineCountsOnly(month, monthDates, currencyGroups);
    }
    addMetric(summary, convertedSummary);

    for (const day of group.days) {
      const convertedDay = convertMetric(day, group.currency, convert);
      if (!convertedDay) {
        addWarning(warnings, `缺少 ${group.currency}→${baseCurrency} 汇率，当前未做统一折算`);
        return combineCountsOnly(month, monthDates, currencyGroups);
      }
      const target = days.get(day.date);
      if (target) addMetric(target, convertedDay);
    }
  }

  return {
    summary: makeSummary(month, baseCurrency, summary),
    days: monthDates.map((date) => makeDay(date, baseCurrency, days.get(date) ?? emptyMetric())),
  };
}

function convertMetric(
  metric: Metric,
  sourceCurrency: string,
  convert: (amount: number, source: string) => number | null,
): Metric | null {
  const fields: Array<keyof Pick<Metric, 'amountWithVat' | 'grossSales' | 'refundAmount' | 'productCost' | 'commissionCost' | 'fulfillmentCost' | 'firstLegCost' | 'returnLossCost'>> = [
    'amountWithVat',
    'grossSales',
    'refundAmount',
    'productCost',
    'commissionCost',
    'fulfillmentCost',
    'firstLegCost',
    'returnLossCost',
  ];
  const converted = emptyMetric();
  converted.orderCount = metric.orderCount;
  converted.itemCount = metric.itemCount;
  converted.refundOrderCount = metric.refundOrderCount;
  converted.costMatchedItemCount = metric.costMatchedItemCount;
  converted.costMissingItemCount = metric.costMissingItemCount;
  converted.hasMissingCost = metric.hasMissingCost;
  for (const field of fields) {
    const amount = convert(metric[field], sourceCurrency);
    if (amount == null) return null;
    converted[field] = amount;
  }
  return converted;
}
