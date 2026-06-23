/**
 * 一次性迁移脚本：将 Product.stockActual 老数据平滑迁移到多仓架构
 *
 * 逻辑：
 *   1. 检查 warehouses 表，若无记录则创建"默认本地主仓"（type=LOCAL）
 *   2. 查询所有 stockActual > 0 的本地产品（sku IS NOT NULL, isDeleted = false）
 *   3. 为每个产品在 warehouse_stocks 表中 upsert 一条记录（productId + warehouseId 联合唯一）
 *   4. 打印迁移统计
 *
 * 幂等安全：多次运行不会重复插入，upsert 以最新 stockActual 覆盖
 *
 * 运行方式：npx ts-node scripts/migrate-to-multi-warehouse.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('[多仓迁移] 开始...');

  // ── 1. 确保默认主仓存在 ──────────────────────────────────────
  let defaultWarehouse = await prisma.warehouse.findFirst({
    where: { type: 'LOCAL', status: 'ACTIVE' },
    orderBy: { id: 'asc' },
  });

  if (!defaultWarehouse) {
    defaultWarehouse = await prisma.warehouse.create({
      data: {
        name:   '默认本地主仓',
        type:   'LOCAL',
        status: 'ACTIVE',
        remark: '系统自动创建 — 单仓→多仓迁移',
      },
    });
    console.log(`[多仓迁移] 已创建默认本地主仓 (id=${defaultWarehouse.id})`);
  } else {
    console.log(`[多仓迁移] 默认本地主仓已存在 (id=${defaultWarehouse.id}, name="${defaultWarehouse.name}")`);
  }

  const warehouseId = defaultWarehouse.id;

  // ── 2. 查询所有有库存的本地产品 ───────────────────────────────
  const products = await prisma.product.findMany({
    where: {
      sku:       { not: null },
      isDeleted: false,
      stockActual: { gt: 0 },
    },
    select: { id: true, sku: true, stockActual: true },
  });

  console.log(`[多仓迁移] 发现 ${products.length} 个有库存的本地产品`);

  if (products.length === 0) {
    console.log('[多仓迁移] 无需迁移，脚本结束');
    return;
  }

  // ── 3. 批量 upsert 到 warehouse_stocks ────────────────────────
  let migratedCount = 0;
  for (const prod of products) {
    await prisma.warehouseStock.upsert({
      where: {
        productId_warehouseId: {
          productId:   prod.id,
          warehouseId: warehouseId,
        },
      },
      create: {
        productId:     prod.id,
        warehouseId:   warehouseId,
        stockQuantity: prod.stockActual,
        lockedQuantity: 0,
      },
      update: {
        stockQuantity: prod.stockActual,
      },
    });
    migratedCount++;
  }

  console.log(`[多仓迁移] ✅ 成功将 ${migratedCount} 条老库存数据迁移至默认主仓 (warehouseId=${warehouseId})`);
}

main()
  .catch((e) => {
    console.error('[多仓迁移] ❌ 迁移失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
