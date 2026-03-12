/**
 * eMAG API 自适应频率控制
 * - 解析 X-RateLimit-Remaining，剩余 < 20% 时推迟下次同步
 * - 供 syncCron 读取，实现防封自我保护
 */

let rateLimitRemaining: number | null = null;
let rateLimitLimit: number | null = null;
let delayMultiplier = 1;  // 1=正常，2=推迟 1 倍

const REMAINING_THRESHOLD = 0.2;  // 20%

export function updateRateLimitFromHeaders(headers: Record<string, any>): void {
  const remaining = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining'];
  const limit = headers['x-ratelimit-limit'] ?? headers['X-RateLimit-Limit'];
  if (remaining != null) {
    const n = parseInt(String(remaining), 10);
    if (!isNaN(n)) rateLimitRemaining = n;
  }
  if (limit != null) {
    const n = parseInt(String(limit), 10);
    if (!isNaN(n)) rateLimitLimit = n;
  }
  if (rateLimitRemaining != null && rateLimitLimit != null && rateLimitLimit > 0 && rateLimitRemaining / rateLimitLimit >= REMAINING_THRESHOLD) {
    setDelayMultiplier(1);
  }
}

/** 剩余请求数是否低于 20% */
export function shouldDelayNextSync(): boolean {
  if (rateLimitRemaining == null || rateLimitLimit == null || rateLimitLimit <= 0) return false;
  return rateLimitRemaining / rateLimitLimit < REMAINING_THRESHOLD;
}

/** 将下次同步推迟 1 倍（剩余 < 20% 时调用） */
export function setDelayMultiplier(mult: number): void {
  delayMultiplier = Math.max(1, Math.min(4, mult));
}

export function getDelayMultiplier(): number {
  return delayMultiplier;
}

export function getRateLimitState(): { remaining: number | null; limit: number | null } {
  return { remaining: rateLimitRemaining, limit: rateLimitLimit };
}
