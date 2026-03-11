import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { getFirstEmagShopId } from '../services/emagClient';
import { getStatsFromLocalDB } from '../services/dashboardStats';

const router = Router();
router.use(authenticate);

async function resolveShopId(req: Request): Promise<number> {
  const id = Number(req.body?.shopId ?? req.query?.shopId);
  if (id && !isNaN(id)) return id;
  const first = await getFirstEmagShopId();
  if (first) return first;
  throw new Error('缺少 shopId 参数，且数据库中无已授权的 eMAG 店铺');
}

function getDefaultDateRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function handleStats(req: Request, res: Response): Promise<void> {
  const shopId = await resolveShopId(req);
  let startDate = (req.query.startDate ?? req.body?.startDate) as string | undefined;
  let endDate = (req.query.endDate ?? req.body?.endDate) as string | undefined;

  const rangeDays = Number(req.query.range ?? req.body?.range ?? 7);
  if (!startDate || !endDate) {
    const def = getDefaultDateRange(Math.min(30, Math.max(7, rangeDays)));
    startDate = startDate ?? def.startDate;
    endDate = endDate ?? def.endDate;
  }

  const stats = await getStatsFromLocalDB(shopId, startDate, endDate);

  const rangeLabel = rangeDays <= 7 ? 'Last 7 Days' : rangeDays <= 14 ? 'Last 14 Days' : 'Last 30 Days';
  console.log(`[Dashboard Stats] Total: ${stats.totalOrders}, GMV: ${stats.totalGmv}, Range: ${rangeLabel} (${startDate} ~ ${endDate})`);

  const gmv = Number(stats.totalGmv) || 0;

  const trend_data = stats.daily.map((d) => ({
    date: d.date.slice(5),
    order_count: Number(d.orders) || 0,
    sales_amount: Math.round((Number(d.gmv) || 0) * 100) / 100,
  }));

  console.log(`[Dashboard trend_data] length=${trend_data.length}:`, trend_data);

  const data = { ...stats, gmv, trend_data };

  res.json({
    code: 200,
    data,
    message: stats.results.length === 0 ? 'success（该时间范围内暂无订单）' : 'success',
  });
}

/**
 * GET /api/dashboard/stats?shopId=1&startDate=&endDate=&range=7
 * 数据源: 本地 platform_orders；无日期时默认近 7 天
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    await handleStats(req, res);
  } catch (err: any) {
    console.error('[GET /api/dashboard/stats]', err.message);
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

router.post('/stats', async (req: Request, res: Response) => {
  try {
    await handleStats(req, res);
  } catch (err: any) {
    console.error('[POST /api/dashboard/stats]', err.message);
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

export default router;
