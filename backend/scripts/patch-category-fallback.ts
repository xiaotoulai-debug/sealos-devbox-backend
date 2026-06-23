/**
 * Phase 1.5 补数脚本：category 字段回退修复
 *
 * 修复场景：历史导入时 category = cleanStr(三级类)，导致仅有 L1/L2 分类的产品
 *           category 字段为 null，前端"类目"列显示空（-）。
 *
 * 修复策略：category = L3 ?? L2 ?? L1（三级优先，二级兜底，一级兜底）
 *
 * 安全红线：
 *   - 只更新 category 字段，绝对不触碰 status、brand、price 等业务字段
 *   - 只处理 category=null 但 categoryL2 或 categoryL1 有值的记录
 *   - finally 块强制 $disconnect，防止连接挂起
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function patchCategoryFallback(): Promise<void> {
  console.log('[patch-category-fallback] 开始扫描需修复的产品...\n');

  // 查找所有 category=null 但 L2 或 L1 有值的记录
  const targets = await prisma.product.findMany({
    where: {
      category: null,
      OR: [
        { categoryL2: { not: null } },
        { categoryL1: { not: null } },
      ],
    },
    select: {
      id:         true,
      pnk:        true,
      categoryL1: true,
      categoryL2: true,
      categoryL3: true,
    },
  });

  const total = targets.length;
  console.log(`[patch-category-fallback] 发现 ${total} 条需修复记录\n`);

  if (total === 0) {
    console.log('[patch-category-fallback] 无需修复，退出。');
    return;
  }

  let fixed = 0;
  let skipped = 0;

  for (const p of targets) {
    // 三级优先 → 二级兜底 → 一级兜底
    const fallback = p.categoryL3 ?? p.categoryL2 ?? p.categoryL1;

    if (!fallback) {
      // L1/L2/L3 全为 null，无法填充，跳过
      skipped++;
      continue;
    }

    await prisma.product.update({
      where: { id: p.id },
      data:  { category: fallback },
      // ★ 只更新 category，其余字段（status/brand/price 等）保持不变
    });

    fixed++;

    // 每 100 条打印一次进度
    if (fixed % 100 === 0) {
      console.log(`  进度: ${fixed}/${total - skipped} 条已修复...`);
    }
  }

  console.log('\n[patch-category-fallback] ✅ 修复完成！');
  console.log(`  已修复: ${fixed} 条`);
  console.log(`  跳过(L1/L2/L3均为null): ${skipped} 条`);
  console.log(`  合计扫描: ${total} 条`);
}

patchCategoryFallback()
  .catch((err) => {
    console.error('[patch-category-fallback] ❌ 脚本执行失败:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.log('[patch-category-fallback] 数据库连接已关闭。');
  });
