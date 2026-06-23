/**
 * 检查 eMAG API 中哪些产品有 images，结构如何
 */
import 'dotenv/config';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';

async function main() {
  const creds = await getEmagCredentials(1);
  const res = await readProductOffers(creds, { currentPage: 1, itemsPerPage: 20 });
  if (res.isError) {
    console.error('API 错误:', res.messages);
    process.exit(1);
  }
  const raw = res.results as any;
  const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
  console.log(`检查 ${items.length} 个产品的 images/main_url 字段:\n`);
  let withImages = 0;
  for (let i = 0; i < items.length; i++) {
    const o = items[i];
    const pnk = o.part_number_key ?? o.pnk ?? o.part_number ?? '?';
    const imgs = o.images;
    if (Array.isArray(imgs) && imgs.length > 0) {
      withImages++;
      const urls = imgs.map((x: any) => x?.url ?? x?.image).filter(Boolean);
      console.log(`PNK=${pnk} images[${imgs.length}]:`, urls);
    }
  }
  const totalWithImg = items.filter((o: any) => Array.isArray(o.images) && o.images.length > 0).length;
  console.log(`有 images 的产品: ${totalWithImg}/${items.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
