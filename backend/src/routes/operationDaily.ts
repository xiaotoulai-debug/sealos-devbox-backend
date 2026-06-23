import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import {
  createOperationDailyLog,
  getMyOperationDailyReport,
  getMyTodayOperationLogs,
  getOperationDailyDashboard,
  getOperationDailyMonthlyOverview,
  canViewOperationDailyDetail,
  getOperationDailyReportForUser,
  getUserLogsForDate,
  submitOperationDailyReport,
  updateOperationDailyReport,
} from '../services/operationDailyService';

const router = Router();
router.use(authenticate);

function firstQueryValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value).trim();
}

function errorStatus(err: unknown): number {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 404) return 404;
  if (statusCode === 403) return 403;
  const message = err instanceof Error ? err.message : '';
  return /无效|必须|必填|只能|合法值|格式|不支持|已提交|修改机会|不允许|重复/.test(message) ? 400 : 500;
}

function sendError(res: Response, err: unknown, fallback = '服务器内部错误'): void {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(status).json({ code: status, data: null, message: status === 500 ? fallback : message });
}

router.post('/logs', async (req: Request, res: Response) => {
  try {
    const data = await createOperationDailyLog(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/operation-daily/logs]', err);
    sendError(res, err, '新增运营登记失败');
  }
});

router.get('/my-report', async (req: Request, res: Response) => {
  try {
    const data = await getMyOperationDailyReport(req.user!, firstQueryValue(req.query.date));
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/my-report]', err);
    sendError(res, err, '查询我的运营日报失败');
  }
});

router.post('/reports', async (req: Request, res: Response) => {
  try {
    const data = await submitOperationDailyReport(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/operation-daily/reports]', err);
    sendError(res, err, '提交运营日报失败');
  }
});

router.put('/reports/:reportId', async (req: Request, res: Response) => {
  try {
    const reportId = Number(req.params.reportId);
    const data = await updateOperationDailyReport(req.user!, reportId, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PUT /api/operation-daily/reports/:reportId]', err);
    sendError(res, err, '修改运营日报失败');
  }
});

router.get('/my-today', async (req: Request, res: Response) => {
  try {
    const data = await getMyTodayOperationLogs(req.user!);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/my-today]', err);
    sendError(res, err, '查询今日运营登记失败');
  }
});

router.get('/my-logs', async (req: Request, res: Response) => {
  try {
    const date = firstQueryValue(req.query.date);
    if (!date) {
      res.status(400).json({ code: 400, data: null, message: 'date 为必填参数，格式 YYYY-MM-DD' });
      return;
    }
    const data = await getUserLogsForDate(req.user!.userId, date);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/my-logs]', err);
    sendError(res, err, '查询运营登记失败');
  }
});

router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const data = await getOperationDailyDashboard({
      user: req.user!,
      date: firstQueryValue(req.query.date),
      range: firstQueryValue(req.query.range),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/dashboard]', err);
    sendError(res, err, '查询运营看板失败');
  }
});

router.get('/monthly-overview', async (req: Request, res: Response) => {
  try {
    const data = await getOperationDailyMonthlyOverview({
      user: req.user!,
      month: firstQueryValue(req.query.month),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/monthly-overview]', err);
    sendError(res, err, '查询运营月度总览失败');
  }
});

router.get('/users/:userId/logs', async (req: Request, res: Response) => {
  try {
    if (!canViewOperationDailyDetail(req.user)) {
      res.status(403).json({ code: 403, data: null, message: '无权限查看员工运营日报' });
      return;
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'userId 必须是正整数' });
      return;
    }

    const date = firstQueryValue(req.query.date);
    if (!date) {
      res.status(400).json({ code: 400, data: null, message: 'date 为必填参数，格式 YYYY-MM-DD' });
      return;
    }

    const data = await getUserLogsForDate(userId, date);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/users/:userId/logs]', err);
    sendError(res, err, '查询员工运营明细失败');
  }
});

router.get('/users/:userId/report', async (req: Request, res: Response) => {
  try {
    if (!canViewOperationDailyDetail(req.user)) {
      res.status(403).json({ code: 403, data: null, message: '无权限查看员工运营日报' });
      return;
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'userId 必须是正整数' });
      return;
    }

    const date = firstQueryValue(req.query.date);
    if (!date) {
      res.status(400).json({ code: 400, data: null, message: 'date 为必填参数，格式 YYYY-MM-DD' });
      return;
    }

    const data = await getOperationDailyReportForUser(userId, date);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/operation-daily/users/:userId/report]', err);
    sendError(res, err, '查询员工运营日报失败');
  }
});

export default router;
