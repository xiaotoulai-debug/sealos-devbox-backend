import { prisma } from '../src/lib/prisma';

const PRODUCT_ID = 93484;
const SKU = 'KFB03';
const ORDER_NO = 'PO-20260515-018';
const dryRun = !process.argv.includes('--fix');

function extractOfferIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match =
    url.match(/\/offer\/(\d{10,})/i) ||
    url.match(/[?&]id=(\d{10,})/i) ||
    url.match(/(\d{10,})/);
  return match?.[1] ?? null;
}

function parseProductIds(raw: string | null | undefined): number[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

async function main() {
  const product = await prisma.product.findUnique({
    where: { id: PRODUCT_ID },
    select: {
      id: true,
      sku: true,
      purchaseUrl: true,
      externalProductId: true,
      externalSkuId: true,
      externalSynced: true,
      inTransitQuantity: true,
      status: true,
      purchaseOrderId: true,
    },
  });

  const order = await prisma.purchaseOrder.findUnique({
    where: { orderNo: ORDER_NO },
    select: {
      id: true,
      orderNo: true,
      status: true,
      warehouseId: true,
      alibabaOrderId: true,
      logisticsStatus: true,
      items: {
        select: {
          id: true,
          offerId: true,
          productIds: true,
          quantity: true,
          alibabaOrderId: true,
          alibabaOrderStatus: true,
        },
      },
    },
  });

  if (!product || product.sku !== SKU) {
    throw new Error(`目标产品不存在或 SKU 不匹配：expected ${SKU}#${PRODUCT_ID}`);
  }
  if (!order) {
    throw new Error(`目标采购单不存在：${ORDER_NO}`);
  }

  const itemProductIds = [
    ...new Set(order.items.flatMap((item) => parseProductIds(item.productIds))),
  ];
  const warehouseStocks = await prisma.warehouseStock.findMany({
    where: { productId: PRODUCT_ID },
    select: {
      id: true,
      warehouseId: true,
      stockQuantity: true,
      inTransitQuantity: true,
      warehouse: { select: { name: true } },
    },
    orderBy: { warehouseId: 'asc' },
  });

  const warehouseInTransit = warehouseStocks.reduce(
    (sum, row) => sum + Number(row.inTransitQuantity ?? 0),
    0,
  );
  const offerFromUrl = extractOfferIdFromUrl(product.purchaseUrl);
  const hasValidSpecId = /^[a-fA-F0-9]{32}$/.test(product.externalSkuId ?? '');
  const canRepairExternalSynced =
    Boolean(product.externalProductId) &&
    product.externalProductId === offerFromUrl &&
    hasValidSpecId;

  console.log('[fix-kfb03-stale] mode:', dryRun ? 'DRY_RUN' : 'FIX');
  console.log('[fix-kfb03-stale] product.before:', JSON.stringify(product, null, 2));
  console.log('[fix-kfb03-stale] order.snapshot:', JSON.stringify(order, null, 2));
  console.log('[fix-kfb03-stale] itemProductIds:', JSON.stringify(itemProductIds));
  console.log('[fix-kfb03-stale] warehouseStocks.before:', JSON.stringify(warehouseStocks, null, 2));
  console.log(
    `[fix-kfb03-stale] inTransit compare: Product.inTransitQuantity=${product.inTransitQuantity}, ` +
    `WarehouseStock.sum(inTransitQuantity)=${warehouseInTransit}`,
  );
  console.log(
    `[fix-kfb03-stale] externalSynced check: offerFromUrl=${offerFromUrl ?? 'null'}, ` +
    `externalProductId=${product.externalProductId ?? 'null'}, specIdValid=${hasValidSpecId}, ` +
    `canRepair=${canRepairExternalSynced}`,
  );
  console.log('[fix-kfb03-stale] planned.after:', JSON.stringify({
    productId: PRODUCT_ID,
    inTransitQuantity: warehouseInTransit,
    externalSynced: canRepairExternalSynced ? true : product.externalSynced,
  }, null, 2));

  if (!itemProductIds.includes(PRODUCT_ID)) {
    throw new Error(`安全中止：${ORDER_NO} 的 purchase_order_items.product_ids 未包含 ${PRODUCT_ID}`);
  }

  if (dryRun) {
    console.log('[fix-kfb03-stale] DRY_RUN only, no write executed. Use --fix to apply.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: PRODUCT_ID },
      data: {
        inTransitQuantity: warehouseInTransit,
        ...(canRepairExternalSynced ? { externalSynced: true } : {}),
      },
    });
  });

  const after = await prisma.product.findUnique({
    where: { id: PRODUCT_ID },
    select: {
      id: true,
      sku: true,
      externalProductId: true,
      externalSkuId: true,
      externalSynced: true,
      inTransitQuantity: true,
      status: true,
      purchaseOrderId: true,
    },
  });
  console.log('[fix-kfb03-stale] product.after:', JSON.stringify(after, null, 2));
}

main()
  .catch((err) => {
    console.error('[fix-kfb03-stale] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
