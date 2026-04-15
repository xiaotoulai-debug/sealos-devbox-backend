/**
 * EAN 归一化残留监控脚本
 * 用途：统计各店铺中仍未完成 13 位归一化的 EAN 记录数
 * 执行：npx tsx scripts/monitor-ean-normalization.ts
 */
import { prisma } from '../src/lib/prisma';

async function main() {
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  console.log(`\n========================================`);
  console.log(`  EAN 归一化残留监控报告`);
  console.log(`  生成时间: ${now} (北京时间)`);
  console.log(`========================================\n`);

  // 1. 全局统计
  const [total12, total13, totalNull] = await Promise.all([
    prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT COUNT(*) as cnt FROM store_products WHERE ean ~ '^[0-9]{12}$'`
    ),
    prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT COUNT(*) as cnt FROM store_products WHERE ean ~ '^[0-9]{13}$'`
    ),
    prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT COUNT(*) as cnt FROM store_products WHERE ean IS NULL`
    ),
  ]);

  console.log('【全库汇总】');
  console.log(`  12位残留（需补零）: ${Number(total12[0].cnt)} 条`);
  console.log(`  13位标准格式:       ${Number(total13[0].cnt)} 条`);
  console.log(`  无 EAN:             ${Number(totalNull[0].cnt)} 条`);

  // 2. 按店铺分组（重点关注 shopId=5）
  const byShop = await prisma.$queryRawUnsafe<{ shop_id: number; shop_name: string; region: string; cnt_12: bigint; cnt_13: bigint }[]>(`
    SELECT
      sp.shop_id,
      sa.shop_name,
      sa.region,
      COUNT(CASE WHEN sp.ean ~ '^[0-9]{12}$' THEN 1 END) AS cnt_12,
      COUNT(CASE WHEN sp.ean ~ '^[0-9]{13}$' THEN 1 END) AS cnt_13
    FROM store_products sp
    JOIN shop_authorizations sa ON sa.id = sp.shop_id
    WHERE sp.ean IS NOT NULL
    GROUP BY sp.shop_id, sa.shop_name, sa.region
    ORDER BY cnt_12 DESC
  `);

  console.log('\n【按店铺分布】');
  console.log('  shopId  店铺名       站点  12位残留  13位标准');
  console.log('  ------  ----------  ----  --------  --------');
  for (const row of byShop) {
    const flag = row.shop_id === 5 ? ' ← 重点' : '';
    const cnt12 = Number(row.cnt_12);
    const cnt13 = Number(row.cnt_13);
    const warn = cnt12 > 0 ? '⚠️' : '✅';
    console.log(
      `  ${String(row.shop_id).padEnd(6)}  ${row.shop_name.padEnd(10)}  ${row.region.padEnd(4)}  ${warn} ${String(cnt12).padStart(6)}    ${String(cnt13).padStart(6)}${flag}`
    );
  }

  // 3. shopId=5 的详细残留样本（最多展示 10 条）
  const samples = await prisma.$queryRawUnsafe<{ pnk: string; ean: string; name: string }[]>(`
    SELECT pnk, ean, LEFT(name, 50) AS name
    FROM store_products
    WHERE shop_id = 5 AND ean ~ '^[0-9]{12}$'
    ORDER BY synced_at DESC
    LIMIT 10
  `);

  if (samples.length > 0) {
    console.log(`\n【shopId=5 残留样本（最新 ${samples.length} 条）】`);
    samples.forEach(s => {
      console.log(`  pnk=${s.pnk}  ean="${s.ean}"  →  应为"0${s.ean}"`);
    });
    console.log('\n  💡 以上记录将在下次产品雷达（每 2 小时）同步后自动补齐。');
  } else {
    console.log('\n✅ shopId=5 无残留 12 位 EAN，归一化完成！');
  }

  console.log('\n========================================\n');
}

main().catch(console.error).finally(() => prisma.$disconnect());
