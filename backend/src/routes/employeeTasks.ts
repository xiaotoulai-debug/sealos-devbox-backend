import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import {
  createEmployeeTask,
  createEmployeeTaskComment,
  getAssignableUsers,
  getEmployeeTaskDetail,
  getEmployeeTaskWeeklySummary,
  getMentionUsers,
  getMyEmployeeTaskDashboard,
  listCreatedEmployeeTasks,
  listEmployeeTaskComments,
  listReceivedEmployeeTasks,
  startEmployeeTask,
  updateEmployeeTask,
  updateEmployeeTaskDueDate,
  updateEmployeeTaskStatus,
} from '../services/employeeTaskService';
import { generateWeeklyAiSummary } from '../services/weeklyAiSummaryService';

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
  return /无效|必须|必填|只能|合法值|格式|不存在|不能|不允许|长度|状态流转|截止日期|content|mentionedUserIds/.test(message) ? 400 : 500;
}

function sendError(res: Response, err: unknown, fallback = '服务器内部错误'): void {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(status).json({ code: status, data: null, message: status === 500 ? fallback : message });
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const data = await createEmployeeTask(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks]', err);
    sendError(res, err, '创建员工任务失败');
  }
});

router.get('/my-dashboard', async (req: Request, res: Response) => {
  try {
    const data = await getMyEmployeeTaskDashboard(req.user!, {
      weekStart: firstQueryValue(req.query.weekStart),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/my-dashboard]', err);
    sendError(res, err, '查询我的任务中心失败');
  }
});

router.get('/received', async (req: Request, res: Response) => {
  try {
    const data = await listReceivedEmployeeTasks(req.user!, {
      status: firstQueryValue(req.query.status),
      range: firstQueryValue(req.query.range),
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/received]', err);
    sendError(res, err, '查询我收到的任务失败');
  }
});

router.get('/created', async (req: Request, res: Response) => {
  try {
    const data = await listCreatedEmployeeTasks(req.user!, {
      status: firstQueryValue(req.query.status),
      range: firstQueryValue(req.query.range),
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/created]', err);
    sendError(res, err, '查询我发起的任务失败');
  }
});

router.get('/weekly-summary', async (req: Request, res: Response) => {
  try {
    if (req.query.userId != null) {
      res.status(400).json({ code: 400, data: null, message: 'weekly-summary 不允许传 userId' });
      return;
    }
    const data = await getEmployeeTaskWeeklySummary(req.user!, {
      weekStart: firstQueryValue(req.query.weekStart),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/weekly-summary]', err);
    sendError(res, err, '查询上周汇总失败');
  }
});

router.post('/weekly-summary/ai-generate', async (req: Request, res: Response) => {
  try {
    if (req.body?.userId != null) {
      res.status(400).json({ code: 400, data: null, message: 'weekly-summary 不允许传 userId' });
      return;
    }
    const data = await generateWeeklyAiSummary(req.user!, {
      weekStart: req.body?.weekStart,
      force: req.body?.force === true,
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/weekly-summary/ai-generate]', err);
    sendError(res, err, '生成 AI 周报失败');
  }
});

router.get('/assignable-users', async (_req: Request, res: Response) => {
  try {
    const data = await getAssignableUsers();
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/assignable-users]', err);
    sendError(res, err, '查询可指派用户失败');
  }
});

router.get('/mention-users', async (_req: Request, res: Response) => {
  try {
    const data = await getMentionUsers();
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/mention-users]', err);
    sendError(res, err, '查询可 @ 用户失败');
  }
});

router.get('/:id/comments', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await listEmployeeTaskComments(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/:id/comments]', err);
    sendError(res, err, '查询任务评论失败');
  }
});

router.post('/:id/comments', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await createEmployeeTaskComment(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/:id/comments]', err);
    sendError(res, err, '发表评论失败');
  }
});

router.patch('/:id/due-date', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await updateEmployeeTaskDueDate(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/employee-tasks/:id/due-date]', err);
    sendError(res, err, '更新任务截止日期失败');
  }
});

router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await startEmployeeTask(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/:id/start]', err);
    sendError(res, err, '开始处理任务失败');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await getEmployeeTaskDetail(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/:id]', err);
    sendError(res, err, '查询任务详情失败');
  }
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await updateEmployeeTaskStatus(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/employee-tasks/:id/status]', err);
    sendError(res, err, '更新任务状态失败');
  }
});

router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await updateEmployeeTask(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/employee-tasks/:id]', err);
    sendError(res, err, '更新任务内容失败');
  }
});

export default router;
