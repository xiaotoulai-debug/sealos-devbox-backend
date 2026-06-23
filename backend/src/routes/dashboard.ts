import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { getGlobalDashboardStats, getGlobalStatsV2 } from '../services/dashboardStats';

const router = Router();
router.use(authenticate);

/**
 * GET /api/dashboard/shops — 仪表盘店铺下拉框数据源
 * 返回所有 eMAG 活跃店铺，无 RBAC 过滤（当前架构无 UserShop 表），无 region 硬编码
 */
router.get('/shops', async (_req: Request, res: Response) => {
  try {
    const shops = await prisma.shopAuthorization.findMany({
      where: {
        platform: { equals: 'emag', mode: 'insensitive' },
        status: 'active',
      },
      orderBy: [{ shopName: 'asc' }, { region: 'asc' }],
      select: { id: true, shopName: true, platform: true, region: true, status: true },
    });
    const safe = shops.map((s) => ({
      id: s.id,
      shopName: s.shopName,
      platform: s.platform,
      region: s.platform.toLowerCase() === 'emag' && s.region == null ? 'RO' : s.region,
      status: s.status,
    }));
    console.log('=== DASHBOARD SHOPS ===', safe.map((s) => s.shopName + (s.region ?? '')));
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 200, data: safe, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/dashboard/shops]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取仪表盘店铺列表失败' });
  }
});

/**
 * 全局大盘统计（新版）
 * - 永远执行全量扫描，无视 shopId 参数
 * - 近30天单次查询，内存派生双块数据
 */
async function handleStats(_req: Request, res: Response): Promise<void> {
  const stats = await getGlobalDashboardStats();
  const total30 = stats.storeSummaries.reduce((s, r) => s + r.last30DaysOrders, 0);
  const total7  = stats.storeSummaries.reduce((s, r) => s + r.last7DaysOrders, 0);
  const yday    = stats.storeSummaries.reduce((s, r) => s + r.yesterdayOrders, 0);

  // 诊断日志：方便核查后端是否正常吐数据
  console.log(
    `[Dashboard/stats] today=${stats.today}` +
    ` | 近30天=${total30}单 | 近7天=${total7}单 | 昨日=${yday}单` +
    ` | 店铺数=${stats.storeSummaries.length}` +
    ` | 趋势条数=${stats.dailyTrends.length}`,
  );
  console.log('[Dashboard/stats] storeSummaries 字段名示例:', Object.keys(stats.storeSummaries[0] ?? {}));

  res.json({
    code:    200,
    data:    stats,
    message: total30 === 0 ? 'success（近30天暂无订单）' : 'success',
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

/**
 * GET /api/dashboard/global-stats?startDate=2026-03-25&endDate=2026-03-31
 *
 * 一站式全局大盘聚合接口（新版，取代所有零碎接口）
 *
 * 查库策略：Promise.all 并行 2 查
 *   Q1 shopAuthorization.findMany  — 店铺元数据（~10 行）
 *   Q2 $queryRaw GROUP BY          — DB 层直接聚合，无拉原始行
 *
 * 响应包含：
 *   globalSummary  — 全局总览（区间内总单量 + 昨日/7天/30天汇总）
 *   storeSummaries — 各店汇总表（camelCase + snake_case 双命名）
 *   dailyTrends    — 走势明细（含零值，前端多折线图直用）
 */
router.get('/global-stats', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string | undefined;
    const endDate   = req.query.endDate   as string | undefined;

    const data = await getGlobalStatsV2(startDate, endDate);

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      code:    200,
      data,
      message: data.globalSummary.month30 === 0
        ? 'success（近30天暂无订单）'
        : 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/dashboard/global-stats]', err.message, err.stack?.slice(0, 300));
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

export default router;
