import { prisma } from '../src/lib/prisma';

async function diagnose() {
  // 直接跑 getSalesStatsByShop 内部 SQL，看 shopId=6 和 shopId=7 的结果
  const shopIds = [6, 7];
  for (const shopId of shopIds) {
    const now = new Date();
    const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
    const d30Str = d30.toISOString().slice(0, 10);

    const baseWhere = `shop_id = ${shopId} AND (status = 4 OR status IN (1,2,3,4))`;
    const skuExpr = `LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\\\r', ''), E'\\\\n', '')))`;
    const qtyExpr = `COALESCE((elem->>'quantity')::int, 0)`;

    console.log(`\n=== getSalesStatsByShop SQL 内部查询 shopId=${shopId} ===`);
    console.log(`baseWhere: ${baseWhere}`);

    const rows = await prisma.$queryRawUnsafe<Array<{sku: string; total: string}>>(
      `SELECT ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseWhere} AND order_time >= '${d30Str}' GROUP BY 1 ORDER BY total DESC LIMIT 10`
    );
    console.log(`30天销量结果: ${rows.map(r => `${r.sku}(${r.total})`).join(', ')}`);
    
    // 再直接看 raw JSON 看字段名
    const rawOrder = await prisma.platformOrder.findFirst({
      where: { shopId, status: 4 },
      orderBy: { orderTime: 'desc' },
      select: { productsJson: true },
    });
    if (rawOrder?.productsJson) {
      const prods = JSON.parse(rawOrder.productsJson);
      console.log(`最新订单 productsJson 字段结构:`, JSON.stringify(prods[0]));
    }
  }
  await prisma.$disconnect();
}
diagnose().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
