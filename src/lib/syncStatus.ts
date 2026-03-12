/**
 * 平台同步锁（订单 + 产品共用）
 * - tryAcquireSyncLock / releaseSyncLock：必须成对使用，且 release 必须在 finally 中执行
 * - 锁超时 5 分钟视为死锁，自动强行解除并允许本次同步
 */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

let isSyncing = false;
let lockTimestamp = 0;

export function getIsSyncing(): boolean {
  if (!isSyncing) return false;
  if (Date.now() - lockTimestamp > LOCK_TIMEOUT_MS) {
    console.warn(`[Sync Lock] 检测到死锁（超过 ${LOCK_TIMEOUT_MS / 60000} 分钟），自动解除`);
    isSyncing = false;
    return false;
  }
  return true;
}

/**
 * 尝试获取同步锁。若当前有锁且未超时，返回 false（409）；若锁超时则强制解除并返回 true。
 * 调用方必须在 finally 中调用 releaseSyncLock()，确保无论发生何种异常都能解锁。
 */
export function tryAcquireSyncLock(): boolean {
  if (isSyncing && Date.now() - lockTimestamp <= LOCK_TIMEOUT_MS) {
    return false;
  }
  if (isSyncing) {
    console.warn(`[Sync Lock] 死锁超时，强制解除并允许本次同步`);
  }
  isSyncing = true;
  lockTimestamp = Date.now();
  return true;
}

/**
 * 释放同步锁。必须在 try...finally 的 finally 块中调用，保证无论 try 内发生多严重的崩溃都会执行。
 */
export function releaseSyncLock(): void {
  isSyncing = false;
  lockTimestamp = 0;
}

/** @deprecated 仅用于 /sync-status 轮询，新逻辑请用 tryAcquireSyncLock/releaseSyncLock */
export function setIsSyncing(value: boolean): void {
  isSyncing = value;
  lockTimestamp = value ? Date.now() : 0;
}
