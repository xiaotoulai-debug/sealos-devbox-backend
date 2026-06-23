import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import {
  checkReminder,
  createReminderTemplate,
  deleteReminderTemplate,
  getReminderTemplateDetail,
  getTodayReminders,
  listReminderTemplates,
  updateReminderTemplate,
  updateReminderTemplateStatus,
} from '../services/dailyReminderService';

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
  if (statusCode === 409) return 409;
  const message = err instanceof Error ? err.message : '';
  return /无效|必须|必填|只能|合法值|格式|不存在|不能|不允许|长度|boolean|适用|未启用/.test(message) ? 400 : 500;
}

function sendError(res: Response, err: unknown, fallback = '服务器内部错误'): void {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(status).json({ code: status, data: null, message: status === 500 ? fallback : message });
}

router.get('/today', async (req: Request, res: Response) => {
  try {
    const data = await getTodayReminders(req.user!, {
      date: firstQueryValue(req.query.date),
      userId: firstQueryValue(req.query.userId),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/daily-reminders/today]', err);
    sendError(res, err, '查询今日提醒失败');
  }
});

router.post('/templates', async (req: Request, res: Response) => {
  try {
    const data = await createReminderTemplate(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/daily-reminders/templates]', err);
    sendError(res, err, '创建提醒模板失败');
  }
});

router.get('/templates', async (req: Request, res: Response) => {
  try {
    const data = await listReminderTemplates(req.user!, {
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
      isActive: firstQueryValue(req.query.isActive),
      category: firstQueryValue(req.query.category),
      priority: firstQueryValue(req.query.priority),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/daily-reminders/templates]', err);
    sendError(res, err, '查询提醒模板列表失败');
  }
});

router.get('/templates/:id', async (req: Request, res: Response) => {
  try {
    const data = await getReminderTemplateDetail(req.user!, Number(req.params.id));
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/daily-reminders/templates/:id]', err);
    sendError(res, err, '查询提醒模板详情失败');
  }
});

router.patch('/templates/:id/status', async (req: Request, res: Response) => {
  try {
    const data = await updateReminderTemplateStatus(req.user!, Number(req.params.id), req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/daily-reminders/templates/:id/status]', err);
    sendError(res, err, '更新提醒模板状态失败');
  }
});

router.patch('/templates/:id', async (req: Request, res: Response) => {
  try {
    const data = await updateReminderTemplate(req.user!, Number(req.params.id), req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/daily-reminders/templates/:id]', err);
    sendError(res, err, '更新提醒模板失败');
  }
});

router.delete('/templates/:id', async (req: Request, res: Response) => {
  try {
    const force = firstQueryValue(req.query.force) === 'true';
    const data = await deleteReminderTemplate(req.user!, Number(req.params.id), { force });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[DELETE /api/daily-reminders/templates/:id]', err);
    sendError(res, err, '删除提醒模板失败');
  }
});

router.post('/:templateId/check', async (req: Request, res: Response) => {
  try {
    const data = await checkReminder(req.user!, Number(req.params.templateId), req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/daily-reminders/:templateId/check]', err);
    sendError(res, err, '提交提醒检查失败');
  }
});

export default router;
