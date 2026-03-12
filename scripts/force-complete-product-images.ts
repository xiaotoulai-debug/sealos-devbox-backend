/**
 * 强制补全产品图片 — 针对全部产品，根据 product_url 爬取 og:image
 *
 * 用于修复 API 返回的 logo/占位图问题，统一用页面 meta og:image 覆盖
 *
 * 用法: npm run backfill:product-images -- --force
 *   或: node -r ./scripts/preload-file-polyfill.js -r tsx/cjs scripts/force-complete-product-images.ts
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { fetchMainImageFromProductPage } from '../src/services/productImageCrawler';
import { resolveRegion, REGION_DOMAIN } from '../src/services/emagClient';

const CRAWL_DELAY_MS = 800;

function buildProductUrl(pnk: string, shopName: string, region?: string | null): string {
  const r = (region && ['RO', 'BG', 'HU'].includes(region) ? region : resolveRegion(shopName)) as 'RO' | 'BG' | 'HU';
  const domain = REGION_DOMAIN[r];
  return `https://www.${domain}/pd/${pnk}/`;
}

async function main() {
  const all = await prisma.storeProduct.findMany({
    select: {
      id: true,
      pnk: true,
      productUrl: true,
      mainImage: true,
      shop: { select: { shopName: true, region: true } },
    },
  });

  console.log(`[force-complete-product-images] 共 ${all.length} 个产品，开始爬取 og:image`);

  let updated = 0;
  const samples: Array<{ pnk: string; productUrl: string; mainImage: string }> = [];

  for (const p of all) {
    const productUrl = p.productUrl?.trim() || buildProductUrl(p.pnk, p.shop?.shopName ?? '', p.shop?.region);

    if (!productUrl) {
      console.warn(`  [跳过] PNK=${p.pnk} 无 product_url`);
      continue;
    }

    const img = await fetchMainImageFromProductPage(productUrl);
    if (img) {
      await prisma.storeProduct.update({
        where: { id: p.id },
        data: { mainImage: img, imageUrl: img, productUrl },
      });
      updated++;
      if (samples.length < 5) {
        samples.push({ pnk: p.pnk, productUrl, mainImage: img });
      }
      console.log(`  [og:image] PNK=${p.pnk} 已更新`);
    } else {
      console.warn(`  [未获取] PNK=${p.pnk} ${productUrl}`);
    }

    await new Promise((r) => setTimeout(r, CRAWL_DELAY_MS));
  }

  console.log('');
  console.log(`[force-complete-product-images] 完成，已更新 ${updated}/${all.length} 个产品`);
  console.log('');
  console.log('--- 示例产品 URL 供核对 ---');
  samples.forEach((s, i) => {
    console.log(`${i + 1}. PNK=${s.pnk}`);
    console.log(`   product_url: ${s.productUrl}`);
    console.log(`   main_image:  ${s.mainImage}`);
  });
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
