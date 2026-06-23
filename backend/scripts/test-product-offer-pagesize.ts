/**
 * 诊断脚本：product_offer/read 载荷降级测试
 *
 * 目的：验证 shopId=5 RO 同步 ETIMEDOUT/ECONNRESET 是否由"大包体"引起。
 * 策略：依次以 itemsPerPage = 100(现状) / 20 / 10 / 5 发请求，观察成功率与耗时。
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../src/lib/prisma';
import { getEmagCredentials } from '../src/services/emagClient';
import { readProductOffers } from '../src/services/emagProduct';

const SHOP_ID = 5;

/** 测试每种分页大小，只请求第 1 页 */
async function testPageSize(pageSizes: number[]) {
  const creds = await getEmagCredentials(SHOP_ID);
  console.log(`\n[诊断] 凭证: ${creds.username} @ ${creds.baseUrl}`);
  console.log(`[诊断] 当前生产 PAGE_SIZE = 100，订单同步 ITEMS_PER_PAGE = 100\n`);

  console.log('============================================================');
  console.log('  订单 vs 产品 底层配置对比');
  console.log('============================================================');
  console.log('  相同点:');
  console.log('    - 共用同一个 emagApiCall() 函数');
  console.log('    - 共用同一个 httpsAgent（代理）实例');
  console.log('    - 共用同一个 DEFAULT_TIMEOUT_MS = 60000ms');
  console.log('    - 共用同一套指数退避重试逻辑 (MAX_NET_RETRIES=3)');
  console.log('  关键差异:');
  console.log('    - 订单 (order/read)      → 窗口查询，每次只拉近期增量，单页数据量<小>');
  console.log('    - 产品 (product_offer/read)→ 全量拉取，单页 100 条，每条含大量字段（图片/doc_errors/characteristics...）');
  console.log('    - 响应体大小: 产品 >> 订单（约 10-50x），更容易触发代理中继的 TCP 超时');
  console.log('============================================================\n');

  const results: Array<{ pageSize: number; success: boolean; count: number; elapsedMs: number; error?: string }> = [];

  for (const pageSize of pageSizes) {
    const start = Date.now();
    console.log(`► 测试 itemsPerPage=${pageSize} ...`);
    try {
      const res = await readProductOffers(creds, {
        currentPage: 1,
        itemsPerPage: pageSize,
      });
      const elapsed = Date.now() - start;

      if (res.isError) {
        const msg = res.messages?.join('; ') ?? JSON.stringify(res.errors ?? '').slice(0, 200);
        console.log(`  ❌ API 业务错误 (${elapsed}ms): ${msg}`);
        results.push({ pageSize, success: false, count: 0, elapsedMs: elapsed, error: msg });
      } else {
        const raw = res.results as any;
        const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
        const firstPnk = batch[0]?.part_number_key ?? batch[0]?.pnk ?? '(无)';
        console.log(`  ✅ 成功 (${elapsed}ms) → 返回 ${batch.length} 条, 首条 PNK=${firstPnk}`);
        results.push({ pageSize, success: true, count: batch.length, elapsedMs: elapsed });
      }
    } catch (err: any) {
      const elapsed = Date.now() - start;
      const msg = err?.message ?? String(err);
      console.log(`  ❌ 网络异常 (${elapsed}ms): ${msg}`);
      results.push({ pageSize, success: false, count: 0, elapsedMs: elapsed, error: msg });
    }

    // 请求间隔 2s，避免触发 Rate Limit
    if (pageSize !== pageSizes[pageSizes.length - 1]) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  console.log('\n============================================================');
  console.log('  测试结果汇总');
  console.log('============================================================');
  for (const r of results) {
    const status = r.success ? '✅' : '❌';
    console.log(`  ${status} itemsPerPage=${String(r.pageSize).padStart(3)}  耗时=${String(r.elapsedMs).padStart(6)}ms  条数=${r.count}  ${r.error ? '错误: '+r.error.slice(0,80) : ''}`);
  }

  const firstSuccess = results.find((r) => r.success);
  const allFail = results.every((r) => !r.success);

  console.log('\n============================================================');
  console.log('  结论');
  console.log('============================================================');
  if (allFail) {
    console.log('  ⛔ 所有分页大小均失败。');
    console.log('  可能原因: 代理对 .emag.ro 的当前出口存在路由故障 (非包体大小问题)。');
    console.log('  建议: 联系代理服务商确认 emag.ro 路由，或切换代理节点。');
  } else if (firstSuccess && firstSuccess.pageSize < 100) {
    console.log(`  ✅ 根因确认：包体大小是主因！`);
    console.log(`  itemsPerPage=${firstSuccess.pageSize} 可成功，而 100 超时。`);
    console.log(`  修复方案：将 storeProductSync.ts 中的 PAGE_SIZE 从 100 降低到 ${firstSuccess.pageSize}，`);
    console.log(`  并将页间 DELAY_MS 从 350ms 适当增加到 500-800ms，防止后续页连续大包压垮代理。`);
  } else if (firstSuccess && firstSuccess.pageSize === 100) {
    console.log('  ✅ itemsPerPage=100 也成功，说明网络此时通畅。');
    console.log('  推测原因：之前失败是代理抖动，非持续性问题。建议观察重试机制是否已能自愈。');
  }
}

testPageSize([100, 20, 10, 5])
  .catch(console.error)
  .finally(() => prisma.$disconnect());
