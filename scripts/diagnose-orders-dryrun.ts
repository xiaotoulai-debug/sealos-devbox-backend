/**
 * 订单数据诊断脚本 — Dry Run（绝对零写入）
 *
 * 目的：直连 eMAG API，统计近 N 天的真实返回订单数量，
 *       按日期汇总并打印原始时间戳，帮助排查"API 返回 vs 本地入库"差异。
 *       全程不执行任何 upsert / update / insert，数据库 100% 只读。
 *
 * 执行方式：
 *   cd /home/devbox/project/backend
 *
 *   # 默认：全部活跃 eMAG 店铺，拉取近 7 天
 *   npx tsx scripts/diagnose-orders-dryrun.ts
 *
 *   # 只诊断特定店铺（A 店 shopId=5）
 *   npx tsx scripts/diagnose-orders-dryrun.ts --shopId=5
 *
 *   # 自定义天数（如 3 天）
 *   npx tsx scripts/diagnose-orders-dryrun.ts --days=3 --shopId=5
 *
 *   # 指定聚焦日期（默认 2026-04-02，格式 YYYY-MM-DD，罗马尼亚本地日期）
 *   npx tsx scripts/diagnose-orders-dryrun.ts --focusDate=2026-04-02 --shopId=5
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { getEmagCredentials } from '../src/services/emagClient';
import { readOrders, ALL_ORDER_STATUSES } from '../src/services/emagOrder';

const prisma   = new PrismaClient();
const RO_TZ    = 'Europe/Bucharest';
const STATUS_LABEL: Record<number, string> = {
  1: '新订单', 2: '处理中', 3: '已准备', 4: '已完成', 5: '已退货',
};

// ── 命令行参数解析 ────────────────────────────────────────────────────
function parseArgs(): { daysBack: number; shopIds: number[]; focusDate: string } {
  const args = process.argv.slice(2);
  let daysBack   = 7;
  let focusDate  = '2026-04-02';
  const shopIds: number[] = [];

  for (const arg of args) {
    const m1 = arg.match(/^--days=(\d+)$/);
    if (m1) { daysBack = Math.max(1, parseInt(m1[1], 10)); continue; }

    const m2 = arg.match(/^--shopId=(\d+)$/);
    if (m2) { shopIds.push(parseInt(m2[1], 10)); continue; }

    const m3 = arg.match(/^--focusDate=(\d{4}-\d{2}-\d{2})$/);
    if (m3) { focusDate = m3[1]; continue; }

    console.warn(`⚠️  未知参数 "${arg}"，已忽略`);
  }
  return { daysBack, shopIds, focusDate };
}

// ── 将 eMAG 原始时间字段转为罗马尼亚本地日期字符串（YYYY-MM-DD）────────
// eMAG date 字段已经是罗马尼亚本地时间字符串（无时区标识），直接取前 10 位
function extractRoDate(rawDate: string | null | undefined): string {
  if (!rawDate) return 'unknown';
  return String(rawDate).trim().slice(0, 10);
}

// ── 单店诊断核心 ──────────────────────────────────────────────────────
async function diagnoseShop(
  shopId: number,
  createdAfter: string,
  focusDate: string,
): Promise<void> {
  const creds = await getEmagCredentials(shopId);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` 店铺: shopId=${shopId}  region=${creds.region}`);
  console.log(` 过滤参数: createdAfter="${createdAfter}" (顶层扁平字段，文档 §5.4)`);
  console.log(` 聚焦日期: ${focusDate} (罗马尼亚本地日期)`);
  console.log(`${'═'.repeat(60)}`);

  // 全局汇总：按日期 → 按状态统计
  const dateMap = new Map<string, Map<number, number>>();  // date → (status → count)
  const focusOrders: Array<{ id: number; date: string; modified: string; status: number }> = [];
  let grandTotal = 0;

  // 按状态逐一分页拉取（与 backfill 脚本保持一致，createdAfter 过滤）
  for (const status of ALL_ORDER_STATUSES) {
    let page          = 1;
    let statusTotal   = 0;
    const statusLabel = STATUS_LABEL[status] ?? `status${status}`;

    while (true) {
      let res;
      try {
        res = await readOrders(creds, {
          status,
          createdAfter,
          currentPage:  page,
          itemsPerPage: 100,
        });
      } catch (err) {
        console.error(`  ❌ 网络异常 status=${status} page=${page}:`,
          err instanceof Error ? err.message : err);
        break;
      }

      if (res.isError) {
        console.error(`  ❌ API 错误 status=${status} page=${page}:`,
          res.messages?.join('; ') ?? 'isError=true');
        break;
      }

      const batch = Array.isArray(res.results) ? res.results : [];
      if (batch.length === 0 && page === 1) {
        // 此状态在窗口内无订单，静默跳过
        break;
      }

      for (const o of batch) {
        if (!o?.id) continue;
        grandTotal++;
        statusTotal++;

        // eMAG 原始时间字段：date（下单时间）和 modified_at（最后修改）
        const rawDate     = (o as any).date ?? null;
        const rawModified = (o as any).modified_at ?? (o as any).modification_date ?? null;
        const roDate      = extractRoDate(rawDate);

        // 按日期 + 状态计数
        if (!dateMap.has(roDate)) dateMap.set(roDate, new Map());
        const statusCount = dateMap.get(roDate)!;
        statusCount.set(status, (statusCount.get(status) ?? 0) + 1);

        // 聚焦日期：记录前 10 条的原始时间戳（避免刷屏）
        if (roDate === focusDate && focusOrders.length < 10) {
          focusOrders.push({
            id:       o.id,
            date:     rawDate ?? 'null',
            modified: rawModified ?? 'null',
            status,
          });
        }
      }

      if (batch.length < 100) break;  // 最后一页
      page++;
      if (page > 20) {
        console.warn(`  ⚠️  status=${status} 分页超 20 页熔断`);
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (statusTotal > 0) {
      console.log(`  [status=${status} ${statusLabel}] 共 ${statusTotal} 条`);
    }
  }

  // ── 按日期排序打印汇总表 ──────────────────────────────────────────
  console.log(`\n  ┌─── 按日期汇总（罗马尼亚本地日期，createdAfter 窗口）`);
  const sortedDates = [...dateMap.keys()].sort();
  for (const d of sortedDates) {
    const statusMap  = dateMap.get(d)!;
    const dayTotal   = [...statusMap.values()].reduce((a, b) => a + b, 0);
    const breakdown  = [...statusMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([s, cnt]) => `s${s}:${cnt}`)
      .join('  ');
    const marker = d === focusDate ? ' ◀── 聚焦日期' : '';
    console.log(`  │  ${d}  合计=${String(dayTotal).padStart(3)}  [${breakdown}]${marker}`);
  }
  console.log(`  └─── 窗口总计: ${grandTotal} 条`);

  // ── 聚焦日期原始时间戳（最多 10 条样本）────────────────────────────
  if (focusOrders.length > 0) {
    console.log(`\n  ★ 聚焦日期 ${focusDate} 的前 ${focusOrders.length} 条原始时间戳：`);
    console.log(`  ${'─'.repeat(56)}`);
    for (const o of focusOrders) {
      console.log(
        `  orderId=${String(o.id).padEnd(10)} status=${o.status}` +
        `  date="${o.date}"` +
        `  modified="${o.modified}"`,
      );
    }
    console.log(`  ${'─'.repeat(56)}`);
  } else {
    console.log(`\n  ⚠️  聚焦日期 ${focusDate} 在 eMAG API 的 created.from 窗口内 【没有命中任何订单】！`);
    console.log(`       这意味着 eMAG 未将这些订单归类到 created.from="${createdAfter}" 之后。`);
    console.log(`       请检查实际订单的 created 时间是否真的落在窗口内，或确认时区换算是否正确。`);
  }

  // ── 与本地数据库比对 ──────────────────────────────────────────────
  // 查 DB 中该店铺 + 聚焦日期的本地入库数（UTC 换算：夏令 UTC+3，冬令 UTC+2）
  // 2026-04-02 属于夏令时(EEST)，对应 UTC: 2026-04-01 21:00 ～ 2026-04-02 20:59
  const dbCount = await prisma.platformOrder.count({
    where: {
      shopId,
      orderTime: {
        gte: new Date('2026-04-01T21:00:00Z'),
        lt:  new Date('2026-04-02T21:00:00Z'),
      },
    },
  });
  const apiFocusTotal = focusOrders.length > 0
    ? [...(dateMap.get(focusDate)?.values() ?? [])].reduce((a, b) => a + b, 0)
    : 0;

  console.log(`\n  ┌─── 聚焦日期差异核对`);
  console.log(`  │  eMAG API 返回 ${focusDate}: ${apiFocusTotal} 条`);
  console.log(`  │  本地 DB 已入库 ${focusDate}: ${dbCount} 条`);
  if (apiFocusTotal === 0 && dbCount > 0) {
    console.log(`  │  🔴 API 侧零返回 但 DB 有数据 → 订单 created 时间可能早于当前窗口`);
    console.log(`  │     建议：改用 modifiedAfter 过滤 OR 扩大 --days 窗口重跑`);
  } else if (apiFocusTotal > dbCount) {
    console.log(`  │  🟡 API 侧多于 DB → 存在 ${apiFocusTotal - dbCount} 条漏入库订单`);
    console.log(`  │     建议：确认后执行 npm run ops:backfill-orders 写入`);
  } else if (apiFocusTotal === dbCount) {
    console.log(`  │  ✅ API 侧与 DB 完全一致，无漏单`);
  }
  console.log(`  └─────────────────────────────────────────────`);
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { daysBack, shopIds: filterShopIds, focusDate } = parseArgs();

  console.log('\n============================================================');
  console.log(' 订单数据诊断脚本（Dry Run — 零数据库写入）');
  console.log(`  回溯窗口  : 过去 ${daysBack} 天 (created.from)`);
  console.log(`  聚焦日期  : ${focusDate} (罗马尼亚本地日期)`);
  console.log(`  目标店铺  : ${filterShopIds.length > 0 ? filterShopIds.join(', ') : '全部活跃 eMAG 店铺'}`);
  console.log('  ⚠️  本脚本 100% 只读，不执行任何数据库写入');
  console.log('============================================================\n');

  const where: any = { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' };
  if (filterShopIds.length > 0) where.id = { in: filterShopIds };

  const shops = await prisma.shopAuthorization.findMany({
    where,
    select: { id: true, shopName: true, region: true },
  });

  if (shops.length === 0) {
    console.error('❌ 未找到符合条件的活跃 eMAG 店铺');
    process.exit(1);
  }

  console.log(`共 ${shops.length} 个店铺: ${shops.map((s) => `${s.shopName}(shopId=${s.id})`).join(', ')}`);

  // 计算 created.from：UTC 转罗马尼亚本地时间（date-fns-tz 精确处理 DST）
  const startUtc    = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const createdAfter = formatInTimeZone(startUtc, RO_TZ, 'yyyy-MM-dd HH:mm:ss');
  console.log(`\ncreated.from (罗马尼亚时区) = "${createdAfter}"`);

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    console.log(`\n处理 [${i + 1}/${shops.length}]: ${shop.shopName} (shopId=${shop.id})`);
    try {
      await diagnoseShop(shop.id, createdAfter, focusDate);
    } catch (err) {
      console.error(`❌ shop=${shop.id} 诊断失败:`, err instanceof Error ? err.message : err);
    }
    // 店铺间延迟，避免冲击 eMAG
    if (i < shops.length - 1) await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('\n============================================================');
  console.log(' 诊断完成 — 本次运行 0 条数据库写入');
  console.log('============================================================\n');
}

main()
  .catch((e) => {
    console.error('❌ 诊断脚本异常:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
