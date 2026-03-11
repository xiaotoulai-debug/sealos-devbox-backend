/**
 * 平台订单同步状态位
 * 当 order/read 循环抓取完所有 Page 后，isSyncing 置 false
 */
let isSyncing = false;

export function getIsSyncing(): boolean {
  return isSyncing;
}

export function setIsSyncing(value: boolean): void {
  isSyncing = value;
}
