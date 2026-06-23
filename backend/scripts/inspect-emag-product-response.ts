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
  if (items.length === 0) {
    console.log('无产品数据');
    process.exit(0);
  }

  const FIELD_KEYS = [
    'brand', 'Brand', 'product_brand', 'productBrand',
    'ownership', 'number_of_offers', 'numberOfOffers',
    'buy_button_rank', 'buyButtonRank',
    'part_number_key', 'pnk', 'part_number',
    'ean', 'ext_part_number',
  ] as const;

  const pickField = (row: Record<string, unknown>, keys: readonly string[]): unknown => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
    }
    return null;
  };

  console.log(`\n=== eMAG product_offer/read 字段抽样（共 ${Math.min(5, items.length)} 条，不含密钥）===`);
  console.log(`shopId=${shopId}`);

  for (let i = 0; i < Math.min(5, items.length); i++) {
    const row = items[i] as Record<string, unknown>;
    const pnk = pickField(row, ['part_number_key', 'pnk', 'part_number']);
    const brand = pickField(row, ['brand', 'Brand', 'product_brand', 'productBrand']);
    const ownership = row.ownership ?? null;
    const numberOfOffers = pickField(row, ['number_of_offers', 'numberOfOffers']);
    const buyButtonRank = pickField(row, ['buy_button_rank', 'buyButtonRank']);
    const partNumberKey = pickField(row, ['part_number_key', 'pnk']);
    const partNumber = row.part_number ?? null;
    const ean = row.ean ?? null;

    console.log(`\n--- 样本 #${i + 1} ---`);
    console.log('顶层键:', Object.keys(row).sort().join(', '));
    console.log('brand (brand|Brand|product_brand|productBrand):', brand);
    console.log('ownership:', ownership);
    console.log('number_of_offers:', numberOfOffers);
    console.log('buy_button_rank:', buyButtonRank);
    console.log('part_number_key:', partNumberKey);
    console.log('part_number:', partNumber);
    console.log('ean:', ean);
    console.log('pnk 别名存在:', row.pnk != null ? 'yes' : 'no');
  }

  const brandKeyPresence = FIELD_KEYS.filter((k) =>
    items.slice(0, 5).some((row: Record<string, unknown>) => row[k] !== undefined && row[k] !== null && row[k] !== ''),
  );
  console.log('\n=== 5 条样本中出现 brand 相关 key 出现情况 ===');
  console.log('出现的 key:', brandKeyPresence.join(', ') || '(无)');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
