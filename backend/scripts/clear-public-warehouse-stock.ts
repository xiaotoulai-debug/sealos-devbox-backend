import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.warehouse.findMany({
    where: { name: { contains: '公共备货仓' } },
    select: { id: true, name: true, status: true },
  });

  console.log('[预检] 匹配到仓库:', candidates);

  if (candidates.length !== 1) {
    throw new Error(`公共备货仓匹配数量异常：${candidates.length}，拒绝执行清零`);
  }

  const warehouse = candidates[0];

  if (warehouse.id === 7) {
    throw new Error('安全保护触发：目标仓库 ID=7 是 EMAG备货仓，拒绝执行');
  }

  const before = await prisma.warehouseStock.findMany({
    where: { warehouseId: warehouse.id },
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      stockQuantity: true,
      lockedQuantity: true,
      inTransitQuantity: true,
    },
    orderBy: { id: 'asc' },
  });

  const dirtyRows = before.filter(
    (r) => r.stockQuantity !== 0 || r.lockedQuantity !== 0 || r.inTransitQuantity !== 0,
  );

  console.log(`[预检] 即将清零仓库 #${warehouse.id} ${warehouse.name}，影响行数: ${before.length}`);
  console.log(`[预检] 非零库存/锁定/在途行数: ${dirtyRows.length}`);
  console.table(dirtyRows.slice(0, 50));

  const result = await prisma.$transaction(async (tx) => {
    return tx.warehouseStock.updateMany({
      where: {
        warehouseId: warehouse.id,
      },
      data: {
        stockQuantity: 0,
        lockedQuantity: 0,
        inTransitQuantity: 0,
      },
    });
  });

  const afterDirtyRows = await prisma.warehouseStock.findMany({
    where: {
      warehouseId: warehouse.id,
      OR: [
        { stockQuantity: { not: 0 } },
        { lockedQuantity: { not: 0 } },
        { inTransitQuantity: { not: 0 } },
      ],
    },
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      stockQuantity: true,
      lockedQuantity: true,
      inTransitQuantity: true,
    },
  });

  console.log(`[完成] 公共备货仓库存已清零，更新行数: ${result.count}`);
  console.log(`[复核] 清理后非零库存/锁定/在途行数: ${afterDirtyRows.length}`);
  if (afterDirtyRows.length > 0) {
    console.table(afterDirtyRows.slice(0, 50));
    throw new Error('清理后仍存在非零库存/锁定/在途记录，请人工复核');
  }
}

main()
  .catch((err) => {
    console.error('[失败]', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
