import { prisma } from '../src/lib/prisma';

async function verify() {
  for (const shopId of [2, 3, 6, 7]) {
    const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId }, select: { shopName: true, region: true } });
    const top5 = await prisma.storeProduct.findMany({
      where: { shopId, comprehensiveSales: { gt: 0 } },
      orderBy: { comprehensiveSales: 'desc' },
      take: 5,
      select: { sku: true, comprehensiveSales: true },
    });
    const nonZero = await prisma.storeProduct.count({ where: { shopId, comprehensiveSales: { gt: 0 } } });
    const total = await prisma.storeProduct.count({ where: { shopId } });
    console.log(`\nshop=${shop?.shopName}(id=${shopId}, ${shop?.region}): 非零综合日销=${nonZero}/${total}`);
    top5.forEach(p => console.log(`  ${p.sku}: ${p.comprehensiveSales}`));
  }
  await prisma.$disconnect();
}
verify().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
