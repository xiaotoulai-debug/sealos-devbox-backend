/**
 * 数据大清洗 — 将 main_image 含 emag-logo、l.svg、1.svg、temporary-images 的设为 null
 *
 * 用法: node -r ./scripts/preload-file-polyfill.js -r tsx/cjs scripts/cleanup-placeholder-images.ts
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';

const BAD_PATTERNS = ['emag-logo', 'l.svg', '1.svg', 'temporary-images'];

function isBadImage(url: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return BAD_PATTERNS.some((p) => lower.includes(p));
}

async function main() {
  const all = await prisma.storeProduct.findMany({
    select: { id: true, pnk: true, mainImage: true },
  });
  const bad = all.filter((p) => isBadImage(p.mainImage));

  for (const p of bad) {
    await prisma.storeProduct.update({
      where: { id: p.id },
      data: { mainImage: null, imageUrl: null },
    });
  }

  const nullCount = await prisma.storeProduct.count({ where: { mainImage: null } });
  const total = await prisma.storeProduct.count();

  console.log(`[cleanup-placeholder-images] 已清除 ${bad.length} 个占位图`);
  console.log(`  main_image 为 null 的产品: ${nullCount}/${total}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
