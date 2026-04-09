/**
 * 预估毛利引擎 — 安全全量重算脚本（v2，分批防爆库）
 *
 * 直接调用 Service 层，绕过 HTTP 鉴权，适合在服务器终端首次点火或全量回填执行。
 * 分批策略：每家店铺独立调用 recalcProfitForShop，店铺间休眠 200ms，
 *           内部已按 chunk=50 批量写入（防连接池打满）。
 *
 * 执行方式：npm run ops:init-profit
 */

import { prisma } from '../src/lib/prisma';
import { syncExchangeRates } from '../src/services/exchangeRateSync';
import { recalcProfitForShop } from '../src/services/profitCalculator';

const SHOP_INTERVAL_MS = 200; // 店铺间休眠，保护连接池
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('============================================');
  console.log('  预估毛利引擎 — 安全全量重算 v2');
  console.log('============================================\n');

  // ── Step 1：拉取汇率 ──────────────────────────────────────────
  console.log('[1/2] 正在拉取最新汇率 (CNY → RON / EUR / HUF)...');
  const fxResult = await syncExchangeRates();

  if (fxResult.errors.length > 0) {
    console.warn(`  ⚠️  汇率拉取部分失败: ${fxResult.errors.join('; ')}`);
  }
  if (fxResult.updated === 0) {
    console.error('  ❌ 汇率未能更新（可能网络不通或 API 异常），将使用上次缓存汇率继续。');
  } else {
    console.log(`  ✅ 汇率拉取完毕，共更新 ${fxResult.updated} 条货币对。\n`);
  }

  // ── Step 2：分批全量重算 ──────────────────────────────────────
  console.log('[2/2] 正在分批重算预估毛利（chunk=50，店铺间休眠 200ms）...');
  console.log('      注：采购价或汇率缺失的产品自动跳过，不影响其余计算。\n');

  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true, shopName: true },
  });

  let totalUpdated = 0;
  let totalFailed  = 0;
  const shopReports: Array<{ shop: string; updated: number; status: 'ok' | 'error'; error?: string }> = [];

  const start = Date.now();
  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    try {
      const count = await recalcProfitForShop(shop.id);
      totalUpdated += count;
      shopReports.push({ shop: `${shop.shopName}(id=${shop.id})`, updated: count, status: 'ok' });
      console.log(`  ✅ [${i + 1}/${shops.length}] ${shop.shopName}(id=${shop.id}): ${count} 条已更新`);
    } catch (err: any) {
      totalFailed++;
      const msg = err?.message ?? String(err);
      shopReports.push({ shop: `${shop.shopName}(id=${shop.id})`, updated: 0, status: 'error', error: msg });
      console.error(`  ❌ [${i + 1}/${shops.length}] ${shop.shopName}(id=${shop.id}) 失败: ${msg}`);
    }
    // 店铺间保护性休眠
    if (i < shops.length - 1) await sleep(SHOP_INTERVAL_MS);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n============================================');
  console.log('  📊 全量重算结果汇总');
  console.log('============================================');
  console.log(`  店铺总数:   ${shops.length} 家`);
  console.log(`  更新产品:   ${totalUpdated} 条`);
  console.log(`  失败店铺:   ${totalFailed} 家`);
  console.log(`  总耗时:     ${elapsed}s`);
  if (totalFailed > 0) {
    console.log('\n  ⚠️  失败明细:');
    shopReports.filter((r) => r.status === 'error').forEach((r) => {
      console.log(`    - ${r.shop}: ${r.error}`);
    });
  }
  console.log('\n  🎉 引擎初始化完毕，刷新前端即可查看数据');
  console.log('============================================\n');
}

main()
  .catch((err) => {
    console.error('\n[init-profit-engine] ❌ 脚本执行失败:', err?.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
