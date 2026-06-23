/**
 * 一次性修复脚本：回填历史 FBE 发货单的 totalProductValue
 *
 * 背景：totalProductValue 字段在 2026-03 后才加入，早期创建的单子均为 0。
 * 逻辑：找出所有 totalProductValue = 0 的发货单，重算 Σ(qty × purchasePrice)，批量写回。
 *
 * 运行方式（在 backend 目录下）：
 *   npx tsx scripts/fix-fbe-product-values.ts
 *
 * 支持 dry-run（只打印，不写库）：
 *   DRY_RUN=true npx tsx scripts/fix-fbe-product-values.ts
 */

import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

async function main() {
  console.log('==========================================================');
  console.log(' FBE 历史货值回填脚本');
  console.log(` 模式：${DRY_RUN ? '🔍 DRY-RUN（只读，不写库）' : '✏️  WRITE（将实际写入数据库）'}`);
  console.log('==========================================================\n');

  // ── 查询所有货值为 0 的发货单（含明细 + 产品采购价）──────────────
  const shipments = await prisma.fbeShipment.findMany({
    where: { totalProductValue: 0 },
    select: {
      id:             true,
      shipmentNumber: true,
      status:         true,
      createdAt:      true,
      items: {
        select: {
          quantity: true,
          product:  { select: { id: true, sku: true, purchasePrice: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`共找到 ${shipments.length} 张待修复的发货单\n`);

  if (shipments.length === 0) {
    console.log('✅ 无需修复，所有发货单货值均已填写。');
    return;
  }

  let updated  = 0;
  let skipped  = 0;   // 无明细或 purchasePrice 全 0 的单子
  let totalVal = 0;

  for (const s of shipments) {
    // 重算货值：Σ(item.quantity × product.purchasePrice)
    const value = s.items.reduce((sum, item) => {
      const price = Number(item.product?.purchasePrice ?? 0);
      return sum + item.quantity * price;
    }, 0);

    const valueFmt = value.toFixed(2);
    const date     = s.createdAt.toISOString().slice(0, 10);

    if (value === 0) {
      // 单据本身没有明细，或所有产品采购价均为 0，跳过
      console.log(
        `  ⚠️  跳过 #${s.id} [${s.shipmentNumber}] (${date}, ${s.status})` +
        ` — ${s.items.length} 项明细但货值仍为 0（采购价缺失？）`,
      );
      skipped++;
      continue;
    }

    console.log(
      `  ✔  #${s.id} [${s.shipmentNumber}] (${date}, ${s.status})` +
      `  ${s.items.length} SKU → totalProductValue = ${valueFmt}`,
    );

    if (!DRY_RUN) {
      await prisma.fbeShipment.update({
        where: { id: s.id },
        data:  { totalProductValue: parseFloat(valueFmt) },
      });
    }

    updated++;
    totalVal += value;
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  修复成功：${updated} 张`);
  console.log(`  跳过（货值仍为 0）：${skipped} 张`);
  console.log(`  累计回填货值：${totalVal.toFixed(2)}`);
  if (DRY_RUN) {
    console.log('\n  ℹ️  DRY_RUN=true，未实际写入。取消该环境变量后重跑即可写库。');
  } else {
    console.log('\n  ✅ 数据库已更新完毕。');
  }
  console.log('==========================================================');
}

main()
  .catch((err) => {
    console.error('脚本执行异常：', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
