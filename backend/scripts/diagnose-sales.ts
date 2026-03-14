import { prisma } from '../src/lib/prisma';

async function diagnose() {
  const shops = await prisma.shopAuthorization.findMany({
    where: { status: 'active', platform: { equals: 'emag', mode: 'insensitive' } },
    select: { id: true, shopName: true, region: true },
  });
  console.log('活跃店铺:', shops.map(s => `${s.shopName}(id=${s.id}, region=${s.region})`).join(', '));

  for (const shop of shops) {
    const total = await prisma.platformOrder.count({ where: { shopId: shop.id } });
    const statuses = await prisma.platformOrder.groupBy({ by: ['status'], where: { shopId: shop.id }, _count: true });
    const statusStr = statuses.map(s => `status${s.status}:${s._count}`).join(', ');
    console.log(`\nshop=${shop.shopName}(id=${shop.id}, ${shop.region}): 订单总数=${total}, 状态=${statusStr}`);

    if (total > 0) {
      const recent = await prisma.platformOrder.findFirst({
        where: { shopId: shop.id },
        orderBy: { orderTime: 'desc' },
        select: { orderTime: true, status: true, productsJson: true },
      });
      if (recent) {
        const prods = JSON.parse(recent.productsJson || '[]') as Array<{sku?: string; pnk?: string}>;
        const skus = prods.slice(0, 3).map(p => `sku=${p.sku ?? '(空)'},pnk=${p.pnk ?? '(空)'}`).join(' | ');
        console.log(`  最新订单: time=${recent.orderTime?.toISOString().slice(0,10)}, status=${recent.status}`);
        console.log(`  产品样本: [${skus}]`);
      }

      // SQL 检查实际 SKU 格式
      const skuSample = await prisma.$queryRawUnsafe<Array<{sku: string; qty: string}>>(
        `SELECT LOWER(TRIM(COALESCE(elem->>'sku', ''))) as sku, SUM(COALESCE((elem->>'quantity')::int, 0)) as qty FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE shop_id = ${shop.id} AND status IN (1,2,3,4) AND order_time >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY qty DESC LIMIT 5`
      );
      console.log(`  30天内有销量SKU TOP5: ${skuSample.map(r => `${r.sku}(qty=${r.qty})`).join(', ')}`);
    }
  }

  // 检查 StoreProduct 的 SKU 格式（BG/HU 产品）
  const bghuProducts = await prisma.storeProduct.findMany({
    where: { shop: { region: { in: ['BG', 'HU'] } } },
    select: { shopId: true, sku: true, vendorSku: true, comprehensiveSales: true },
    take: 5,
  });
  console.log('\nBG/HU StoreProduct 样本:');
  bghuProducts.forEach(p => console.log(`  shopId=${p.shopId}, sku=${p.sku}, vendorSku=${p.vendorSku}, comprehensiveSales=${p.comprehensiveSales}`));

  await prisma.$disconnect();
}
diagnose().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
