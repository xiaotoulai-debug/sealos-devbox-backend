/**
 * 自动化同步定时任务 — 四级巡逻机制（锁隔离）
 *
 * 【订单哨兵】每 10 分钟 — 同步 eMAG 最近 30 分钟内有变动的订单    (orderLock)
 * 【日级兜底】每天凌晨 2 点 — 强制拉取过去 48 小时全状态订单        (orderLock)
 * 【产品雷达】每 2 小时 — 检查新 SKU，补全 URL、图片、价格          (productLock)
 * 【库存同步】每 1 小时 — 本地库存推送到 eMAG 平台                  (无锁，自带防重入)
 *
 * 订单与产品使用独立锁，产品雷达再慢也绝不阻塞订单哨兵。
 */
import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { tryAcquireLock, releaseLock } from '../lib/syncStatus';
import { syncAllPlatformOrders } from './platformOrderSync';
import { syncStoreProducts, backfillProductUrls, backfillProductImages, backfillComprehensiveSales } from './storeProductSync';
import { syncInventoryToPlatform } from './inventorySync';
import { getEmagCredentials } from './emagClient';
import { shouldDelayNextSync, setDelayMultiplier, getDelayMultiplier } from './emagRateLimit';
import { syncPurchaseOrderFromAlibaba } from './alibabaService';
import { syncExchangeRates } from './exchangeRateSync';
import { recalcProfitForAllShops } from './profitCalculator';

export type SyncType = 'order_sentinel' | 'order_daily_catchup' | 'product_radar' | 'inventory_sync' | 'alibaba_purchase_sync';

async function logSync(
  syncType: SyncType,
  updatedCount: number,
  durationMs: number,
  result: 'success' | 'partial' | 'failed',
  detail?: string,
): Promise<void> {
  try {
    await prisma.syncLog.create({
      data: {
        syncType,
        updatedCount,
        durationMs,
        result,
        detail: detail ?? null,
      },
    });
  } catch (e) {
    console.error('[syncCron] 写入 sync_logs 失败:', e instanceof Error ? e.message : e);
  }
}

let orderSentinelRunning = false;
let orderDailyCatchupRunning = false;
let productRadarRunning = false;
let inventorySyncRunning = false;

// ═══════════════════════════════════════════════════════════════════
// 【订单哨兵】每 10 分钟，同步最近 30 分钟内有变动的订单
// 使用 orderLock — 与产品雷达完全隔离
// ═══════════════════════════════════════════════════════════════════
function runOrderSentinel() {
  if (orderSentinelRunning) {
    console.log('[订单哨兵] 跳过（上次未完成）');
    return;
  }
  if (shouldDelayNextSync()) {
    console.log('[订单哨兵] 跳过（Rate Limit 剩余 < 20%，推迟下次同步）');
    return;
  }
  if (!tryAcquireLock('order')) {
    console.log('[订单哨兵] 跳过（订单锁被占用，可能正在手动同步或日级兜底）');
    return;
  }
  orderSentinelRunning = true;
  const start = Date.now();
  syncAllPlatformOrders(true, 30)
    .then((results) => {
      const total = results.reduce((s, r) => s + r.totalUpserted, 0);
      const ids = results.flatMap((r) => r.orderIds);
      const hasErrors = results.some((r) => r.errors.length > 0);
      const durationMs = Date.now() - start;
      const result = hasErrors && total === 0 ? 'failed' : hasErrors ? 'partial' : 'success';
      logSync('order_sentinel', total, durationMs, result, JSON.stringify({ orderIds: ids, errors: results.flatMap((r) => r.errors) }));
      if (ids.length > 0) {
        console.log(`[订单哨兵] 完成 更新=${total} 订单ID=[${ids.join(', ')}] 耗时=${durationMs}ms`);
      }
    })
    .catch((e) => {
      const durationMs = Date.now() - start;
      logSync('order_sentinel', 0, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[订单哨兵] 失败:', e instanceof Error ? e.message : e);
    })
    .finally(() => {
      releaseLock('order');
      orderSentinelRunning = false;
    });
}

// ═══════════════════════════════════════════════════════════════════
// 【日级兜底】每天凌晨 2 点，强制拉取过去 48 小时全状态订单
// 作为哨兵的终极保险 — 即使哨兵白天某次被跳过，凌晨也能补回
// ═══════════════════════════════════════════════════════════════════
function runOrderDailyCatchup() {
  if (orderDailyCatchupRunning) {
    console.log('[日级兜底] 跳过（上次未完成）');
    return;
  }
  if (!tryAcquireLock('order')) {
    console.log('[日级兜底] 跳过（订单锁被占用）');
    return;
  }
  orderDailyCatchupRunning = true;
  const start = Date.now();
  const CATCHUP_HOURS = 48;
  console.log(`[日级兜底] 开始强制同步过去 ${CATCHUP_HOURS} 小时的全状态订单...`);

  syncAllPlatformOrders(true, CATCHUP_HOURS * 60) // windowMinutes = 48 * 60 = 2880
    .then((results) => {
      const total = results.reduce((s, r) => s + r.totalUpserted, 0);
      const ids = results.flatMap((r) => r.orderIds);
      const hasErrors = results.some((r) => r.errors.length > 0);
      const durationMs = Date.now() - start;
      const result = hasErrors && total === 0 ? 'failed' : hasErrors ? 'partial' : 'success';
      logSync('order_daily_catchup', total, durationMs, result, JSON.stringify({ orderIds: ids, errors: results.flatMap((r) => r.errors) }));
      console.log(`[日级兜底] 完成 更新=${total} 订单=${ids.length}条 耗时=${Math.round(durationMs / 1000)}s`);
    })
    .catch((e) => {
      const durationMs = Date.now() - start;
      logSync('order_daily_catchup', 0, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[日级兜底] 失败:', e instanceof Error ? e.message : e);
    })
    .finally(() => {
      releaseLock('order');
      orderDailyCatchupRunning = false;
    });
}

// ═══════════════════════════════════════════════════════════════════
// 【产品雷达】每 2 小时，同步产品并补全 URL、图片、价格
// 使用 productLock — 与订单哨兵完全隔离
// ═══════════════════════════════════════════════════════════════════
function runProductRadar() {
  if (productRadarRunning) {
    console.log('[产品雷达] 跳过（上次未完成）');
    return;
  }
  if (shouldDelayNextSync()) {
    console.log('[产品雷达] 跳过（Rate Limit 剩余 < 20%，推迟下次同步）');
    return;
  }
  if (!tryAcquireLock('product')) {
    console.log('[产品雷达] 跳过（产品锁被占用，可能正在手动同步产品）');
    return;
  }
  productRadarRunning = true;
  const start = Date.now();
  (async () => {
    let totalUpdated = 0;
    try {
      const lastProductSync = await prisma.syncLog.findFirst({
        where: { syncType: 'product_radar', result: 'success' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const modifiedAfter = lastProductSync
        ? new Date(lastProductSync.createdAt.getTime() - 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
        : undefined;

      const shops = await prisma.shopAuthorization.findMany({
        where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
        select: { id: true },
      });
      for (const shop of shops) {
        const creds = await getEmagCredentials(shop.id);
        const syncRes = await syncStoreProducts(creds, modifiedAfter);
        totalUpdated += syncRes.upserted;
      }
      const urlRes = await backfillProductUrls();
      totalUpdated += urlRes.updated;
      const imgRes = await backfillProductImages();
      totalUpdated += imgRes.updated;
      const salesRes = await backfillComprehensiveSales();
      totalUpdated += salesRes.updated;
      const durationMs = Date.now() - start;
      logSync('product_radar', totalUpdated, durationMs, 'success', JSON.stringify({ urls: urlRes.updated, images: imgRes.updated, comprehensiveSales: salesRes.updated }));
      console.log(`[产品雷达] 完成 更新=${totalUpdated} 综合日销已回填=${salesRes.updated} 耗时=${durationMs}ms`);
    } catch (e) {
      const durationMs = Date.now() - start;
      logSync('product_radar', totalUpdated, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[产品雷达] 失败:', e instanceof Error ? e.message : e);
    } finally {
      releaseLock('product');
      productRadarRunning = false;
    }
  })();
}

// ═══════════════════════════════════════════════════════════════════
// 【库存同步】每 1 小时，本地库存推送到 eMAG
// 无锁（仅自带防重入标记），与订单/产品互不影响
// ═══════════════════════════════════════════════════════════════════
function runInventorySync() {
  if (inventorySyncRunning) {
    console.log('[库存同步] 跳过（上次未完成）');
    return;
  }
  if (shouldDelayNextSync()) {
    console.log('[库存同步] 跳过（Rate Limit 剩余 < 20%，推迟下次同步）');
    return;
  }
  inventorySyncRunning = true;
  const start = Date.now();
  syncInventoryToPlatform()
    .then((results) => {
      const total = results.reduce((s, r) => s + r.updatedCount, 0);
      const hasErrors = results.some((r) => r.errors.length > 0);
      const durationMs = Date.now() - start;
      const result = hasErrors && total === 0 ? 'failed' : hasErrors ? 'partial' : 'success';
      logSync('inventory_sync', total, durationMs, result, JSON.stringify(results.map((r) => ({ shopId: r.shopId, updated: r.updatedCount, errors: r.errors }))));
      console.log(`[库存同步] 完成 更新=${total} 耗时=${durationMs}ms`);
    })
    .catch((e) => {
      const durationMs = Date.now() - start;
      logSync('inventory_sync', 0, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[库存同步] 失败:', e instanceof Error ? e.message : e);
    })
    .finally(() => {
      inventorySyncRunning = false;
    });
}

// ═══════════════════════════════════════════════════════════════════
// 【1688 采购同步】每 6 小时，自动同步活跃采购单状态与物流
// 活跃状态：PLACED（已下单）/ IN_TRANSIT（运输中）
// 排除 PENDING（未提交）/ RECEIVED（已入库）/ CANCELLED
// 无锁，自带防重入标记；串行 for...of 防止 1688 限流
// ═══════════════════════════════════════════════════════════════════
let alibabaPurchaseSyncRunning = false;

function runAlibabaPurchaseSync() {
  if (alibabaPurchaseSyncRunning) {
    console.log('[1688采购同步] 跳过（上次未完成）');
    return;
  }
  alibabaPurchaseSyncRunning = true;
  const start = Date.now();

  (async () => {
    let successCount = 0;
    let failCount    = 0;

    try {
      // 精准筛选：有 1688 订单号 + 仍处于活跃流转状态
      const orders = await prisma.purchaseOrder.findMany({
        where: {
          alibabaOrderId: { not: null },
          status: { in: ['PLACED', 'IN_TRANSIT'] },
        },
        select: { id: true, orderNo: true, alibabaOrderId: true },
      });

      console.log(`[1688采购同步] 开始：共 ${orders.length} 个活跃采购单待同步`);
      if (orders.length === 0) {
        await logSync('alibaba_purchase_sync', 0, Date.now() - start, 'success', '无活跃采购单，跳过');
        return;
      }

      // 串行执行：每单独立 try/catch，单条失败不中断全局任务
      for (const order of orders) {
        try {
          const result = await syncPurchaseOrderFromAlibaba(
            order.id,
            order.alibabaOrderId!,
            order.orderNo,
          );
          if (result.success) {
            successCount++;
            console.log(
              `[1688采购同步] ✅ ${order.orderNo} ` +
              `aliStatus=${result.alibabaStatus} | ` +
              `company=${result.logisticsCompany ?? 'none'} | ` +
              `trackingNo=${result.trackingNumber ?? 'none'}`,
            );
          } else {
            failCount++;
            console.warn(`[1688采购同步] ⚠️  ${order.orderNo} 失败: ${result.error}`);
          }
        } catch (e) {
          failCount++;
          console.error(`[1688采购同步] ❌ ${order.orderNo} 异常:`, e instanceof Error ? e.message : e);
        }
      }

      const durationMs = Date.now() - start;
      const syncResult = failCount === 0 ? 'success' : successCount === 0 ? 'failed' : 'partial';
      await logSync(
        'alibaba_purchase_sync',
        successCount,
        durationMs,
        syncResult,
        JSON.stringify({ total: orders.length, success: successCount, fail: failCount }),
      );
      console.log(`[1688采购同步] 完成：成功 ${successCount} 个，失败 ${failCount} 个，耗时 ${durationMs}ms`);

    } catch (e) {
      const durationMs = Date.now() - start;
      await logSync('alibaba_purchase_sync', successCount, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[1688采购同步] 任务级异常:', e instanceof Error ? e.message : e);
    } finally {
      alibabaPurchaseSyncRunning = false;
    }
  })();
}

export function startSyncCrons(): void {
  cron.schedule('*/10 * * * *', () => runOrderSentinel());          // 每 10 分钟（订单锁）
  cron.schedule('0 2 * * *',   () => runOrderDailyCatchup());       // 每天凌晨 2 点（订单锁，48h 兜底）
  cron.schedule('0 */2 * * *', () => runProductRadar());            // 每 2 小时（产品锁）
  cron.schedule('5 * * * *',   () => runInventorySync());           // 每 1 小时（无锁）
  cron.schedule('0 */6 * * *', () => runAlibabaPurchaseSync());     // 每 6 小时（1688 采购同步）

  // 汇率同步 + 利润引擎级联：每天 08:00（北京时间 = UTC+8 = UTC 00:00）
  cron.schedule('0 0 * * *', async () => {
    try {
      console.log('[Cron] 汇率同步开始...');
      const fxResult = await syncExchangeRates();
      if (fxResult.updated > 0) {
        console.log('[Cron] 汇率已更新，级联触发全量利润重算...');
        await recalcProfitForAllShops();
      } else {
        console.log('[Cron] 汇率无变化或拉取失败，跳过利润重算');
      }
    } catch (err: any) {
      console.error('[Cron] 汇率/利润定时任务异常:', err.message ?? err);
    }
  });

  console.log('[Cron] 订单哨兵: 每 10 分钟（30min 窗口，订单锁）');
  console.log('[Cron] 日级兜底: 每天凌晨 2:00（48h 窗口，订单锁）');
  console.log('[Cron] 产品雷达: 每 2 小时（产品锁，与订单隔离）');
  console.log('[Cron] 库存同步: 每 1 小时');
  console.log('[Cron] 1688采购同步: 每 6 小时（PLACED/IN_TRANSIT 活跃单，串行防限流）');
  console.log('[Cron] 汇率+利润: 每天 UTC 00:00（北京 08:00，级联重算）');
}
