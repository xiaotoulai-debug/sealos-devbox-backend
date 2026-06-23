/**
 * 订单"时光机"回溯脚本 — 捞回 ECS 代理宕机期间的漏单
 *
 * 背景：2026-04-15 ECS 代理节点连接池耗尽（ECONNREFUSED），导致订单哨兵
 *       的多个 10 分钟窗口全部失败，eMAG RO/BG 出现大量漏单。
 *
 * 策略：
 *   1. 时间窗口回溯至 RETRO_DAYS 天前（默认 3 天，覆盖 4-13 至今）
 *   2. 逐店铺、逐类型（FBE type=2 + FBM type=3）、逐状态（1-5）分别拉取
 *   3. 全部走 upsert，已存在订单静默覆盖（幂等）
 *   4. 代理 ECONNREFUSED 时自动跳过该店铺，不中断其他店铺
 *
 * 执行：npx tsx scripts/sync-orders-retro.ts
 * 可选：RETRO_DAYS=5 npx tsx scripts/sync-orders-retro.ts  （加大回溯窗口）
 */

import { prisma } from '../src/lib/prisma';
import { getEmagCredentials } from '../src/services/emagClient';
import { readOrders, ALL_ORDER_STATUSES } from '../src/services/emagOrder';
import type { EmagOrder } from '../src/services/emagOrder';
import { upsertOrderPublic } from '../src/services/platformOrderSync';
import { formatInTimeZone } from 'date-fns-tz';

const RETRO_DAYS     = Number(process.env.RETRO_DAYS ?? 3);
const ITEMS_PER_PAGE = 100;
const RO_TZ          = 'Europe/Bucharest';
const ORDER_TYPES    = [2, 3]; // 2=FBE（平台代发）, 3=FBM（卖家自发）

function toRomanianTimeStr(d: Date): string {
  return formatInTimeZone(d, RO_TZ, 'yyyy-MM-dd HH:mm:ss');
}

interface ShopRetroResult {
  shopId:       number;
  region:       string;
  typeResults:  Array<{ type: number; label: string; fetched: number; upserted: number; errors: string[] }>;
  totalFetched: number;
  totalUpserted: number;
  errors:       string[];
}

async function retroForShop(shopId: number, fromStr: string): Promise<ShopRetroResult> {
  const result: ShopRetroResult = {
    shopId, region: '', typeResults: [], totalFetched: 0, totalUpserted: 0, errors: [],
  };
  let creds;
  try {
    creds = await getEmagCredentials(shopId);
    result.region = creds.region;
  } catch (e) {
    result.errors.push(`凭证失败: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  for (const orderType of ORDER_TYPES) {
    const typeLabel = orderType === 2 ? 'FBE' : 'FBM';
    const typeResult = { type: orderType, label: typeLabel, fetched: 0, upserted: 0, errors: [] as string[] };

    console.log(`  [${creds.region}] type=${orderType}(${typeLabel}) 开始拉取 (createdAfter=${fromStr})...`);

    const seenIds = new Set<number>();

    for (const status of ALL_ORDER_STATUSES) {
      let page = 1;
      while (true) {
        let res;
        try {
          res = await readOrders(creds, {
            type:         orderType,
            status,
            createdAfter: fromStr,
            currentPage:  page,
            itemsPerPage: ITEMS_PER_PAGE,
          });
        } catch (networkErr: any) {
          const msg = networkErr?.message?.slice(0, 120) ?? String(networkErr);
          console.warn(`    ❌ 网络异常 type=${orderType} status=${status} page=${page}: ${msg}`);
          typeResult.errors.push(`type=${orderType} status=${status}: ${msg}`);
          break;
        }

        if (res.isError) {
          const msg = res.messages?.join('; ') ?? 'isError=true';
          console.warn(`    ⚠️  API 错误 type=${orderType} status=${status} page=${page}: ${msg}`);
          typeResult.errors.push(`type=${orderType} status=${status} API: ${msg}`);
          break;
        }

        const batch = (Array.isArray(res.results) ? res.results : []) as EmagOrder[];
        let pageUpserted = 0;
        for (const o of batch) {
          if (!o?.id || seenIds.has(o.id)) continue;
          seenIds.add(o.id);
          typeResult.fetched++;
          try {
            await upsertOrderPublic(shopId, o, creds.region);
            typeResult.upserted++;
            pageUpserted++;
          } catch (e) {
            typeResult.errors.push(`order#${o.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (pageUpserted > 0 || page === 1) {
          console.log(`    status=${status} page=${page}: ${batch.length} 条, 入库 ${pageUpserted} 条`);
        }

        if (batch.length < ITEMS_PER_PAGE) break;
        page++;
        if (page > 50) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ★ 同时用 modifiedAfter 再跑一遍，捞回"已存在但状态有变"的订单
    console.log(`  [${creds.region}] type=${orderType}(${typeLabel}) modified 轮...`);
    for (const status of ALL_ORDER_STATUSES) {
      let page = 1;
      while (true) {
        let res;
        try {
          res = await readOrders(creds, {
            type:          orderType,
            status,
            modifiedAfter: fromStr,
            currentPage:   page,
            itemsPerPage:  ITEMS_PER_PAGE,
          });
        } catch (networkErr: any) {
          const msg = networkErr?.message?.slice(0, 120) ?? String(networkErr);
          typeResult.errors.push(`modified type=${orderType} status=${status}: ${msg}`);
          break;
        }

        if (res.isError) break;

        const batch = (Array.isArray(res.results) ? res.results : []) as EmagOrder[];
        for (const o of batch) {
          if (!o?.id || seenIds.has(o.id)) continue;
          seenIds.add(o.id);
          typeResult.fetched++;
          try {
            await upsertOrderPublic(shopId, o, creds.region);
            typeResult.upserted++;
          } catch (e) {
            typeResult.errors.push(`order#${o.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        if (batch.length < ITEMS_PER_PAGE) break;
        page++;
        if (page > 50) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    result.totalFetched  += typeResult.fetched;
    result.totalUpserted += typeResult.upserted;
    result.errors.push(...typeResult.errors);
    result.typeResults.push(typeResult);

    console.log(
      `  [${creds.region}] type=${orderType}(${typeLabel}) 完成: ` +
      `拉取=${typeResult.fetched} 入库=${typeResult.upserted} 错误=${typeResult.errors.length}`,
    );
    await new Promise((r) => setTimeout(r, 500));
  }

  return result;
}

async function main() {
  const retroFrom = new Date();
  retroFrom.setDate(retroFrom.getDate() - RETRO_DAYS);
  const fromStr = toRomanianTimeStr(retroFrom);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`订单时光机回溯 — 窗口: 过去 ${RETRO_DAYS} 天`);
  console.log(`起始时间 (罗马尼亚时区): ${fromStr}`);
  console.log(`覆盖类型: FBE(type=2) + FBM(type=3)`);
  console.log(`${'='.repeat(60)}\n`);

  // 查订单前的数量基线（用于计算净增）
  const beforeCounts = await prisma.$queryRaw<Array<{ shop_id: number; cnt: number }>>`
    SELECT shop_id, COUNT(*)::int as cnt
    FROM platform_orders
    WHERE order_time >= ${retroFrom}
    GROUP BY shop_id ORDER BY shop_id
  `;
  const beforeMap = new Map(beforeCounts.map((r) => [r.shop_id, r.cnt]));

  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true, shopName: true, region: true },
  });

  console.log(`共 ${shops.length} 个活跃店铺，串行执行（避免代理并发过高）...\n`);

  const allResults: ShopRetroResult[] = [];
  for (const shop of shops) {
    console.log(`► shopId=${shop.id} (${shop.shopName ?? ''} / ${shop.region ?? 'RO'})`);
    const r = await retroForShop(shop.id, fromStr);
    allResults.push(r);
    console.log(
      `  小计: 拉取=${r.totalFetched} 入库=${r.totalUpserted} 错误=${r.errors.length}\n`,
    );
    await new Promise((r2) => setTimeout(r2, 1000));
  }

  // 查回溯后数量
  const afterCounts = await prisma.$queryRaw<Array<{ shop_id: number; cnt: number }>>`
    SELECT shop_id, COUNT(*)::int as cnt
    FROM platform_orders
    WHERE order_time >= ${retroFrom}
    GROUP BY shop_id ORDER BY shop_id
  `;
  const afterMap = new Map(afterCounts.map((r) => [r.shop_id, r.cnt]));

  // 汇总报告
  console.log(`\n${'='.repeat(60)}`);
  console.log('回溯完成 — 最终报告');
  console.log(`${'='.repeat(60)}`);

  let totalNetNew = 0;
  for (const r of allResults) {
    const before = beforeMap.get(r.shopId) ?? 0;
    const after  = afterMap.get(r.shopId) ?? 0;
    const netNew = after - before;
    totalNetNew += netNew;
    const status = r.errors.length === 0 ? '✅' : r.totalUpserted > 0 ? '⚠️ ' : '❌';
    console.log(
      `${status} shopId=${r.shopId}(${r.region}): ` +
      `拉取=${r.totalFetched} 入库=${r.totalUpserted} 净新增=${netNew} 错误=${r.errors.length}`,
    );
    for (const tr of r.typeResults) {
      console.log(`    type=${tr.type}(${tr.label}): fetched=${tr.fetched} upserted=${tr.upserted}`);
    }
    if (r.errors.length > 0) {
      r.errors.slice(0, 3).forEach((e) => console.log(`    └─ ${e}`));
    }
  }

  // 按日期统计回溯后的订单分布
  const distribution = await prisma.$queryRaw<Array<{ shop_id: number; day: string; cnt: number }>>`
    SELECT shop_id, DATE(order_time)::text as day, COUNT(*)::int as cnt
    FROM platform_orders
    WHERE order_time >= ${retroFrom}
    GROUP BY shop_id, day ORDER BY shop_id, day
  `;

  console.log(`\n--- 回溯后订单日期分布 ---`);
  distribution.forEach((r) =>
    console.log(`  shopId=${r.shop_id}  ${r.day}  ${r.cnt} 单`)
  );

  console.log(`\n总净新增订单: ${totalNetNew} 条`);
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
