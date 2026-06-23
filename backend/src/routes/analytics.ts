import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import {
  getOrderDailyAnalytics,
  type AnalyticsSite,
  type CurrencyMode,
  type OrderStatusMode,
} from '../services/orderDailyAnalytics';

const router = Router();
router.use(authenticate);

const SITES = ['RO', 'BG', 'HU', 'ALL'] as const;
const STATUS_MODES = ['valid', 'all', 'completed_only'] as const;
const CURRENCY_MODES = ['original', 'grouped_by_currency', 'converted'] as const;
const BASE_CURRENCIES = ['CNY', 'EUR', 'RON', 'HUF'] as const;

function firstQueryValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value).trim();
}

function parseOptionalShopId(req: Request): number | undefined {
  const raw = firstQueryValue(req.query.shopId);
  if (!raw) return undefined;
  const shopId = Number(raw);
  if (!Number.isInteger(shopId) || shopId <= 0) {
    throw new Error('shopId 必须是正整数');
  }
  return shopId;
}

function parseOptionalShopIds(req: Request): number[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(req.query, 'shopIds')) return undefined;

  const raw = req.query.shopIds;
  const parts = Array.isArray(raw)
    ? raw.flatMap((item) => String(item).split(','))
    : String(raw ?? '').split(',');

  const normalized = parts.map((item) => item.trim());
  if (normalized.length === 0 || normalized.some((item) => item === '')) {
    throw new Error('shopIds 必须是逗号分隔的正整数数组');
  }

  const ids = normalized.map((item) => Number(item));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('shopIds 必须全部是正整数');
  }

  return [...new Set(ids)];
}

function parseEnum<T extends readonly string[]>(raw: string | undefined, values: T, fallback: T[number]): T[number] {
  if (!raw) return fallback;
  const normalized = raw.trim();
  if ((values as readonly string[]).includes(normalized)) return normalized as T[number];
  throw new Error(`参数无效：${normalized}`);
}

function parseSite(raw: string | undefined): AnalyticsSite {
  if (!raw) return 'ALL';
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'all' || value === '__all__' || value === '_all_') {
    return 'ALL';
  }
  const normalized = value.toUpperCase();
  if ((SITES as readonly string[]).includes(normalized)) return normalized as AnalyticsSite;
  throw new Error('site 无效，合法值：RO/BG/HU/ALL');
}

function parseBaseCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toUpperCase();
  if ((BASE_CURRENCIES as readonly string[]).includes(normalized)) return normalized;
  throw new Error('baseCurrency 无效，合法值：CNY/EUR/RON/HUF');
}

/**
 * GET /api/analytics/orders/daily
 * 按站点当地自然日返回整月订单日报基础数据。
 */
router.get('/orders/daily', async (req: Request, res: Response) => {
  try {
    const month = firstQueryValue(req.query.month);
    if (!month) {
      res.status(400).json({ code: 400, data: null, message: 'month 为必填参数，格式 YYYY-MM' });
      return;
    }

    const shopIds = parseOptionalShopIds(req);
    const data = await getOrderDailyAnalytics({
      shopIds,
      shopId: shopIds ? undefined : parseOptionalShopId(req),
      site: parseSite(firstQueryValue(req.query.site)),
      month,
      statusMode: parseEnum(firstQueryValue(req.query.statusMode), STATUS_MODES, 'valid') as OrderStatusMode,
      currencyMode: parseEnum(firstQueryValue(req.query.currencyMode), CURRENCY_MODES, 'original') as CurrencyMode,
      baseCurrency: parseBaseCurrency(firstQueryValue(req.query.baseCurrency)),
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    const message = err instanceof Error ? err.message : '订单日报统计失败';
    const status = /无效|必须|必填|合法值/.test(message) ? 400 : 500;
    console.error('[GET /api/analytics/orders/daily]', message);
    res.status(status).json({ code: status, data: null, message });
  }
});

export default router;
