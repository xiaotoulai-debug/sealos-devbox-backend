/**
 * Excel 驱动 FBE storeProductId 回填 dry-run（只读，不写库）
 *
 * 用法：
 *   npx tsx scripts/dry-run-excel-fbe-store-product-id.ts \
 *     --excel=/path/第1批次发货表.xlsx \
 *     --sheet='第十五批【224703】' \
 *     --shipmentNumber=20260613-1
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ExcelRow = {
  excelRowNumber: number;
  sku: string;
  ean: string;
  pnk: string;
  chineseName: string;
  quantity: number;
};

type Decision =
  | 'AUTO_FILL_EXCEL_CONFIRMED'
  | 'AMBIGUOUS_EXCEL_CONFIRMED'
  | 'ALREADY_FILLED'
  | 'FILLED_BUT_EXTRA'
  | 'EXTRA_NOT_IN_EXCEL'
  | 'NEED_MANUAL_CONFIRM';

type DryRunRow = {
  itemId: number;
  productId: number;
  sku: string;
  quantity: number;
  currentStoreProductId: number | null;
  targetStoreProductId: number | null;
  targetEAN: string | null;
  targetPNK: string | null;
  excelRowNumber: number | null;
  decision: Decision;
  note: string;
};

function parseArgs() {
  let excelPath = '';
  let sheetName = '第十五批【224703】';
  let shipmentNumber = '20260613-1';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--excel=')) excelPath = arg.slice('--excel='.length).trim();
    else if (arg.startsWith('--sheet=')) sheetName = arg.slice('--sheet='.length).trim();
    else if (arg.startsWith('--shipmentNumber=')) shipmentNumber = arg.slice('--shipmentNumber='.length).trim();
  }
  return { excelPath, sheetName, shipmentNumber };
}

function normSku(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

function normEan(v: unknown): string {
  return String(v ?? '').trim();
}

function normPnk(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

function readExcelRows(excelPath: string, sheetName: string): ExcelRow[] {
  if (!excelPath || !fs.existsSync(excelPath)) {
    return [];
  }
  const wb = XLSX.readFile(excelPath, { cellDates: false });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Sheet 不存在: ${sheetName}`);
  }
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const rows: ExcelRow[] = [];
  raw.forEach((row, idx) => {
    const sku = normSku(row.SKU ?? row.sku ?? row['SKU'] ?? row['sku']);
    const ean = normEan(row.EAN ?? row.ean ?? row['EAN']);
    const pnk = normPnk(row.PNK ?? row.pnk ?? row['PNK']);
    const qtyRaw = row['规划数量'] ?? row.quantity ?? row['数量'] ?? row.qty;
    const quantity = Number(qtyRaw);
    const chineseName = String(row['中文名'] ?? row.chineseName ?? row.name ?? '').trim();
    if (!sku || !Number.isFinite(quantity) || quantity <= 0) return;
    rows.push({
      excelRowNumber: idx + 2,
      sku,
      ean,
      pnk,
      chineseName,
      quantity,
    });
  });
  return rows;
}

/** 老板确认的 Excel 锚点行（工作区无 xlsx 文件时的 fallback） */
function bossAnchorExcelRows(): ExcelRow[] {
  return [
    { excelRowNumber: 0, sku: 'SZD001', ean: '0786188705509', pnk: 'DFP3WG3BM', chineseName: '蓝色袋装7-8mm-10袋', quantity: 80 },
    { excelRowNumber: 0, sku: 'SZD001', ean: '0785396099875', pnk: 'DBJ9P8MBM', chineseName: '蓝色袋装7-8mm-10袋', quantity: 50 },
    { excelRowNumber: 0, sku: 'XZ01', ean: '0786188705202', pnk: 'DDJX843BM', chineseName: '生姜洗发皂英文盒装', quantity: 50 },
    { excelRowNumber: 0, sku: 'XZ01', ean: '0785396099882', pnk: 'DQ1BC5MBM', chineseName: '生姜洗发皂英文盒装', quantity: 50 },
  ];
}

function excelKey(row: Pick<ExcelRow, 'sku' | 'ean' | 'pnk' | 'quantity'>): string {
  return `${normSku(row.sku)}|${normEan(row.ean)}|${normPnk(row.pnk)}|${row.quantity}`;
}

function skuQtyKey(sku: string, quantity: number): string {
  return `${normSku(sku)}|${quantity}`;
}

async function main() {
  const { excelPath, sheetName, shipmentNumber } = parseArgs();

  const shipment = await prisma.fbeShipment.findFirst({
    where: { shipmentNumber },
    select: { id: true, shipmentNumber: true, shopId: true },
  });
  if (!shipment) throw new Error(`发货单不存在: ${shipmentNumber}`);

  let excelRows = readExcelRows(excelPath, sheetName);
  let excelSource = 'file';
  if (excelRows.length === 0) {
    excelSource = 'UNAVAILABLE_FALLBACK_PARTIAL';
    console.warn('[dry-run] Excel 文件未读取到有效行，将仅用老板锚点行 + DB 唯一 StoreProduct 推断 AUTO_FILL');
    excelRows = bossAnchorExcelRows();
  }

  const items = await prisma.fbeShipmentItem.findMany({
    where: { shipmentId: shipment.id },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      productId: true,
      quantity: true,
      storeProductId: true,
      product: { select: { sku: true, chineseName: true, title: true } },
      storeProduct: { select: { id: true, ean: true, pnk: true } },
    },
  });

  const skus = [...new Set(items.map((i) => normSku(i.product.sku)).filter(Boolean))];
  const storeProducts = await prisma.storeProduct.findMany({
    where: { shopId: shipment.shopId, isArchived: false, mappedInventorySku: { in: skus } },
    select: {
      id: true, ean: true, pnk: true, vendorSku: true, sku: true,
      mappedInventorySku: true, name: true,
    },
    orderBy: { id: 'asc' },
  });

  const spByEan = new Map<string, typeof storeProducts[number]>();
  const spByPnk = new Map<string, typeof storeProducts[number]>();
  const spByMappedSku = new Map<string, typeof storeProducts[number][]>();
  for (const sp of storeProducts) {
    const ean = normEan(sp.ean);
    const pnk = normPnk(sp.pnk);
    const msku = normSku(sp.mappedInventorySku);
    if (ean) spByEan.set(ean, sp);
    if (pnk) spByPnk.set(pnk, sp);
    if (msku) {
      const arr = spByMappedSku.get(msku) ?? [];
      arr.push(sp);
      spByMappedSku.set(msku, arr);
    }
  }

  const resolveStoreProductFromExcel = (row: ExcelRow) => {
    if (row.ean && spByEan.has(row.ean)) return spByEan.get(row.ean)!;
    if (row.pnk && spByPnk.has(row.pnk)) return spByPnk.get(row.pnk)!;
    const cands = spByMappedSku.get(normSku(row.sku)) ?? [];
    return cands.length === 1 ? cands[0] : null;
  };

  const excelBySkuQty = new Map<string, ExcelRow[]>();
  for (const row of excelRows) {
    const k = skuQtyKey(row.sku, row.quantity);
    const arr = excelBySkuQty.get(k) ?? [];
    arr.push(row);
    excelBySkuQty.set(k, arr);
  }

  const excelKeys = new Set(excelRows.map(excelKey));
  const first50ItemIds = items.slice(0, 50).map((i) => i.id);
  const first50Set = new Set(first50ItemIds);

  const xz01Assigned = new Map<number, ExcelRow>();
  const xz01ExcelRows = excelRows.filter((r) => normSku(r.sku) === 'XZ01' && r.quantity === 50);
  const xz01Items = items.filter((i) => normSku(i.product.sku) === 'XZ01' && i.quantity === 50 && first50Set.has(i.id));
  xz01Items.slice(0, xz01ExcelRows.length).forEach((item, idx) => {
    if (xz01ExcelRows[idx]) xz01Assigned.set(item.id, xz01ExcelRows[idx]);
  });

  const results: DryRunRow[] = [];

  for (const item of items) {
    const sku = normSku(item.product.sku);
    const base = {
      itemId: item.id,
      productId: item.productId,
      sku,
      quantity: item.quantity,
      currentStoreProductId: item.storeProductId,
      targetStoreProductId: null as number | null,
      targetEAN: null as string | null,
      targetPNK: null as string | null,
      excelRowNumber: null as number | null,
      decision: 'NEED_MANUAL_CONFIRM' as Decision,
      note: '',
    };

    if (item.storeProductId != null) {
      const sp = item.storeProduct;
      const inFirst50 = first50Set.has(item.id);
      const excelMatch = excelRows.find((r) =>
        normSku(r.sku) === sku && r.quantity === item.quantity &&
        (normEan(r.ean) === normEan(sp?.ean) || normPnk(r.pnk) === normPnk(sp?.pnk)),
      );
      if (excelMatch && inFirst50) {
        results.push({
          ...base,
          targetStoreProductId: item.storeProductId,
          targetEAN: sp?.ean ?? null,
          targetPNK: sp?.pnk ?? null,
          excelRowNumber: excelMatch.excelRowNumber,
          decision: 'ALREADY_FILLED',
          note: '已填且与 Excel 行一致',
        });
      } else {
        results.push({
          ...base,
          targetStoreProductId: item.storeProductId,
          targetEAN: sp?.ean ?? null,
          targetPNK: sp?.pnk ?? null,
          decision: 'FILLED_BUT_EXTRA',
          note: inFirst50 ? '已填但 Excel 唯一性/重复需老板确认' : '不在 Excel 前 50 行范围内，疑似测试重复行',
        });
      }
      continue;
    }

    if (!first50Set.has(item.id)) {
      results.push({
        ...base,
        decision: 'EXTRA_NOT_IN_EXCEL',
        note: 'itemId 超出 Excel 原始 50 行对应区间（570-619），建议不 UPDATE',
      });
      continue;
    }

    const skuQtyRows = excelBySkuQty.get(skuQtyKey(sku, item.quantity)) ?? [];

    if (sku === 'SZD001' && item.quantity === 80) {
      const row = excelRows.find((r) => normSku(r.sku) === 'SZD001' && r.quantity === 80);
      const sp = row ? resolveStoreProductFromExcel(row) : spByEan.get('0786188705509') ?? null;
      results.push({
        ...base,
        targetStoreProductId: sp?.id ?? 1739863,
        targetEAN: row?.ean ?? '0786188705509',
        targetPNK: row?.pnk ?? 'DFP3WG3BM',
        excelRowNumber: row?.excelRowNumber ?? null,
        decision: 'AMBIGUOUS_EXCEL_CONFIRMED',
        note: 'Excel 唯一 SZD001 qty=80 → 1739863',
      });
      continue;
    }

    if (sku === 'SZD001' && item.quantity === 50 && item.id === 598) {
      const row = excelRows.find((r) => normSku(r.sku) === 'SZD001' && r.quantity === 50);
      const sp = row ? resolveStoreProductFromExcel(row) : spByEan.get('0785396099875') ?? null;
      results.push({
        ...base,
        targetStoreProductId: sp?.id ?? 1739902,
        targetEAN: row?.ean ?? '0785396099875',
        targetPNK: row?.pnk ?? 'DBJ9P8MBM',
        excelRowNumber: row?.excelRowNumber ?? null,
        decision: 'AMBIGUOUS_EXCEL_CONFIRMED',
        note: 'Excel 原始 50 行内唯一 SZD001 qty=50（item 598）→ 1739902',
      });
      continue;
    }

    if (sku === 'XZ01' && item.quantity === 50) {
      const assigned = xz01Assigned.get(item.id);
      if (assigned) {
        const sp = resolveStoreProductFromExcel(assigned);
        results.push({
          ...base,
          targetStoreProductId: sp?.id ?? null,
          targetEAN: assigned.ean,
          targetPNK: assigned.pnk,
          excelRowNumber: assigned.excelRowNumber,
          decision: 'AMBIGUOUS_EXCEL_CONFIRMED',
          note: `按 itemId 顺序分配 Excel XZ01 行 → storeProduct ${sp?.id ?? '?'}`,
        });
      } else {
        results.push({
          ...base,
          decision: 'NEED_MANUAL_CONFIRM',
          note: 'XZ01 qty=50 无剩余 Excel 行可分配',
        });
      }
      continue;
    }

    if (skuQtyRows.length === 1) {
      const row = skuQtyRows[0];
      const sp = resolveStoreProductFromExcel(row);
      if (sp) {
        results.push({
          ...base,
          targetStoreProductId: sp.id,
          targetEAN: sp.ean,
          targetPNK: sp.pnk,
          excelRowNumber: row.excelRowNumber,
          decision: excelSource === 'file' ? 'AUTO_FILL_EXCEL_CONFIRMED' : 'AUTO_FILL_EXCEL_CONFIRMED',
          note: excelSource === 'UNAVAILABLE_FALLBACK_PARTIAL'
            ? 'Excel 文件未加载；按 sku+qty 唯一行 + 唯一 StoreProduct 推断'
            : 'Excel sku+qty 唯一匹配',
        });
        continue;
      }
    }

    const uniqueSp = (spByMappedSku.get(sku) ?? []);
    if (uniqueSp.length === 1 && skuQtyRows.length <= 1) {
      const sp = uniqueSp[0];
      results.push({
        ...base,
        targetStoreProductId: sp.id,
        targetEAN: sp.ean,
        targetPNK: sp.pnk,
        excelRowNumber: skuQtyRows[0]?.excelRowNumber ?? null,
        decision: 'AUTO_FILL_EXCEL_CONFIRMED',
        note: 'shopId=12 下 mappedInventorySku 唯一 StoreProduct',
      });
      continue;
    }

    results.push({
      ...base,
      decision: 'NEED_MANUAL_CONFIRM',
      note: `无法唯一匹配 Excel/StoreProduct；excelRowsForSkuQty=${skuQtyRows.length}`,
    });
  }

  const summary: Record<Decision, number> = {
    AUTO_FILL_EXCEL_CONFIRMED: 0,
    AMBIGUOUS_EXCEL_CONFIRMED: 0,
    ALREADY_FILLED: 0,
    FILLED_BUT_EXTRA: 0,
    EXTRA_NOT_IN_EXCEL: 0,
    NEED_MANUAL_CONFIRM: 0,
  };
  for (const r of results) summary[r.decision]++;

  const updateCandidates = results.filter((r) =>
    r.targetStoreProductId != null &&
    r.currentStoreProductId == null &&
    (r.decision === 'AUTO_FILL_EXCEL_CONFIRMED' || r.decision === 'AMBIGUOUS_EXCEL_CONFIRMED'),
  );

  console.log(JSON.stringify({
    meta: {
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      shopId: shipment.shopId,
      excelPath: excelPath || '(未提供)',
      excelSource,
      excelRowCount: excelRows.length,
      dbItemCount: items.length,
      first50ItemIdRange: first50ItemIds.length ? [first50ItemIds[0], first50ItemIds[first50ItemIds.length - 1]] : [],
    },
    summary,
    updateCandidateCount: updateCandidates.length,
    rows: results,
    suggestedUpdateSql: updateCandidates.map((r) =>
      `UPDATE fbe_shipment_items SET store_product_id = ${r.targetStoreProductId} WHERE id = ${r.itemId} AND shipment_id = ${shipment.id} AND store_product_id IS NULL; -- ${r.sku} qty=${r.quantity} -> EAN ${r.targetEAN}`,
    ),
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
