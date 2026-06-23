/**
 * 三个历史 FBE 发货单 store_product_id 正式 UPDATE（分两阶段）
 * 第一阶段：236554 + 224703（66 条）
 * 第二阶段：FBE-20260611-0001（24 条，EAN 优先）
 */
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { aggregateFbeInTransitByStoreProductIds } from '../src/services/fbeInTransitQuery';

const prisma = new PrismaClient();

type UpdateRow = {
  itemId: number;
  shipmentId: number;
  targetStoreProductId: number;
  sku: string;
  batchEAN?: string | null;
  targetEAN?: string | null;
  batchPNK?: string | null;
  targetPNK?: string | null;
  quantity?: number;
};

function normSku(v: string) {
  return String(v ?? '').trim().toUpperCase();
}

function loadDryRunRows(): {
  phase1: UpdateRow[];
  phase2: UpdateRow[];
} {
  const data = JSON.parse(fs.readFileSync('/tmp/fbe-3ship-preupdate-validation.json', 'utf8'));
  const phase1: UpdateRow[] = [];
  const phase2: UpdateRow[] = [];

  for (const ship of data.shipments) {
    const sn = ship.summary.shipmentNumber as string;
    for (const r of ship.detailRows) {
      if (r.currentStoreProductId != null || !r.targetStoreProductId) continue;
      const row: UpdateRow = {
        itemId: r.itemId,
        shipmentId: r.shipmentId,
        targetStoreProductId: r.targetStoreProductId,
        sku: r.sku,
        batchEAN: r.batchEAN,
        targetEAN: r.targetEAN,
        batchPNK: r.batchPNK,
        targetPNK: r.targetPNK,
        quantity: r.quantity,
      };
      if (sn === 'FBE-20260611-0001') phase2.push(row);
      else phase1.push(row);
    }
  }
  return { phase1, phase2 };
}

async function preCheckPhase1() {
  const shipments = await prisma.fbeShipment.findMany({
    where: { shipmentNumber: { in: ['236554', '224703'] } },
    select: { id: true, shipmentNumber: true, status: true, shopId: true },
    orderBy: { shipmentNumber: 'asc' },
  });

  const expected = {
    '236554': { id: 16, shopId: 5 },
    '224703': { id: 13, shopId: 5 },
  };

  for (const s of shipments) {
    const exp = expected[s.shipmentNumber as keyof typeof expected];
    if (!exp || s.id !== exp.id || s.shopId !== exp.shopId) {
      throw new Error(`Phase1 shipment mismatch: ${JSON.stringify(s)}`);
    }
  }

  const nullCounts = await prisma.fbeShipmentItem.groupBy({
    by: ['shipmentId'],
    where: { shipmentId: { in: [16, 13] }, storeProductId: null },
    _count: { _all: true },
  });

  const countMap = Object.fromEntries(nullCounts.map((c) => [c.shipmentId, c._count._all]));
  if (countMap[16] !== 26 || countMap[13] !== 40) {
    throw new Error(`Phase1 null count mismatch: ${JSON.stringify(countMap)}`);
  }

  return { shipments, nullCounts: countMap };
}

async function executeUpdates(rows: UpdateRow[], phaseLabel: string) {
  const results: Array<{ itemId: number; affected: number }> = [];
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const affected = await tx.fbeShipmentItem.updateMany({
        where: {
          id: row.itemId,
          shipmentId: row.shipmentId,
          storeProductId: null,
        },
        data: { storeProductId: row.targetStoreProductId },
      });
      if (affected.count !== 1) {
        throw new Error(
          `${phaseLabel} UPDATE failed itemId=${row.itemId} shipmentId=${row.shipmentId} affected=${affected.count}`,
        );
      }
      results.push({ itemId: row.itemId, affected: affected.count });
    }
  });
  return results;
}

async function postCheckPhase1() {
  const remaining = await prisma.fbeShipmentItem.groupBy({
    by: ['shipmentId'],
    where: { shipmentId: { in: [16, 13] }, storeProductId: null },
    _count: { _all: true },
  });
  const remainMap = Object.fromEntries(remaining.map((r) => [r.shipmentId, r._count._all]));
  if ((remainMap[16] ?? 0) !== 0 || (remainMap[13] ?? 0) !== 0) {
    throw new Error(`Phase1 remaining_null mismatch: ${JSON.stringify(remainMap)}`);
  }

  const spot = await prisma.fbeShipmentItem.findMany({
    where: { id: { in: [469, 470, 321, 322] } },
    select: {
      id: true,
      quantity: true,
      storeProductId: true,
      shipment: { select: { shipmentNumber: true } },
      product: { select: { sku: true } },
      storeProduct: { select: { ean: true, pnk: true } },
    },
    orderBy: { id: 'asc' },
  });

  const expectedEan: Record<number, string> = {
    469: '8410900793483',
    470: '0704334944268',
    321: '8410900793353',
    322: '0704334690899',
  };
  for (const row of spot) {
    const ean = row.storeProduct?.ean ?? '';
    if (expectedEan[row.id] && ean !== expectedEan[row.id]) {
      throw new Error(`Phase1 spot check failed id=${row.id} ean=${ean}`);
    }
  }
  return { remainMap, spot };
}

async function preCheckPhase2(rows: UpdateRow[]) {
  const shipment = await prisma.fbeShipment.findFirst({
    where: { shipmentNumber: 'FBE-20260611-0001' },
    select: { id: true, shipmentNumber: true, status: true, shopId: true },
  });
  if (!shipment || shipment.id !== 19) {
    throw new Error(`Phase2 shipment mismatch: ${JSON.stringify(shipment)}`);
  }

  const nullCount = await prisma.fbeShipmentItem.count({
    where: { shipmentId: 19, storeProductId: null },
  });
  if (nullCount !== 24) {
    throw new Error(`Phase2 null count=${nullCount}, expected 24`);
  }

  const checks: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const item = await prisma.fbeShipmentItem.findFirst({
      where: { id: row.itemId, shipmentId: 19 },
      select: {
        id: true,
        storeProductId: true,
        quantity: true,
        product: { select: { sku: true } },
      },
    });
    if (!item || item.storeProductId != null) {
      throw new Error(`Phase2 item ${row.itemId} invalid: storeProductId=${item?.storeProductId}`);
    }

    if (row.batchEAN !== row.targetEAN) {
      throw new Error(`Phase2 EAN mismatch itemId=${row.itemId}`);
    }

    const storeProducts = await prisma.storeProduct.findMany({
      where: {
        shopId: shipment.shopId,
        isArchived: false,
        ean: row.targetEAN ?? undefined,
      },
      select: {
        id: true,
        ean: true,
        pnk: true,
        mappedInventorySku: true,
        vendorSku: true,
        sku: true,
        isArchived: true,
      },
    });

    if (storeProducts.length !== 1) {
      throw new Error(
        `Phase2 StoreProduct not unique itemId=${row.itemId} ean=${row.targetEAN} count=${storeProducts.length}`,
      );
    }

    const sp = storeProducts[0];
    if (sp.id !== row.targetStoreProductId) {
      throw new Error(`Phase2 target SP mismatch itemId=${row.itemId} expected=${row.targetStoreProductId} got=${sp.id}`);
    }
    if (sp.isArchived) {
      throw new Error(`Phase2 SP archived itemId=${row.itemId}`);
    }

    const productSku = normSku(item.product.sku);
    const mapped = normSku(sp.mappedInventorySku ?? '');
    const vendor = normSku(sp.vendorSku ?? '');
    const spSku = normSku(sp.sku ?? '');
    const skuMatch =
      mapped === productSku ||
      vendor === productSku ||
      spSku === productSku ||
      normSku(row.sku) === productSku;

    if (!skuMatch) {
      throw new Error(
        `Phase2 SKU mismatch itemId=${row.itemId} productSku=${productSku} mapped=${mapped} vendor=${vendor}`,
      );
    }

    checks.push({
      itemId: row.itemId,
      sku: item.product.sku,
      batchEAN: row.batchEAN,
      targetEAN: row.targetEAN,
      batchPNK: row.batchPNK,
      targetPNK: row.targetPNK,
      eanMatch: row.batchEAN === row.targetEAN,
      pnkMatch: row.batchPNK === row.targetPNK,
      targetStoreProductId: row.targetStoreProductId,
      skuMatch: true,
    });
  }

  return { shipment, nullCount, checks };
}

async function postCheckPhase2() {
  const remaining = await prisma.fbeShipmentItem.count({
    where: { shipmentId: 19, storeProductId: null },
  });
  if (remaining !== 0) {
    throw new Error(`Phase2 remaining_null=${remaining}`);
  }

  const spot = await prisma.fbeShipmentItem.findMany({
    where: { id: { in: [497, 498, 519, 520] } },
    select: {
      id: true,
      quantity: true,
      storeProductId: true,
      shipment: { select: { shipmentNumber: true } },
      product: { select: { sku: true } },
      storeProduct: { select: { ean: true, pnk: true } },
    },
    orderBy: { id: 'asc' },
  });

  return { remaining, spot };
}

async function verifyInTransit(shopId: number) {
  const targets = [
    { shipmentNumber: '236554', sku: 'KFB01', storeProductId: 6005, itemId: 469 },
    { shipmentNumber: '236554', sku: 'XZ01', storeProductId: 5891, itemId: 470 },
    { shipmentNumber: '224703', sku: 'EJES01', storeProductId: 6237, itemId: 321 },
    { shipmentNumber: '224703', sku: 'ZSS001-E', storeProductId: 6157, itemId: 322 },
    { shipmentNumber: 'FBE-20260611-0001', sku: 'KFB02', storeProductId: 427914, itemId: 497 },
    { shipmentNumber: 'FBE-20260611-0001', sku: 'EJ001-Pink', storeProductId: 6061, itemId: 498 },
    { shipmentNumber: 'FBE-20260611-0001', sku: 'QCZDX02', storeProductId: 5924, itemId: 519 },
    { shipmentNumber: 'FBE-20260611-0001', sku: 'YKQ001', storeProductId: 5971, itemId: 520 },
  ];

  const storeProductIds = [...new Set(targets.map((t) => t.storeProductId))];
  const directMap = await aggregateFbeInTransitByStoreProductIds(shopId, storeProductIds);

  const items = await prisma.fbeShipmentItem.findMany({
    where: { id: { in: targets.map((t) => t.itemId) } },
    select: {
      id: true,
      quantity: true,
      storeProductId: true,
      shipment: { select: { shipmentNumber: true, status: true } },
      product: { select: { sku: true } },
    },
  });

  const results = targets.map((t) => {
    const item = items.find((i) => i.id === t.itemId);
    const inTransit = directMap.get(t.storeProductId) ?? 0;
    const countsForShipment =
      item?.shipment.status === 'SHIPPED' && item.storeProductId === t.storeProductId;
    return {
      ...t,
      itemQuantity: item?.quantity ?? null,
      shipmentStatus: item?.shipment.status ?? null,
      storeProductIdFilled: item?.storeProductId ?? null,
      aggregateInTransitForStoreProduct: inTransit,
      note:
        item?.shipment.status === 'PENDING'
          ? 'PENDING 单不计入 SHIPPED 在途聚合（符合 aggregateFbeInTransitByStoreProductIds 逻辑）'
          : countsForShipment
            ? 'SHIPPED 且在途量已计入对应 StoreProduct'
            : '需人工核对',
    };
  });

  return { inTransitScope: 'STORE_PRODUCT', results };
}

async function main() {
  const { phase1, phase2 } = loadDryRunRows();
  if (phase1.length !== 66) throw new Error(`phase1 rows=${phase1.length}, expected 66`);
  if (phase2.length !== 24) throw new Error(`phase2 rows=${phase2.length}, expected 24`);

  const report: Record<string, unknown> = {
    executedAt: new Date().toISOString(),
    phase1: {},
    phase2: {},
    inTransit: {},
  };

  // Phase 1 pre-check
  report.phase1 = { preCheck: await preCheckPhase1() };

  // Phase 1 execute
  const phase1Results = await executeUpdates(phase1, 'Phase1');
  report.phase1 = {
    ...(report.phase1 as object),
    updateCount: phase1Results.length,
    affectedRows: phase1Results.reduce((s, r) => s + r.affected, 0),
  };

  // Phase 1 post-check
  report.phase1 = {
    ...(report.phase1 as object),
    postCheck: await postCheckPhase1(),
  };

  // Phase 2 pre-check
  report.phase2 = { preCheck: await preCheckPhase2(phase2) };

  // Phase 2 execute
  const phase2Results = await executeUpdates(phase2, 'Phase2');
  report.phase2 = {
    ...(report.phase2 as object),
    updateCount: phase2Results.length,
    affectedRows: phase2Results.reduce((s, r) => s + r.affected, 0),
    pnkDiffRecorded: (report.phase2 as { preCheck: { checks: UpdateRow[] } }).preCheck,
  };

  // Phase 2 post-check
  report.phase2 = {
    ...(report.phase2 as object),
    postCheck: await postCheckPhase2(),
  };

  // In-transit verification
  report.inTransit = await verifyInTransit(5);

  fs.writeFileSync('/tmp/fbe-3ship-update-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error('EXECUTION FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
