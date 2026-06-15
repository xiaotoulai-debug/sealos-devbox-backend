/**
 * FBE 历史明细 storeProductId 回填 dry-run 报告（默认只读，不写库）
 *
 * 用法：
 *   npx tsx scripts/dry-run-backfill-fbe-shipment-store-product-id.ts
 *   npx tsx scripts/dry-run-backfill-fbe-shipment-store-product-id.ts --shopId=12
 *   npx tsx scripts/dry-run-backfill-fbe-shipment-store-product-id.ts --shipmentNumber=20260613-1
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Decision = 'AUTO_FILL' | 'AMBIGUOUS' | 'NOT_FOUND';

function parseArgs() {
  let shopId: number | undefined;
  let shipmentNumber: string | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--shopId=')) {
      shopId = parseInt(arg.slice('--shopId='.length), 10);
    } else if (arg.startsWith('--shipmentNumber=')) {
      shipmentNumber = arg.slice('--shipmentNumber='.length).trim();
    }
  }
  return { shopId, shipmentNumber };
}

async function main() {
  const { shopId, shipmentNumber } = parseArgs();

  const shipmentWhere: { shopId?: number; shipmentNumber?: string } = {};
  if (shopId != null && Number.isInteger(shopId) && shopId > 0) {
    shipmentWhere.shopId = shopId;
  }
  if (shipmentNumber) {
    shipmentWhere.shipmentNumber = shipmentNumber;
  }

  const items = await prisma.fbeShipmentItem.findMany({
    where: {
      storeProductId: null,
      ...(Object.keys(shipmentWhere).length > 0 ? { shipment: shipmentWhere } : {}),
    },
    select: {
      id: true,
      quantity: true,
      productId: true,
      product: { select: { sku: true } },
      shipment: {
        select: { id: true, shipmentNumber: true, shopId: true },
      },
    },
    orderBy: [{ shipmentId: 'asc' }, { id: 'asc' }],
  });

  console.log(`\n=== FBE storeProductId dry-run 报告 ===`);
  console.log(`筛选: shopId=${shopId ?? 'ALL'} shipmentNumber=${shipmentNumber ?? 'ALL'}`);
  console.log(`待分析历史明细: ${items.length} 条\n`);

  const summary = { AUTO_FILL: 0, AMBIGUOUS: 0, NOT_FOUND: 0 };

  for (const item of items) {
    const productSku = String(item.product.sku ?? '').trim();
    let candidates: Array<{
      id: number;
      ean: string | null;
      pnk: string;
      vendorSku: string | null;
      mappedInventorySku: string | null;
      name: string;
    }> = [];

    if (productSku) {
      candidates = await prisma.storeProduct.findMany({
        where: {
          shopId: item.shipment.shopId,
          isArchived: false,
          mappedInventorySku: productSku,
        },
        select: {
          id: true,
          ean: true,
          pnk: true,
          vendorSku: true,
          mappedInventorySku: true,
          name: true,
        },
        orderBy: { id: 'asc' },
      });
    }

    let decision: Decision;
    if (candidates.length === 0) {
      decision = 'NOT_FOUND';
    } else if (candidates.length === 1) {
      decision = 'AUTO_FILL';
    } else {
      decision = 'AMBIGUOUS';
    }
    summary[decision]++;

    console.log(JSON.stringify({
      shipmentId: item.shipment.id,
      shipmentNumber: item.shipment.shipmentNumber,
      itemId: item.id,
      shopId: item.shipment.shopId,
      productId: item.productId,
      productSku,
      quantity: item.quantity,
      candidateStoreProducts: candidates,
      decision,
    }, null, 2));
  }

  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n（dry-run 模式，未写入数据库）\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
