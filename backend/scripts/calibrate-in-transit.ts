/**
 * 在途库存校准脚本 (In-Transit Inventory Calibration)
 *
 * 适用场景：采购单被删除但在途库存未回滚，导致 warehouse_stocks.in_transit_quantity 存在幽灵数据
 * 唯一真相源：purchase_orders 中 status ∈ {PENDING, PLACED, IN_TRANSIT, PARTIAL} 的子单 quantity
 *
 * 执行方式：
 *   cd backend
 *   npx tsx scripts/calibrate-in-transit.ts          # 仅预览，不修改数据
 *   npx tsx scripts/calibrate-in-transit.ts --fix     # 预览后执行修复
 */

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--fix');

const ACTIVE_STATUSES = ['PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL'];

async function main() {
  console.log('====================================================');
  console.log(' 在途库存校准脚本');
  console.log(` 模式：${DRY_RUN ? '🔍 预览（DRY RUN，不修改数据）' : '🔧 修复（--fix）'}`);
  console.log('====================================================\n');

  // ── 步骤 1：从未完成采购单中计算每个产品真实的在途量 ────────────────
  const activeItems = await prisma.purchaseOrderItem.findMany({
    where: {
      purchaseOrder: { status: { in: ACTIVE_STATUSES as any } },
      productIds: { not: null },
    },
    select: { quantity: true, productIds: true },
  });

  // 解析 productIds JSON，累加每个产品的真实在途量
  const realTransitMap = new Map<number, number>(); // productId → 真实在途量
  for (const item of activeItems) {
    let pids: number[] = [];
    try {
      pids = JSON.parse(item.productIds ?? '[]');
    } catch { continue; }
    for (const pid of pids) {
      realTransitMap.set(pid, (realTransitMap.get(pid) ?? 0) + item.quantity);
    }
  }

  console.log(`✅ 当前未完成采购单涉及 ${realTransitMap.size} 个产品的在途量\n`);

  // ── 步骤 2：查出所有有在途库存的 warehouse_stocks 记录 ────────────────
  const dirtyStocks = await prisma.warehouseStock.findMany({
    where: { inTransitQuantity: { gt: 0 } },
    select: { id: true, productId: true, warehouseId: true, inTransitQuantity: true },
  });

  // ── 步骤 3：计算差异，筛出需要修正的行 ────────────────────────────────
  type DiffItem = {
    id: number;
    productId: number;
    warehouseId: number;
    currentQty: number;
    realQty: number;
    ghostQty: number;
  };

  const diffs: DiffItem[] = [];

  for (const stock of dirtyStocks) {
    const real = realTransitMap.get(stock.productId) ?? 0;
    const ghost = stock.inTransitQuantity - real;
    if (Math.abs(ghost) > 0.001) { // 浮点容忍
      diffs.push({
        id:          stock.id,
        productId:   stock.productId,
        warehouseId: stock.warehouseId,
        currentQty:  stock.inTransitQuantity,
        realQty:     real,
        ghostQty:    ghost,
      });
    }
  }

  if (diffs.length === 0) {
    console.log('🎉 没有发现任何在途库存差异，数据完全一致，无需修复！\n');
    return;
  }

  // ── 步骤 4：打印差异报告 ───────────────────────────────────────────────
  console.log(`⚠️  发现 ${diffs.length} 条在途库存差异：\n`);
  console.log(
    ['productId', 'warehouseId', '当前值(脏)', '校准真实值', '幽灵数量'].join('\t\t'),
  );
  console.log('─'.repeat(70));
  for (const d of diffs) {
    const tag = d.ghostQty > 0 ? '← 幽灵库存' : '← 数量偏低';
    console.log(
      [d.productId, d.warehouseId, d.currentQty, d.realQty, d.ghostQty].join('\t\t') +
      `  ${tag}`,
    );
  }
  console.log();

  if (DRY_RUN) {
    console.log('ℹ️  这是预览模式。确认以上差异无误后，请加 --fix 参数重新运行以执行修复：');
    console.log('   npx tsx scripts/calibrate-in-transit.ts --fix\n');
    return;
  }

  // ── 步骤 5：在事务内批量修正（--fix 模式）────────────────────────────
  console.log('🔧 开始在事务内执行校准...\n');

  await prisma.$transaction(async (tx) => {
    for (const d of diffs) {
      await tx.warehouseStock.update({
        where: { id: d.id },
        data:  { inTransitQuantity: d.realQty },
      });
      console.log(
        `  ✔ product_id=${d.productId} warehouse_id=${d.warehouseId}：` +
        `${d.currentQty} → ${d.realQty}（修正 ${d.ghostQty > 0 ? '-' : '+'}${Math.abs(d.ghostQty)}）`,
      );
    }
  });

  console.log(`\n✅ 校准完成，共修正 ${diffs.length} 条记录，事务已提交。`);
  console.log('   在途库存已与现存未完成采购单 100% 对齐。\n');
}

main()
  .catch((e) => {
    console.error('❌ 校准脚本执行失败：', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
