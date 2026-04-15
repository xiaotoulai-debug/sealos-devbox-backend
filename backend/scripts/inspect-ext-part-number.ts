/**
 * 验证脚本：确认 product_offer/read 原始 JSON 中 ext_part_number 字段的存在性
 *
 * 目的：
 *   1. 取 PNK=DKWY832BM 的真实 raw JSON，确认 KFB001-Black 存储在哪个字段
 *   2. 扫描样本，统计 ext_part_number 的覆盖率（多少产品有 / 没有此字段）
 *   3. 为 emagProductNormalizer.ts 的修复方案提供数据依据
 *
 * 执行前提：ECS 代理 (8.146.239.140:3128) 必须可用
 * 执行方式：npx tsx scripts/inspect-ext-part-number.ts
 */

import { readProductOffers } from '../src/services/emagProduct';
import { getEmagCredentials } from '../src/services/emagClient';

const SHOP_ID = 5;
const TIMEOUT = 120_000;

async function main() {
  console.log(`=== ext_part_number 字段验证 (shopId=${SHOP_ID}) ===\n`);

  const creds = await getEmagCredentials(SHOP_ID);
  console.log(`凭证: ${creds.username} @ ${creds.baseUrl}\n`);

  // ── 第一步：精准抓取 DKWY832BM ─────────────────────────────────────────────
  console.log('► 步骤1：精准抓取 PNK=DKWY832BM 的原始 JSON...');
  const res1 = await readProductOffers(
    creds,
    { currentPage: 1, itemsPerPage: 100 },
    { timeout: TIMEOUT },
  );

  if (res1.isError) {
    console.error('API 错误:', res1.messages);
    return;
  }

  const allItems: any[] = Array.isArray(res1.results)
    ? res1.results
    : (res1.results as any)?.items ?? [];

  // 找 DKWY832BM
  const target = allItems.find(
    (o: any) =>
      o?.part_number_key === 'DKWY832BM' ||
      o?.pnk === 'DKWY832BM' ||
      o?.part_number === 'DKWY832BM',
  );

  if (target) {
    console.log('\n✅ 找到目标产品！相关字段：');
    const keysOfInterest = [
      'id', 'part_number_key', 'pnk',
      'part_number', 'ext_part_number', 'vendor_part_number',
      'seller_sku', 'vendor_sku', 'offer_id', 'external_id',
      'name', 'ean',
    ];
    keysOfInterest.forEach((k) => {
      if (target[k] !== undefined) {
        console.log(`  ${k.padEnd(25)} = ${JSON.stringify(target[k])}`);
      }
    });
    console.log('\n所有顶层字段键名：');
    console.log(' ', Object.keys(target).join(', '));
  } else {
    console.log('⚠️  第一页未找到 DKWY832BM，需扩大页数搜索');
  }

  // ── 第二步：统计 ext_part_number 覆盖率（前100条）────────────────────────
  console.log('\n► 步骤2：统计前100条产品中 ext_part_number 的覆盖率...');
  let hasExt = 0, noExt = 0;
  const extSamples: Array<{ pnk: string; part_number: string; ext_part_number: string }> = [];
  const missSamples: Array<{ pnk: string; part_number: string }> = [];

  for (const o of allItems.slice(0, 100)) {
    const pnk = String(o?.part_number_key ?? o?.pnk ?? '');
    const pn  = String(o?.part_number ?? '');
    const ext = o?.ext_part_number;
    if (ext != null && String(ext).trim()) {
      hasExt++;
      if (extSamples.length < 5) {
        extSamples.push({ pnk, part_number: pn, ext_part_number: String(ext) });
      }
    } else {
      noExt++;
      if (missSamples.length < 3) {
        missSamples.push({ pnk, part_number: pn });
      }
    }
  }

  console.log(`  有 ext_part_number: ${hasExt} 条`);
  console.log(`  无 ext_part_number: ${noExt} 条`);
  console.log(`  覆盖率: ${((hasExt / (hasExt + noExt)) * 100).toFixed(1)}%`);

  if (extSamples.length > 0) {
    console.log('\n有 ext_part_number 的样本：');
    extSamples.forEach((s) =>
      console.log(`  pnk=${s.pnk}  part_number=${s.part_number}  ext_part_number=${s.ext_part_number}`)
    );
  }
  if (missSamples.length > 0) {
    console.log('\n无 ext_part_number 的样本（回退候选）：');
    missSamples.forEach((s) =>
      console.log(`  pnk=${s.pnk}  part_number=${s.part_number}`)
    );
  }

  console.log('\n=== 验证完成 ===');
}

main().catch(console.error);
