import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { loadExchangeRateMap } from './exchangeRateSync';
import { calcHeadFreightCny } from './freightCalculator';
import { guessCommissionRate } from '../utils/commissionMatcher';
import { DEFAULT_COMMISSION_RATE } from '../config/commissionMap';

export const SALES_TAX_MODE = 'ex_vat' as const;
export const PROFIT_FORMULA_VERSION = 'order_profit_v2_ex_vat_full_cost_phase3b' as const;

export type CostStatus = 'complete' | 'partial' | 'missing';
export type CostReliabilityStatus = 'complete' | 'estimated' | 'partial' | 'missing';
export type FbeFeeSource = 'store_product_profit_breakdown' | 'product_fbe_fee' | 'missing';

export type OrderProfitOrder = {
  id: number;
  shopId: number;
  total: Prisma.Decimal | number;
  currency: string | null;
  productsJson: string | null;
  rawJson: string | null;
};

export type ProfitSummary = {
  salesTaxMode: typeof SALES_TAX_MODE;
  profitFormulaVersion: typeof PROFIT_FORMULA_VERSION;
  amountWithVat: number;
  grossSales: number;
  vatAmount: number;
  refundAmount: number;
  netSales: number;
  commissionCost: number;
  productCost: number;
  firstLegCost: number;
  fulfillmentCost: number;
  returnLossCost: number;
  grossProfit: number;
  grossMargin: number;
  currency: string;
  costStatus: CostStatus;
  costMatchedItemCount: number;
  costMissingItemCount: number;
  costReliabilityStatus: CostReliabilityStatus;
  grossProfitReliable: boolean;
  hasMissingCost: boolean;
  profitWarnings: string[];
};

export type ItemProfitBreakdown = {
  sku: string | null;
  pnk: string | null;
  productName: string | null;
  quantity: number;
  currency: string;
  unitSalePriceExVat: number;
  itemSalesExVat: number;
  amountWithVat: number;
  vatAmount: number;
  commissionRate: number | null;
  commissionCost: number;
  purchasePriceCny: number | null;
  productCost: number;
  firstLegCost: number;
  fulfillmentCost: number;
  fbeFeeSource: FbeFeeSource;
  returnLossCost: number;
  grossProfit: number;
  grossMargin: number;
  matchedStoreProductId: number | null;
  matchedProductId: number | null;
  matchedProductSku: string | null;
  mappedInventorySku: string | null;
  costStatus: CostStatus;
  costReliabilityStatus: CostReliabilityStatus;
  grossProfitReliable: boolean;
  profitWarnings: string[];
};

export type OrderProfitResult = {
  orderId: number;
  profitSummary: ProfitSummary;
  itemBreakdowns: ItemProfitBreakdown[];
};

type ParsedOrder = {
  order: OrderProfitOrder;
  currency: string;
  products: Array<Record<string, unknown>>;
  raw: Record<string, unknown> | null;
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseJsonArray(raw: string | null): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => item && typeof item === 'object' && !Array.isArray(item))
      : [];
  } catch {
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

function rawRefundAmount(raw: Record<string, unknown> | null): number {
  return numberFrom(raw?.refunded_amount ?? raw?.refund_amount);
}

function refundAmountExVat(raw: Record<string, unknown> | null): { amount: number; source: 'items' | 'raw' | 'none' } {
  const products = raw?.products;
  if (Array.isArray(products)) {
    const amount = products.reduce((sum, item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return sum;
      const product = item as Record<string, unknown>;
      const stornoQty = numberFrom(product.storno_qty);
      return sum + itemSalePrice(product) * Math.max(0, stornoQty);
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

function addWarning(target: string[], message: string): void {
  if (!target.includes(message)) target.push(message);
}

function mergeWarnings(target: string[], source: string[]): void {
  for (const warning of source) addWarning(target, warning);
}

function resolveReliabilityStatus(statuses: CostReliabilityStatus[]): CostReliabilityStatus {
  if (statuses.includes('missing')) return 'missing';
  if (statuses.includes('partial')) return 'partial';
  if (statuses.includes('estimated')) return 'estimated';
  return 'complete';
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameCurrency(left: unknown, right: string): boolean {
  const l = rawKey(left).toUpperCase();
  const r = rawKey(right).toUpperCase();
  return !l || l === r;
}

function resolveStoreProductFbe(
  sp: { currency: string | null; profitBreakdown: Prisma.JsonValue | null } | undefined,
  currency: string,
  warnings: string[],
): { fee: number; isEstimated: boolean } | null {
  const breakdown = jsonObject(sp?.profitBreakdown);
  if (!sp || !breakdown) return null;

  const fbe = numericDecimal(breakdown.fbe);
  if (fbe == null || fbe <= 0) return null;

  if (!sameCurrency(sp.currency, currency) || !sameCurrency(breakdown.currency, currency)) {
    addWarning(warnings, '平台产品 profitBreakdown.fbe 币种与订单币种不一致，未直接使用');
    return null;
  }

  return {
    fee: fbe,
    isEstimated: Boolean(breakdown.isEstimatedFbe),
  };
}

async function buildLookup(parsedOrders: ParsedOrder[]) {
  const shopIds = [...new Set(parsedOrders.map((o) => o.order.shopId))];
  const storeProducts = shopIds.length > 0
    ? await prisma.storeProduct.findMany({
        where: { shopId: { in: shopIds }, isArchived: false },
        select: {
          id: true,
          shopId: true,
          sku: true,
          vendorSku: true,
          pnk: true,
          name: true,
          commissionRate: true,
          mappedInventorySku: true,
          currency: true,
          profitBreakdown: true,
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

  const products = productSkus.size > 0
    ? await prisma.product.findMany({
        where: { sku: { in: [...productSkus] }, isDeleted: false },
        select: {
          id: true,
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

  return {
    storeBySku,
    storeByVendorSku,
    productBySku: new Map(products.map((p) => [normalizeKey(p.sku), p])),
  };
}

export async function calculateOrderProfitBreakdowns(params: {
  orders: OrderProfitOrder[];
  rateMap?: Map<string, number>;
}): Promise<Map<number, OrderProfitResult>> {
  const parsedOrders: ParsedOrder[] = params.orders.map((order) => ({
    order,
    currency: order.currency ?? 'RON',
    products: parseJsonArray(order.productsJson),
    raw: parseJsonObject(order.rawJson),
  }));
  const lookup = await buildLookup(parsedOrders);
  const rateMap = params.rateMap ?? await loadExchangeRateMap();
  const results = new Map<number, OrderProfitResult>();

  for (const parsed of parsedOrders) {
    const currency = parsed.currency;
    const summaryWarnings: string[] = [];
    const itemBreakdowns: ItemProfitBreakdown[] = [];
    const refund = refundAmountExVat(parsed.raw);
    if (refund.source === 'raw') {
      addWarning(summaryWarnings, '退款金额税口径待确认：raw_json.refunded_amount 可能为含 VAT 金额');
    }

    let grossSales = 0;
    let productCost = 0;
    let commissionCost = 0;
    let firstLegCost = 0;
    let fulfillmentCost = 0;
    let returnLossCost = 0;
    let costMatchedItemCount = 0;
    let costMissingItemCount = 0;

    for (const item of parsed.products) {
      const qty = itemQuantity(item);
      const rawSku = rawItemSku(item);
      const rawPnk = rawItemPnk(item);
      const skuKey = normalizeKey(rawSku);
      const pnkKey = normalizeKey(rawPnk);
      const itemWarnings: string[] = [];
      const itemSales = itemSalesExVat(item);
      const amountWithVat = itemAmountWithVat(item);
      const vatAmount = amountWithVat - itemSales;
      grossSales += itemSales;

      const sp = (skuKey ? lookup.storeBySku.get(`${parsed.order.shopId}|${skuKey}`) : undefined)
        ?? (skuKey ? lookup.storeByVendorSku.get(`${parsed.order.shopId}|${skuKey}`) : undefined)
        ?? (pnkKey ? lookup.storeBySku.get(`${parsed.order.shopId}|${pnkKey}`) : undefined)
        ?? (pnkKey ? lookup.storeByVendorSku.get(`${parsed.order.shopId}|${pnkKey}`) : undefined);
      const productCandidates = [sp?.mappedInventorySku, sp?.vendorSku, sp?.sku, rawSku, rawPnk].map(normalizeKey).filter(Boolean);
      let product: ReturnType<typeof lookup.productBySku.get> | undefined;
      for (const candidate of productCandidates) {
        product = lookup.productBySku.get(candidate);
        if (product) break;
      }

      let commissionRate: number | null = null;
      let commissionSource: 'exact' | 'dictionary' | 'default' | null = null;
      if (sp?.commissionRate != null) {
        commissionRate = sp.commissionRate;
        commissionSource = 'exact';
      } else {
        const guessed = guessCommissionRate(sp?.name ?? '', product?.category ?? null);
        if (guessed != null) {
          commissionRate = guessed;
          commissionSource = 'dictionary';
          addWarning(itemWarnings, '缺少精确 commissionRate，已按平台产品佣金字典估算');
        } else {
          commissionRate = DEFAULT_COMMISSION_RATE;
          commissionSource = 'default';
          addWarning(itemWarnings, '缺少 commissionRate，已按默认 18% 估算');
        }
      }

      const itemCommissionCost = itemSales * commissionRate;
      let itemProductCost = 0;
      let itemFirstLegCost = 0;
      let itemFulfillmentCost = 0;
      let fbeFeeSource: FbeFeeSource = 'missing';
      let itemReturnLossCost = 0;
      const purchasePriceCny = product?.purchasePrice != null ? Number(product.purchasePrice) : null;
      const cnyToCurrency = rateMap.get(`CNY→${currency}`);
      let costStatus: CostStatus = 'complete';
      let reliabilityStatus: CostReliabilityStatus = commissionSource === 'exact' ? 'complete' : 'estimated';

      if (!product || purchasePriceCny == null || purchasePriceCny <= 0 || !cnyToCurrency) {
        costMissingItemCount += qty;
        costStatus = product ? 'partial' : 'missing';
        reliabilityStatus = costStatus;
        if (!product) addWarning(itemWarnings, '未匹配到本地 Product，采购成本未计入');
        else if (purchasePriceCny == null || purchasePriceCny <= 0) addWarning(itemWarnings, 'Product.purchasePrice 缺失或为 0，采购成本未计入');
        else addWarning(itemWarnings, `缺少 CNY→${currency} 汇率，采购成本未计入`);
      } else {
        costMatchedItemCount += qty;
        itemProductCost = purchasePriceCny * cnyToCurrency * qty;

        const length = numericDecimal(product.length);
        const width = numericDecimal(product.width);
        const height = numericDecimal(product.height);
        const actualWeight = numericDecimal(product.actualWeight);
        const headFreightCny = calcHeadFreightCny(length, width, height, actualWeight);
        if (headFreightCny != null) {
          itemFirstLegCost = headFreightCny * cnyToCurrency * qty;
        } else {
          reliabilityStatus = resolveReliabilityStatus([reliabilityStatus, 'estimated']);
          addWarning(itemWarnings, '缺少尺寸或重量，头程成本已按 0 估算');
        }

        const storeProductFbe = resolveStoreProductFbe(sp, currency, itemWarnings);
        const fbeFeeCny = product.fbeFee != null ? Number(product.fbeFee) : null;
        if (storeProductFbe) {
          itemFulfillmentCost = storeProductFbe.fee * qty;
          fbeFeeSource = 'store_product_profit_breakdown';
          if (storeProductFbe.isEstimated) {
            reliabilityStatus = resolveReliabilityStatus([reliabilityStatus, 'estimated']);
          }
        } else if (fbeFeeCny != null && fbeFeeCny > 0) {
          itemFulfillmentCost = fbeFeeCny * cnyToCurrency * qty;
          fbeFeeSource = 'product_fbe_fee';
        } else {
          reliabilityStatus = resolveReliabilityStatus([reliabilityStatus, 'estimated']);
          addWarning(itemWarnings, '缺少 FBE 运费，fulfillmentCost 已按 0 估算');
        }
        addWarning(itemWarnings, 'Product.fbeFee 按 CNY 存储，已换算为订单站点本地币种');

        const returnLossRate = product.returnLossRate ?? null;
        if (returnLossRate == null) {
          addWarning(itemWarnings, 'returnLossRate 为空，退货损耗按 0 估算');
        } else if (returnLossRate > 0) {
          itemReturnLossCost = purchasePriceCny * returnLossRate * cnyToCurrency * qty;
        }
      }

      const itemGrossProfit = itemSales - itemCommissionCost - itemProductCost - itemFirstLegCost - itemFulfillmentCost - itemReturnLossCost;
      const grossProfitReliable = reliabilityStatus === 'complete';
      productCost += itemProductCost;
      commissionCost += itemCommissionCost;
      firstLegCost += itemFirstLegCost;
      fulfillmentCost += itemFulfillmentCost;
      returnLossCost += itemReturnLossCost;
      mergeWarnings(summaryWarnings, itemWarnings);

      itemBreakdowns.push({
        sku: rawSku || null,
        pnk: rawPnk || null,
        productName: rawKey(item.product_name ?? item.name) || null,
        quantity: qty,
        currency,
        unitSalePriceExVat: round2(itemSalePrice(item)),
        itemSalesExVat: round2(itemSales),
        amountWithVat: round2(amountWithVat),
        vatAmount: round2(vatAmount),
        commissionRate,
        commissionCost: round2(itemCommissionCost),
        purchasePriceCny,
        productCost: round2(itemProductCost),
        firstLegCost: round2(itemFirstLegCost),
        fulfillmentCost: round2(itemFulfillmentCost),
        fbeFeeSource,
        returnLossCost: round2(itemReturnLossCost),
        grossProfit: round2(itemGrossProfit),
        grossMargin: itemSales > 0 ? round2((itemGrossProfit / itemSales) * 100) : 0,
        matchedStoreProductId: sp?.id ?? null,
        matchedProductId: product?.id ?? null,
        matchedProductSku: product?.sku ?? null,
        mappedInventorySku: sp?.mappedInventorySku ?? null,
        costStatus,
        costReliabilityStatus: reliabilityStatus,
        grossProfitReliable,
        profitWarnings: itemWarnings,
      });
    }

    const amountWithVat = Number(parsed.order.total) || 0;
    const vatAmount = amountWithVat - grossSales;
    const netSales = grossSales - refund.amount;
    const grossProfit = netSales - commissionCost - productCost - firstLegCost - fulfillmentCost - returnLossCost;
    const costStatus: CostStatus = parsed.products.length === 0 || costMissingItemCount === 0
      ? 'complete'
      : costMatchedItemCount > 0 ? 'partial' : 'missing';
    const costReliabilityStatus = resolveReliabilityStatus(itemBreakdowns.map((item) => item.costReliabilityStatus));

    results.set(parsed.order.id, {
      orderId: parsed.order.id,
      itemBreakdowns,
      profitSummary: {
        salesTaxMode: SALES_TAX_MODE,
        profitFormulaVersion: PROFIT_FORMULA_VERSION,
        amountWithVat: round2(amountWithVat),
        grossSales: round2(grossSales),
        vatAmount: round2(vatAmount),
        refundAmount: round2(refund.amount),
        netSales: round2(netSales),
        commissionCost: round2(commissionCost),
        productCost: round2(productCost),
        firstLegCost: round2(firstLegCost),
        fulfillmentCost: round2(fulfillmentCost),
        returnLossCost: round2(returnLossCost),
        grossProfit: round2(grossProfit),
        grossMargin: netSales > 0 ? round2((grossProfit / netSales) * 100) : 0,
        currency,
        costStatus,
        costMatchedItemCount,
        costMissingItemCount,
        costReliabilityStatus,
        grossProfitReliable: costReliabilityStatus === 'complete',
        hasMissingCost: costStatus !== 'complete',
        profitWarnings: summaryWarnings,
      },
    });
  }

  return results;
}
