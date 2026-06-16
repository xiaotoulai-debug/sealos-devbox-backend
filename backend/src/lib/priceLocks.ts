type LockEntry = {
  expiresAt: number;
  timer: NodeJS.Timeout;
};

const DEFAULT_STORE_PRODUCT_LOCK_TTL_MS = 60_000;
const DEFAULT_SHOP_MAX_CONCURRENT = 2;

const storeProductLocks = new Map<number, LockEntry>();
const shopSlots = new Map<number, number>();

function clearStoreProductLock(storeProductId: number): void {
  const existing = storeProductLocks.get(storeProductId);
  if (existing) clearTimeout(existing.timer);
  storeProductLocks.delete(storeProductId);
}

/**
 * 单实例内存锁：同一 StoreProduct 默认 60 秒内禁止重复 execute。
 *
 * TODO: 当前锁只覆盖单 Node.js 进程；多实例部署时需要迁移到 Redis 分布式锁
 * 或 PostgreSQL advisory lock，避免跨实例并发改价。
 */
export function tryAcquireStoreProductPriceLock(storeProductId: number, ttlMs = DEFAULT_STORE_PRODUCT_LOCK_TTL_MS): boolean {
  const now = Date.now();
  const existing = storeProductLocks.get(storeProductId);
  if (existing && existing.expiresAt > now) return false;

  clearStoreProductLock(storeProductId);
  const timer = setTimeout(() => {
    storeProductLocks.delete(storeProductId);
  }, ttlMs);
  timer.unref?.();
  storeProductLocks.set(storeProductId, { expiresAt: now + ttlMs, timer });
  return true;
}

export function releaseStoreProductPriceLock(storeProductId: number): void {
  clearStoreProductLock(storeProductId);
}

/**
 * 单实例店铺并发槽：同一店铺最多允许少量改价请求并发。
 *
 * TODO: 当前计数只覆盖单 Node.js 进程；多实例部署时需要迁移到 Redis semaphore
 * 或 PostgreSQL advisory lock。
 */
export function tryAcquireShopPriceSlot(shopId: number, maxConcurrent = DEFAULT_SHOP_MAX_CONCURRENT): boolean {
  const current = shopSlots.get(shopId) ?? 0;
  if (current >= maxConcurrent) return false;
  shopSlots.set(shopId, current + 1);
  return true;
}

export function releaseShopPriceSlot(shopId: number): void {
  const current = shopSlots.get(shopId) ?? 0;
  if (current <= 1) {
    shopSlots.delete(shopId);
    return;
  }
  shopSlots.set(shopId, current - 1);
}
