/**
 * 检查 eMAG product_offer/read 原始响应，定位 url/product_url/links 等字段
 * 用法: npm run inspect:emag-product [shopId]
 * 不传 shopId 时使用第一个 eMAG 店铺
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';

async function main() {
  const shopIdArg = process.argv[2];
  let shopId: number;
  if (shopIdArg && !isNaN(Number(shopIdArg))) {
    shopId = Number(shopIdArg);
  } else {
    const first = await prisma.shopAuthorization.findFirst({
      where: { platform: { equals: 'emag', mode: 'insensitive' } },
      select: { id: true },
    });
    if (!first) {
      console.error('未找到 eMAG 店铺，请指定 shopId');
      process.exit(1);
    }
    shopId = first.id;
    console.log(`使用第一个 eMAG 店铺 shopId=${shopId}`);
  }
  const creds = await getEmagCredentials(shopId);
  const res = await readProductOffers(creds, { currentPage: 1, itemsPerPage: 5 });
  if (res.isError) {
    console.error('API 错误:', res.messages);
    process.exit(1);
  }
  const raw = res.results as any;
  const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
  const first = items[0];
  if (!first) {
    console.log('无产品数据');
    process.exit(0);
  }
  const pnk = first.part_number_key ?? first.pnk ?? first.part_number ?? '?';
  console.log('\n=== eMAG product_offer/read 首条产品完整响应 ===');
  console.log('PNK:', pnk);
  console.log('\n顶层键:', Object.keys(first));
  console.log('\n可能含 URL 的字段:');
  for (const k of Object.keys(first)) {
    const v = first[k];
    if (typeof v === 'string' && v.startsWith('http')) console.log(`  ${k}: ${v}`);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const str = JSON.stringify(v);
      if (str.includes('http')) console.log(`  ${k}:`, JSON.stringify(v).slice(0, 300));
    }
  }
  console.log('\n完整 JSON (首条):');
  console.log(JSON.stringify(first, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
