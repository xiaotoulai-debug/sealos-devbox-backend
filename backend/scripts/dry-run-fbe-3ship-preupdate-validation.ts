/**
 * 三个历史 FBE 发货单 store_product_id 执行前校验 dry-run（只读）
 */
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type BatchRow = { row: number; sku: string; ean: string; pnk: string; quantity: number };

type Decision =
  | 'SAFE_TO_UPDATE'
  | 'BATCH_TEXT_MATCHED_WITH_QUANTITY_DIFF'
  | 'BATCH_EAN_MATCH_PNK_DIFF'
  | 'OWNER_CONFIRM_REQUIRED'
  | 'ALREADY_FILLED_MATCHED'
  | 'NEED_MANUAL_CONFIRM';

const raw = JSON.parse(fs.readFileSync('/tmp/fbe-batch-text.json', 'utf8')) as Record<string, BatchRow[]>;
const BATCHES: Record<string, { name: string; rows: BatchRow[] }> = {
  '236554': { name: '第16批次', rows: raw['236554'] },
  'FBE-20260611-0001': { name: '第17批次', rows: raw['FBE-20260611-0001'] },
  '224703': { name: '第15批次', rows: raw['224703'] },
};

function normSku(v: string) {
  return String(v ?? '').trim().toUpperCase();
}
function normEan(v: string) {
  return String(v ?? '').trim();
}
function normPnk(v: string) {
  return String(v ?? '').trim().toUpperCase();
}

function matchBatchRow(rows: BatchRow[], sku: string, quantity: number) {
  const matches = rows.filter((r) => normSku(r.sku) === normSku(sku) && r.quantity === quantity);
  if (matches.length === 1) return matches[0];
  const bySku = rows.filter((r) => normSku(r.sku) === normSku(sku));
  if (bySku.length === 1) return bySku[0];
  return null;
}

type DetailRow = {
  shipmentNumber: string;
  shipmentId: number;
  itemId: number;
  productId: number;
  sku: string;
  quantity: number;
  batchQty: number | null;
  systemQty: number;
  currentStoreProductId: number | null;
  batchEAN: string | null;
  batchPNK: string | null;
  targetEAN: string | null;
  targetPNK: string | null;
  targetStoreProductId: number | null;
  eanMatch: boolean | null;
  pnkMatch: boolean | null;
  batchRow: number | null;
  decision: Decision;
  note: string;
};

async function processShipment(shipmentNumber: string) {
  const batch = BATCHES[shipmentNumber];
  const shipment = await prisma.fbeShipment.findFirst({
    where: { shipmentNumber },
    select: { id: true, shipmentNumber: true, shopId: true, status: true },
  });
  if (!shipment) throw new Error(`missing ${shipmentNumber}`);

  const items = await prisma.fbeShipmentItem.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      productId: true,
      quantity: true,
      storeProductId: true,
      product: { select: { sku: true } },
    },
  });

  const eans = [...new Set(batch.rows.map((r) => normEan(r.ean)).filter(Boolean))];
  const storeProducts = await prisma.storeProduct.findMany({
    where: { shopId: shipment.shopId, isArchived: false, ean: { in: eans } },
    select: { id: true, ean: true, pnk: true, mappedInventorySku: true },
  });
  const spByEan = new Map<string, typeof storeProducts>();
  for (const sp of storeProducts) {
    const e = normEan(sp.ean);
    const arr = spByEan.get(e) ?? [];
    arr.push(sp);
    spByEan.set(e, arr);
  }

  const detailRows: DetailRow[] = [];

  for (const item of items) {
    const sku = normSku(item.product.sku);
    const batchRow = matchBatchRow(batch.rows, sku, item.quantity);
    const batchEAN = batchRow ? normEan(batchRow.ean) : null;
    const batchPNK = batchRow ? normPnk(batchRow.pnk) : null;
    const batchQty = batchRow?.quantity ?? null;

    if (item.storeProductId != null) {
      detailRows.push({
        shipmentNumber,
        shipmentId: shipment.id,
        itemId: item.id,
        productId: item.productId,
        sku,
        quantity: item.quantity,
        batchQty,
        systemQty: item.quantity,
        currentStoreProductId: item.storeProductId,
        batchEAN,
        batchPNK,
        targetEAN: null,
        targetPNK: null,
        targetStoreProductId: null,
        eanMatch: null,
        pnkMatch: null,
        batchRow: batchRow?.row ?? null,
        decision: 'ALREADY_FILLED_MATCHED',
        note: '已填 store_product_id',
      });
      continue;
    }

    if (!batchRow) {
      detailRows.push({
        shipmentNumber,
        shipmentId: shipment.id,
        itemId: item.id,
        productId: item.productId,
        sku,
        quantity: item.quantity,
        batchQty: null,
        systemQty: item.quantity,
        currentStoreProductId: null,
        batchEAN: null,
        batchPNK: null,
        targetEAN: null,
        targetPNK: null,
        targetStoreProductId: null,
        eanMatch: false,
        pnkMatch: false,
        batchRow: null,
        decision: 'OWNER_CONFIRM_REQUIRED',
        note: '批次表无法按 SKU+qty 匹配',
      });
      continue;
    }

    const cands = spByEan.get(batchEAN!) ?? [];
    if (cands.length === 0) {
      detailRows.push({
        shipmentNumber,
        shipmentId: shipment.id,
        itemId: item.id,
        productId: item.productId,
        sku,
        quantity: item.quantity,
        batchQty,
        systemQty: item.quantity,
        currentStoreProductId: null,
        batchEAN,
        batchPNK,
        targetEAN: null,
        targetPNK: null,
        targetStoreProductId: null,
        eanMatch: false,
        pnkMatch: false,
        batchRow: batchRow.row,
        decision: 'OWNER_CONFIRM_REQUIRED',
        note: `shopId=${shipment.shopId} 下 EAN=${batchEAN} 无 StoreProduct`,
      });
      continue;
    }
    if (cands.length > 1) {
      detailRows.push({
        shipmentNumber,
        shipmentId: shipment.id,
        itemId: item.id,
        productId: item.productId,
        sku,
        quantity: item.quantity,
        batchQty,
        systemQty: item.quantity,
        currentStoreProductId: null,
        batchEAN,
        batchPNK,
        targetEAN: null,
        targetPNK: null,
        targetStoreProductId: null,
        eanMatch: false,
        pnkMatch: false,
        batchRow: batchRow.row,
        decision: 'OWNER_CONFIRM_REQUIRED',
        note: `EAN=${batchEAN} 多候选: ${cands.map((c) => c.id).join(',')}`,
      });
      continue;
    }

    const sp = cands[0];
    const targetStoreProductId = sp.id;
    const targetEAN = normEan(sp.ean);
    const targetPNK = normPnk(sp.pnk);
    const eanMatch = batchEAN === targetEAN;
    const pnkMatch = batchPNK === targetPNK;
    const qtyDiff = item.quantity !== batchQty;

    let decision: Decision;
    let note: string;
    if (!eanMatch) {
      decision = 'OWNER_CONFIRM_REQUIRED';
      note = 'batchEAN 与 targetEAN 不一致';
    } else if (!pnkMatch) {
      decision = 'BATCH_EAN_MATCH_PNK_DIFF';
      note = `批次PNK=${batchPNK} DB PNK=${targetPNK}`;
    } else if (qtyDiff) {
      decision = 'BATCH_TEXT_MATCHED_WITH_QUANTITY_DIFF';
      note = `系统qty=${item.quantity} 批次qty=${batchQty} 差值${item.quantity - batchQty! >= 0 ? '+' : ''}${item.quantity - batchQty!}`;
    } else {
      decision = 'SAFE_TO_UPDATE';
      note = 'EAN/PNK 一致，StoreProduct 唯一';
    }

    detailRows.push({
      shipmentNumber,
      shipmentId: shipment.id,
      itemId: item.id,
      productId: item.productId,
      sku,
      quantity: item.quantity,
      batchQty,
      systemQty: item.quantity,
      currentStoreProductId: null,
      batchEAN,
      batchPNK,
      targetEAN,
      targetPNK,
      targetStoreProductId,
      eanMatch,
      pnkMatch,
      batchRow: batchRow.row,
      decision,
      note,
    });
  }

  const nullCount = items.filter((i) => i.storeProductId == null).length;
  const totalQuantity = items.reduce((s, i) => s + i.quantity, 0);
  const batchTextQuantity = batch.rows.reduce((s, r) => s + r.quantity, 0);

  const summary = {
    shipmentNumber,
    batchName: batch.name,
    shipmentId: shipment.id,
    status: shipment.status,
    shopId: shipment.shopId,
    totalItems: items.length,
    totalQuantity,
    batchTextQuantity,
    quantityDiff: totalQuantity - batchTextQuantity,
    nullStoreProductId: nullCount,
    updateSafeCount: detailRows.filter((r) => r.decision === 'SAFE_TO_UPDATE').length,
    pnkDiffCount: detailRows.filter((r) => r.decision === 'BATCH_EAN_MATCH_PNK_DIFF').length,
    quantityDiffCount: detailRows.filter((r) => r.decision === 'BATCH_TEXT_MATCHED_WITH_QUANTITY_DIFF').length,
    manualCount: detailRows.filter((r) =>
      ['OWNER_CONFIRM_REQUIRED', 'NEED_MANUAL_CONFIRM'].includes(r.decision),
    ).length,
    ownerConfirmRequiredCount: detailRows.filter(
      (r) => r.decision === 'BATCH_EAN_MATCH_PNK_DIFF' || r.decision === 'OWNER_CONFIRM_REQUIRED',
    ).length,
  };

  return { summary, detailRows };
}

async function main() {
  const order = ['236554', 'FBE-20260611-0001', '224703'];
  const shipments = [];
  for (const sn of order) shipments.push(await processShipment(sn));

  const preUpdateNullCount = shipments.reduce((s, r) => s + r.summary.nullStoreProductId, 0);
  const safeCount = shipments.reduce((s, r) => s + r.summary.updateSafeCount, 0);
  const qtyDiffCount = shipments.reduce((s, r) => s + r.summary.quantityDiffCount, 0);
  const ownerConfirmCount = shipments.reduce((s, r) => s + r.summary.ownerConfirmRequiredCount, 0);

  const output = {
    generatedAt: new Date().toISOString(),
    preUpdateNullCount,
    postUpdateSafeOnlyNullRemaining: preUpdateNullCount - safeCount - qtyDiffCount,
    postUpdateAllConfirmedNullRemaining: ownerConfirmCount,
    shipments,
  };

  fs.writeFileSync('/tmp/fbe-3ship-preupdate-validation.json', JSON.stringify(output, null, 2));
  console.log(JSON.stringify({
    summaries: shipments.map((s) => s.summary),
    pnkDiffTotal: shipments.reduce((s, r) => s + r.summary.pnkDiffCount, 0),
    safeTotal: safeCount,
    ownerConfirmTotal: ownerConfirmCount,
  }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
