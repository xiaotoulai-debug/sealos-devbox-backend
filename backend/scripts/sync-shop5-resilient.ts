/**
 * shopId=5 弹性同步 v2：逐页拉取 + 逐页 upsert，单页失败不中断整体流程
 */
import { prisma } from '../src/lib/prisma';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';
import { normalizeEmagProduct } from '../src/services/emagProductNormalizer';

const SHOP_ID = 5;
const PAGE_SIZE = 20;
const TIMEOUT  = 180_000;
const DELAY_MS = 2000;    // 页间冷却 2s
const MAX_CONSECUTIVE_FAILURES = 3;

async function upsertBatch(creds: any, batch: any[]) {
  let upserted = 0;
  for (const raw of batch) {
    try {
      const np = normalizeEmagProduct(raw, creds.region, { logOutput: false });
      if (!np.pnk) continue;
      await prisma.storeProduct.upsert({
        where: { shopId_pnk: { shopId: SHOP_ID, pnk: np.pnk } },
        create: {
          shopId: SHOP_ID, pnk: np.pnk,
          vendorSku: np.vendorSku, sku: np.sku, ean: np.ean,
          name: np.name ?? '', salePrice: np.salePrice ?? 0,
          currency: np.currency, stock: np.stock ?? 0, status: np.status ?? 0,
          categoryId: np.categoryId, mainImage: np.mainImage,
          imageUrl: np.mainImage, syncedAt: new Date(),
        },
        update: {
          vendorSku: np.vendorSku, sku: np.sku, ean: np.ean,
          name: np.name ?? '', salePrice: np.salePrice ?? 0,
          currency: np.currency, stock: np.stock ?? 0, status: np.status ?? 0,
          categoryId: np.categoryId,
          ...(np.mainImage ? { mainImage: np.mainImage, imageUrl: np.mainImage } : {}),
          syncedAt: new Date(),
        },
      });
      upserted++;
    } catch (e: any) {
      console.error(`  [upsert err] pnk=${raw?.part_number_key}: ${e.message?.slice(0, 120)}`);
    }
  }
  return upserted;
}

async function main() {
  console.log(`=== shopId=${SHOP_ID} 弹性全量同步 (PAGE_SIZE=${PAGE_SIZE}, TIMEOUT=${TIMEOUT/1000}s) ===`);
  const creds = await getEmagCredentials(SHOP_ID);
  console.log(`凭证: ${creds.username} @ ${creds.baseUrl}\n`);

  let page = 1;
  let totalFetched = 0;
  let totalUpserted = 0;
  let consecutiveFailures = 0;

  while (true) {
    const start = Date.now();
    console.log(`► Page ${page} 请求中...`);
    try {
      const res = await readProductOffers(creds, {
        currentPage: page, itemsPerPage: PAGE_SIZE,
      }, { timeout: TIMEOUT });
      const elapsed = Date.now() - start;

      if (res.isError) {
        console.log(`  ❌ API 业务错误 (${elapsed}ms): ${res.messages?.join('; ')}`);
        consecutiveFailures++;
      } else {
        const raw = res.results as any;
        const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
        console.log(`  ✅ Page ${page} OK — ${batch.length} 条, ${elapsed}ms`);

        if (batch.length === 0) {
          console.log('  (空页，同步结束)');
          break;
        }

        const upserted = await upsertBatch(creds, batch);
        totalFetched += batch.length;
        totalUpserted += upserted;
        consecutiveFailures = 0;
        console.log(`  💾 已入库 ${upserted}/${batch.length} 条 (累计: ${totalFetched} fetched, ${totalUpserted} upserted)`);

        if (batch.length < PAGE_SIZE) {
          console.log('  (最后一页，同步结束)');
          break;
        }
      }
    } catch (e: any) {
      const elapsed = Date.now() - start;
      console.log(`  ❌ 网络异常 (${elapsed}ms): ${e.message?.slice(0, 100)}`);
      consecutiveFailures++;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`\n⛔ 连续 ${MAX_CONSECUTIVE_FAILURES} 次失败，安全中止。已入库 ${totalUpserted} 条。`);
      break;
    }

    page++;
    if (page > 100) { console.log('达到最大页数限制 100'); break; }
    console.log(`  (冷却 ${DELAY_MS}ms...)`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\n=== 同步完成 ===`);
  console.log(`  总拉取: ${totalFetched} 条`);
  console.log(`  总入库: ${totalUpserted} 条`);
  console.log(`  shopId=5 DB 总记录数: ${await prisma.storeProduct.count({ where: { shopId: SHOP_ID } })}`);

  // 检查目标 EAN
  const eanCheck = await prisma.storeProduct.findMany({
    where: { ean: { contains: '786188704609' } },
    select: { pnk: true, ean: true, shopId: true },
  });
  console.log(`  EAN 786188704609: ${eanCheck.length > 0 ? '✅ 已入库 ' + JSON.stringify(eanCheck) : '⚠️ 尚未覆盖到该页'}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
