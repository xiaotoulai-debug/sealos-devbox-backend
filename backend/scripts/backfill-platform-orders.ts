/**
 * 平台订单止血补单脚本 (Platform Order Backfill)
 *
 * 适用场景：
 *   eMAG 侧已产生订单，但本地数据库因同步窗口遗漏或服务中断导致未入库。
 *   本脚本以 created.from 为过滤条件（非 modified），确保"已创建但从未被修改"的订单
 *   也能被补回，彻底解决 modifiedAfter 窗口遗漏问题。
 *
 * 执行方式：
 *   cd /home/devbox/project/backend
 *
 *   # 默认补 7 天所有活跃 eMAG 店铺
 *   npx tsx scripts/backfill-platform-orders.ts
 *
 *   # 只补最近 3 天
 *   npx tsx scripts/backfill-platform-orders.ts --days=3
 *
 *   # 只补指定店铺（A 店 shopId=5，B 店 shopId=7）
 *   npx tsx scripts/backfill-platform-orders.ts --shopId=5 --shopId=7
 *
 *   # 组合参数：补 3 天，只补店铺 5
 *   npx tsx scripts/backfill-platform-orders.ts --days=3 --shopId=5
 *
 * 安全设计：
 *   - 串行处理每个店铺（非 Promise.all），防止 API 并发风暴
 *   - 底层 emagApiCall 已内置 TokenBucketThrottle(12 req/s) + MAX_CONCURRENT=5
 *   - 每页熔断上限 MAX_PAGES_PER_STATUS=20（7天内单状态 >2000 单属异常）
 *   - upsertOrder 使用 (shop_id, emag_order_id) 唯一索引幂等写入，重复执行安全
 *   - 单个状态拉取失败时跳过并记录错误，不中断其他状态/店铺
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { getEmagCredentials } from '../src/services/emagClient';
import { readOrders, mapOrderForDisplay, ALL_ORDER_STATUSES } from '../src/services/emagOrder';
import type { EmagOrder } from '../src/services/emagOrder';

const prisma  = new PrismaClient();
const RO_TZ   = 'Europe/Bucharest';

// ── 可调参数常量 ──────────────────────────────────────────────────────
const ITEMS_PER_PAGE      = 100;
const MAX_PAGES_PER_STATUS = 20;   // 熔断上限：7天内单状态 >2000 单属异常
const INTER_PAGE_DELAY_MS = 200;   // 分页间延迟（ms），配合 TokenBucketThrottle
const INTER_SHOP_DELAY_MS = 1000;  // 店铺间延迟（ms），防多店串行过快冲击 eMAG

// ── 命令行参数解析 ────────────────────────────────────────────────────
function parseArgs(): { daysBack: number; shopIds: number[] } {
  const args = process.argv.slice(2);
  let daysBack = 7;
  const shopIds: number[] = [];

  for (const arg of args) {
    const daysMatch = arg.match(/^--days=(\d+)$/);
    if (daysMatch) {
      daysBack = parseInt(daysMatch[1], 10);
      if (isNaN(daysBack) || daysBack <= 0) {
        console.error(`❌ --days 参数无效: "${arg}"，使用默认值 7`);
        daysBack = 7;
      }
      continue;
    }
    const shopMatch = arg.match(/^--shopId=(\d+)$/);
    if (shopMatch) {
      const id = parseInt(shopMatch[1], 10);
      if (!isNaN(id) && id > 0) shopIds.push(id);
      continue;
    }
    console.warn(`⚠️  未知参数 "${arg}"，已忽略`);
  }

  return { daysBack, shopIds };
}

// ── 核心 upsert（与 platformOrderSync.ts 中保持一致） ───────────────
async function upsertOrder(
  shopId: number,
  o: EmagOrder,
  region?: Parameters<typeof mapOrderForDisplay>[1],
): Promise<void> {
  const mapped    = mapOrderForDisplay(o, region);
  const orderTime = mapped.orderTime
    ? parseRomanianDateToUtc(mapped.orderTime)
    : new Date(0);

  await prisma.platformOrder.upsert({
    where:  { shopId_emagOrderId: { shopId, emagOrderId: BigInt(o.id) } },
    create: {
      shopId,
      emagOrderId:  BigInt(o.id),
      status:       mapped.status,
      statusText:   mapped.status_text,
      orderTime,
      orderType:    mapped.type ?? null,
      paymentMode:  mapped.payment_mode ?? null,
      total:        mapped.total,
      currency:     mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson:      JSON.stringify(o),
    },
    update: {
      status:       mapped.status,
      statusText:   mapped.status_text,
      orderTime,
      orderType:    mapped.type ?? null,
      paymentMode:  mapped.payment_mode ?? null,
      total:        mapped.total,
      currency:     mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson:      JSON.stringify(o),
      syncedAt:     new Date(),
    },
  });
}

/** 将 eMAG 返回的罗马尼亚本地时间字符串转为 UTC Date（与 platformOrderSync 一致） */
function parseRomanianDateToUtc(dateStr: string): Date {
  if (!dateStr) return new Date(0);
  const normalized = dateStr.trim().replace(' ', 'T');
  const year  = parseInt(normalized.slice(0, 4), 10);
  const month = parseInt(normalized.slice(5, 7), 10);
  const day   = parseInt(normalized.slice(8, 10), 10);
  const isEEST = isRomanianDST(year, month, day);
  const offset = isEEST ? '+03:00' : '+02:00';
  return new Date(`${normalized}${offset}`);
}

function isRomanianDST(year: number, month: number, day: number): boolean {
  if (month < 3 || month > 10) return false;
  if (month > 3 && month < 10) return true;
  if (month === 3) {
    const lastSunday = 31 - new Date(year, 2, 31).getDay();
    return day >= lastSunday;
  }
  const lastSunday = 31 - new Date(year, 9, 31).getDay();
  return day < lastSunday;
}

// ── 单店补单核心逻辑 ──────────────────────────────────────────────────
async function backfillShop(
  shopId: number,
  createdAfter: string,
): Promise<{ upserted: number; errors: string[] }> {
  const creds = await getEmagCredentials(shopId);
  let upserted = 0;
  const errors: string[] = [];

  console.log(
    `\n[补单] shop=${shopId}(${creds.region}) 开始 createdAfter="${createdAfter}"`,
  );

  // 每个状态独立分页，单个状态失败不中断整体
  for (const status of ALL_ORDER_STATUSES) {
    let page = 1;
    let statusUpserted = 0;

    while (true) {
      let res;
      try {
        res = await readOrders(creds, {
          status,
          createdAfter,          // ← 仅使用 created.from，补回"从未被 modified 命中"的订单
          currentPage:  page,
          itemsPerPage: ITEMS_PER_PAGE,
        });
      } catch (networkErr) {
        const msg = `网络异常 status=${status} page=${page}: ` +
          (networkErr instanceof Error ? networkErr.message : String(networkErr));
        console.warn(`  ⚠️  ${msg}，跳过本状态剩余页`);
        errors.push(msg);
        break;
      }

      if (res.isError) {
        const msg = `API 错误 status=${status} page=${page}: ` +
          (res.messages?.join('; ') ?? 'isError=true');
        console.warn(`  ⚠️  ${msg}，跳过本状态剩余页`);
        errors.push(msg);
        break;
      }

      const batch = Array.isArray(res.results) ? res.results : [];
      for (const o of batch) {
        if (!o?.id) continue;
        try {
          await upsertOrder(shopId, o, creds.region);
          upserted++;
          statusUpserted++;
        } catch (dbErr) {
          const msg = `DB upsert 失败 orderId=${o.id}: ` +
            (dbErr instanceof Error ? dbErr.message : String(dbErr));
          console.warn(`  ⚠️  ${msg}`);
          errors.push(msg);
        }
      }

      if (batch.length < ITEMS_PER_PAGE) break; // 最后一页
      page++;
      if (page > MAX_PAGES_PER_STATUS) {
        console.warn(`  ⚠️  status=${status} 已达熔断上限 ${MAX_PAGES_PER_STATUS} 页，停止该状态分页`);
        break;
      }
      await new Promise((r) => setTimeout(r, INTER_PAGE_DELAY_MS));
    }

    if (statusUpserted > 0) {
      console.log(`  status=${status} 入库 ${statusUpserted} 条`);
    }
  }

  console.log(
    `[补单] shop=${shopId}(${creds.region}) 完成：入库 ${upserted} 条` +
    (errors.length > 0 ? `，警告 ${errors.length} 条（见上方日志）` : ' ✅'),
  );
  return { upserted, errors };
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { daysBack, shopIds: filterShopIds } = parseArgs();

  console.log('============================================================');
  console.log(' 平台订单止血补单脚本');
  console.log(`  回溯窗口：过去 ${daysBack} 天`);
  console.log(`  目标店铺：${filterShopIds.length > 0 ? filterShopIds.join(', ') : '全部活跃 eMAG 店铺'}`);
  console.log('============================================================\n');

  // ── 查询目标店铺列表 ─────────────────────────────────────────────
  const where: any = { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' };
  if (filterShopIds.length > 0) where.id = { in: filterShopIds };

  const shops = await prisma.shopAuthorization.findMany({
    where,
    select: { id: true, shopName: true, region: true },
  });

  if (shops.length === 0) {
    console.error('❌ 未找到符合条件的活跃 eMAG 店铺，退出');
    process.exit(1);
  }

  console.log(`共 ${shops.length} 个店铺待补单：${shops.map((s) => `${s.shopName}(${s.region ?? 'RO'})`).join(', ')}\n`);

  // ── 计算 created.from（罗马尼亚本地时间，精确时区） ──────────────
  const startUtc    = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const createdAfter = formatInTimeZone(startUtc, RO_TZ, 'yyyy-MM-dd HH:mm:ss');
  console.log(`created.from（罗马尼亚时区）= "${createdAfter}"\n`);

  // ── 串行处理每个店铺（不用 Promise.all，防 API 并发冲击） ─────────
  let totalUpserted = 0;
  let totalErrors   = 0;

  for (let i = 0; i < shops.length; i++) {
    const shop = shops[i];
    try {
      const { upserted, errors } = await backfillShop(shop.id, createdAfter);
      totalUpserted += upserted;
      totalErrors   += errors.length;
    } catch (fatalErr) {
      console.error(
        `❌ shop=${shop.id}(${shop.shopName}) 发生致命错误（已隔离，继续下一个店铺）：`,
        fatalErr instanceof Error ? fatalErr.message : fatalErr,
      );
      totalErrors++;
    }

    // 店铺间间隔，防止串行过快冲击 eMAG（最后一个店铺不等待）
    if (i < shops.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_SHOP_DELAY_MS));
    }
  }

  // ── 汇总报告 ─────────────────────────────────────────────────────
  console.log('\n============================================================');
  console.log(' 补单完成');
  console.log(`  共处理店铺：${shops.length} 个`);
  console.log(`  总入库订单：${totalUpserted} 条`);
  console.log(`  总警告数量：${totalErrors} 条`);
  if (totalErrors === 0) {
    console.log('  状态：✅ 全量成功，无任何警告');
  } else {
    console.log('  状态：⚠️  部分警告，请查看上方日志排查');
  }
  console.log('============================================================\n');
}

main()
  .catch((e) => {
    console.error('❌ 补单脚本执行失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
