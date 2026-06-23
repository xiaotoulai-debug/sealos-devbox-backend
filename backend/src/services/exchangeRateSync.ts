/**
 * 汇率同步引擎 — 每日拉取 CNY 对 RON/EUR/HUF 的汇率并 upsert 到 exchange_rates 表。
 *
 * API 源：open.er-api.com（免费、无 key、每日更新、150+ 币种）
 * 安全机制：10s 超时 + try/catch，失败仅 warn 不阻塞主进程，旧汇率保留可用。
 */

import axios from 'axios';
import { prisma } from '../lib/prisma';

const API_TIMEOUT = 10_000;
const SOURCE_CURRENCY = 'CNY';
const TARGET_CURRENCIES = ['RON', 'EUR', 'HUF'];

export async function syncExchangeRates(): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;

  console.log('[ExchangeRate] 开始拉取汇率...');

  let rates: Record<string, number>;
  try {
    const resp = await axios.get(`https://open.er-api.com/v6/latest/${SOURCE_CURRENCY}`, {
      timeout: API_TIMEOUT,
    });
    rates = resp.data?.rates;
    if (!rates || typeof rates !== 'object') {
      throw new Error(`API 响应格式异常: ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
  } catch (err: any) {
    const msg = `汇率 API 请求失败（旧汇率保留）: ${err.message ?? err}`;
    console.warn(`[ExchangeRate] ⚠️ ${msg}`);
    return { updated: 0, errors: [msg] };
  }

  for (const target of TARGET_CURRENCIES) {
    const fwdRate = rates[target];
    if (fwdRate == null || fwdRate <= 0) {
      errors.push(`${target} 汇率缺失或无效: ${fwdRate}`);
      continue;
    }

    try {
      // 正向：1 CNY = X target（成本→当地货币）
      await prisma.exchangeRate.upsert({
        where:  { source_target: { source: SOURCE_CURRENCY, target } },
        create: { source: SOURCE_CURRENCY, target, rate: fwdRate },
        update: { rate: fwdRate, fetchedAt: new Date() },
      });

      // 反向：1 target = 1/X CNY（利润当地→CNY 换算）
      const invRate = 1 / fwdRate;
      await prisma.exchangeRate.upsert({
        where:  { source_target: { source: target, target: SOURCE_CURRENCY } },
        create: { source: target, target: SOURCE_CURRENCY, rate: invRate },
        update: { rate: invRate, fetchedAt: new Date() },
      });

      updated += 2;
      console.log(`[ExchangeRate] ${SOURCE_CURRENCY}→${target} = ${fwdRate.toFixed(6)}, 反向 = ${invRate.toFixed(8)}`);
    } catch (dbErr: any) {
      errors.push(`${target} 写入失败: ${dbErr.message ?? dbErr}`);
    }
  }

  console.log(`[ExchangeRate] 完成：${updated} 条已更新${errors.length > 0 ? `，${errors.length} 条异常` : ''}`);
  return { updated, errors };
}

/**
 * 从 DB 加载汇率映射 Map，key 格式 "SOURCE→TARGET"，value 为 number。
 * 供 profitCalculator 批量使用，避免逐条查库。
 */
export async function loadExchangeRateMap(): Promise<Map<string, number>> {
  const rows = await prisma.exchangeRate.findMany();
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.source}→${r.target}`, Number(r.rate));
  }
  return map;
}
