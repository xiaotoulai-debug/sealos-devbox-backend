/**
 * 自动化同步定时任务 — 三级巡逻机制
 * 【订单哨兵】每 10 分钟 — 同步 eMAG 最近 30 分钟内有变动的订单
 * 【产品雷达】每 2 小时 — 检查新 SKU，补全 URL、图片、价格
 * 【库存同步】每 1 小时 — 本地库存推送到 eMAG 平台
 */
import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { tryAcquireSyncLock, releaseSyncLock } from '../lib/syncStatus';
import { syncAllPlatformOrders } from './platformOrderSync';
import { syncStoreProducts, backfillProductUrls, backfillProductImages } from './storeProductSync';
import { syncInventoryToPlatform } from './inventorySync';
import { getEmagCredentials } from './emagClient';
import { shouldDelayNextSync, setDelayMultiplier, getDelayMultiplier } from './emagRateLimit';

export type SyncType = 'order_sentinel' | 'product_radar' | 'inventory_sync';

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
let productRadarRunning = false;
let inventorySyncRunning = false;

/** 【订单哨兵】每 10 分钟，同步最近 30 分钟内有变动的订单 */
function runOrderSentinel() {
  if (orderSentinelRunning) {
    console.log('[订单哨兵] 跳过（上次未完成）');
    return;
  }
  if (shouldDelayNextSync()) {
    console.log('[订单哨兵] 跳过（Rate Limit 剩余 < 20%，推迟下次同步）');
    return;
  }
  if (!tryAcquireSyncLock()) {
    console.log('[订单哨兵] 跳过（同步锁被占用，可能正在手动同步）');
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
      releaseSyncLock();
      orderSentinelRunning = false;
    });
}

/** 【产品雷达】每 2 小时，同步产品并补全 URL、图片、价格 */
function runProductRadar() {
  if (productRadarRunning) {
    console.log('[产品雷达] 跳过（上次未完成）');
    return;
  }
  if (shouldDelayNextSync()) {
    console.log('[产品雷达] 跳过（Rate Limit 剩余 < 20%，推迟下次同步）');
    return;
  }
  if (!tryAcquireSyncLock()) {
    console.log('[产品雷达] 跳过（同步锁被占用，可能正在手动同步）');
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
      const durationMs = Date.now() - start;
      logSync('product_radar', totalUpdated, durationMs, 'success', JSON.stringify({ urls: urlRes.updated, images: imgRes.updated }));
      console.log(`[产品雷达] 完成 更新=${totalUpdated} 耗时=${durationMs}ms`);
    } catch (e) {
      const durationMs = Date.now() - start;
      logSync('product_radar', totalUpdated, durationMs, 'failed', e instanceof Error ? e.message : String(e));
      console.error('[产品雷达] 失败:', e instanceof Error ? e.message : e);
    } finally {
      releaseSyncLock();
      productRadarRunning = false;
    }
  })();
}

/** 【库存同步】每 1 小时，本地库存推送到 eMAG */
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

export function startSyncCrons(): void {
  cron.schedule('*/10 * * * *', () => runOrderSentinel());   // 每 10 分钟
  cron.schedule('0 */2 * * *', () => runProductRadar());    // 每 2 小时（0 分）
  cron.schedule('5 * * * *', () => runInventorySync());     // 每 1 小时（5 分，错开订单哨兵）

  console.log('[Cron] 订单哨兵: 每 10 分钟（30min 窗口）');
  console.log('[Cron] 产品雷达: 每 2 小时');
  console.log('[Cron] 库存同步: 每 1 小时');
}
