/**
 * 平台同步锁 — 多锁隔离架构
 *
 * 订单同步（哨兵 + 手动触发 + 日级兜底）与产品同步（雷达 + 手动触发）各用独立锁，
 * 保证产品雷达耗时再长也绝不阻塞订单哨兵。
 *
 * - 每把锁超时 5 分钟视为死锁，自动强行解除
 * - 向后兼容：原 tryAcquireSyncLock / releaseSyncLock 默认操作 'order' 锁（手动同步按钮仍然可用）
 */

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

type LockName = 'order' | 'product';

interface LockState {
  locked: boolean;
  timestamp: number;
}

const locks: Record<LockName, LockState> = {
  order:   { locked: false, timestamp: 0 },
  product: { locked: false, timestamp: 0 },
};

function isLocked(name: LockName): boolean {
  const s = locks[name];
  if (!s.locked) return false;
  if (Date.now() - s.timestamp > LOCK_TIMEOUT_MS) {
    console.warn(`[Sync Lock:${name}] 检测到死锁（超过 ${LOCK_TIMEOUT_MS / 60000} 分钟），自动解除`);
    s.locked = false;
    return false;
  }
  return true;
}

// ── 通用锁操作 ─────────────────────────────────────────────────

export function tryAcquireLock(name: LockName): boolean {
  if (isLocked(name)) return false;
  locks[name] = { locked: true, timestamp: Date.now() };
  return true;
}

export function releaseLock(name: LockName): void {
  locks[name] = { locked: false, timestamp: 0 };
}

export function getLockStatus(name: LockName): boolean {
  return isLocked(name);
}

// ── 向后兼容别名（默认操作 order 锁，手动同步按钮、前端轮询不用改）────

export function getIsSyncing(): boolean {
  return isLocked('order');
}

export function tryAcquireSyncLock(): boolean {
  return tryAcquireLock('order');
}

export function releaseSyncLock(): void {
  releaseLock('order');
}

/** @deprecated 仅用于 /sync-status 轮询 */
export function setIsSyncing(value: boolean): void {
  locks.order = { locked: value, timestamp: value ? Date.now() : 0 };
}
