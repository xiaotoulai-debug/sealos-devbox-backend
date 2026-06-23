import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import {
  batchUpdateWorkdayCalendar,
  getWorkdayCalendarYear,
  upsertWorkdayCalendarDay,
} from '../services/workdayCalendarService';

const router = Router();
router.use(authenticate);

function firstQueryValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  return String(Array.isArray(value) ? value[0] : value).trim();
}

function errorStatus(err: unknown): number {
  const statusCode = (err as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 403) return 403;
  const message = err instanceof Error ? err.message : '';
  return /无效|必须|必填|只能|合法值|格式|不存在|不能|不允许|长度|year|status|dates|remark|date/.test(message) ? 400 : 500;
}

function sendError(res: Response, err: unknown, fallback = '服务器内部错误'): void {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(status).json({ code: status, data: null, message: status === 500 ? fallback : message });
}

router.get('/', async (req: Request, res: Response) => {
  try {
    const data = await getWorkdayCalendarYear(req.user!, firstQueryValue(req.query.year));
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/workday-calendar]', err);
    sendError(res, err, '查询运营日历失败');
  }
});

router.post('/batch', async (req: Request, res: Response) => {
  try {
    const data = await batchUpdateWorkdayCalendar(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/workday-calendar/batch]', err);
    sendError(res, err, '批量更新运营日历失败');
  }
});

router.put('/:date', async (req: Request, res: Response) => {
  try {
    const data = await upsertWorkdayCalendarDay(req.user!, req.params.date, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PUT /api/workday-calendar/:date]', err);
    sendError(res, err, '更新运营日历失败');
  }
});

export default router;
