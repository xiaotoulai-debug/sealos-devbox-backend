import { prisma } from '../src/lib/prisma';

async function diagnose() {
  // 找 BG/HU 有销量的 SKU，检查 StoreProduct 表里有没有这些 SKU
  const shopIds = [2, 3, 6, 7]; // BG/HU 的 shopId
  for (const shopId of shopIds) {
    const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId }, select: { shopName: true, region: true } });
    
    // 订单中有销量的 SKU（30天）
    const salesRows = await prisma.$queryRawUnsafe<Array<{sku: string; qty: string}>>(
      `SELECT LOWER(TRIM(COALESCE(elem->>'sku', ''))) as sku, SUM(COALESCE((elem->>'quantity')::int,0)) as qty
       FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem
       WHERE shop_id = ${shopId} AND status IN (1,2,3,4) AND order_time >= NOW() - INTERVAL '30 days'
       GROUP BY 1 ORDER BY qty DESC LIMIT 10`
    );
    
    console.log(`\n=== shop=${shop?.shopName}(id=${shopId}, ${shop?.region}) ===`);
    console.log('订单30天销量SKU:', salesRows.map(r => `${r.sku}(${r.qty})`).join(', '));
    
    // 检查这些 SKU 在 StoreProduct 中是否存在
    for (const row of salesRows.slice(0, 5)) {
      const match = await prisma.storeProduct.findFirst({
        where: {
          shopId,
          OR: [
            { sku: { equals: row.sku, mode: 'insensitive' } },
            { vendorSku: { equals: row.sku, mode: 'insensitive' } },
          ],
        },
        select: { id: true, sku: true, vendorSku: true, comprehensiveSales: true },
      });
      console.log(`  SKU=${row.sku}(qty=${row.qty}) -> StoreProduct: ${match ? `id=${match.id}, sku=${match.sku}, vendorSku=${match.vendorSku}, comprehSales=${match.comprehensiveSales}` : '【未找到匹配产品】'}`);
    }
  }
  await prisma.$disconnect();
}
diagnose().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
