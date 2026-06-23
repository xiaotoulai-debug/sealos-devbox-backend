import { Router, Request, Response, NextFunction } from 'express';
import {
  authenticate,
  DASHBOARD_PERMISSION,
  requireStrictPermission,
  requireWeeklyAiGeneratePermission,
} from '../middleware/auth';
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
import {
  getAdminEmployeeTaskDashboard,
  getAdminEmployeeUsersSummary,
  listAdminEmployeeTasks,
} from '../services/employeeTaskAdminService';
import {
  enqueueAdminWeeklySummaryGeneration,
  listAdminWeeklySummaries,
} from '../services/adminWeeklySummaryService';
import {
  getEmployeeWeeklyPlan,
  saveEmployeeWeeklyPlan,
} from '../services/employeeWeeklyPlanService';
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
  if (statusCode === 503) return 503;
  const message = err instanceof Error ? err.message : '';
  return /无效|必须|必填|只能|合法值|格式|不存在|不能|不允许|长度|状态流转|截止日期|content|mentionedUserIds|未找到|未启用/.test(message) ? 400 : 500;
}

function sendError(res: Response, err: unknown, fallback = '服务器内部错误'): void {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : fallback;
  res.status(status).json({ code: status, data: null, message: status === 500 ? fallback : message });
}

/** 防止固定路径（如 weekly-plan）被 /:id 动态路由误匹配后触发「id 必须是正整数」 */
function rejectNonNumericTaskIdParam(req: Request, res: Response, next: NextFunction): void {
  const rawId = req.params.id;
  if (typeof rawId !== 'string' || !/^\d+$/.test(rawId)) {
    res.status(404).json({ code: 404, data: null, message: '接口不存在' });
    return;
  }
  next();
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

// ── 固定路径：必须在所有 /:id 动态路由之前注册 ──
router.get('/weekly-plan', async (req: Request, res: Response) => {
  try {
    if (req.query.userId != null) {
      res.status(400).json({ code: 400, data: null, message: 'weekly-plan 不允许传 userId' });
      return;
    }
    const data = await getEmployeeWeeklyPlan(req.user!, firstQueryValue(req.query.weekStart));
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/weekly-plan]', err);
    sendError(res, err, '查询下周计划失败');
  }
});

router.post('/weekly-plan', async (req: Request, res: Response) => {
  try {
    if (req.body?.userId != null) {
      res.status(400).json({ code: 400, data: null, message: 'weekly-plan 不允许传 userId' });
      return;
    }
    if (req.body?.id != null) {
      res.status(400).json({ code: 400, data: null, message: 'weekly-plan 不允许传 id' });
      return;
    }
    const data = await saveEmployeeWeeklyPlan(req.user!, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/weekly-plan]', err);
    sendError(res, err, '保存下周计划失败');
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

router.post('/weekly-summary/ai-generate', requireWeeklyAiGeneratePermission, async (req: Request, res: Response) => {
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

router.get(
  '/admin-weekly-summaries',
  requireStrictPermission(DASHBOARD_PERMISSION.COMPANY_MANAGEMENT, '无权限访问公司管理'),
  async (req: Request, res: Response) => {
  try {
    const data = await listAdminWeeklySummaries({
      weekStart: firstQueryValue(req.query.weekStart),
      assigneeId: firstQueryValue(req.query.assigneeId),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/admin-weekly-summaries]', err);
    sendError(res, err, '查询员工周报汇总失败');
  }
});

router.post(
  '/admin-weekly-summaries/generate',
  requireStrictPermission(DASHBOARD_PERMISSION.COMPANY_WEEKLY_AI_GENERATE, '无权限生成员工AI周报'),
  async (req: Request, res: Response) => {
  try {
    const data = await enqueueAdminWeeklySummaryGeneration({
      weekStart: req.body?.weekStart,
      assigneeId: req.body?.assigneeId,
      force: req.body?.force,
    });
    res.json({ code: 200, data, message: 'AI汇总生成任务已提交' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/admin-weekly-summaries/generate]', err);
    sendError(res, err, '提交 AI 汇总生成任务失败');
  }
});

router.get(
  '/admin-dashboard',
  requireStrictPermission(DASHBOARD_PERMISSION.COMPANY_TASK_MANAGE, '无权限访问公司管理'),
  async (req: Request, res: Response) => {
  try {
    const data = await getAdminEmployeeTaskDashboard(req.user!, {
      weekStart: firstQueryValue(req.query.weekStart),
      assigneeId: firstQueryValue(req.query.assigneeId),
      status: firstQueryValue(req.query.status),
      platform: firstQueryValue(req.query.platform),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/admin-dashboard]', err);
    sendError(res, err, '查询管理员工任务统计失败');
  }
});

router.get(
  '/admin-users-summary',
  requireStrictPermission(DASHBOARD_PERMISSION.COMPANY_TASK_MANAGE, '无权限访问公司管理'),
  async (req: Request, res: Response) => {
  try {
    const data = await getAdminEmployeeUsersSummary(req.user!, {
      weekStart: firstQueryValue(req.query.weekStart),
      assigneeId: firstQueryValue(req.query.assigneeId),
      status: firstQueryValue(req.query.status),
      platform: firstQueryValue(req.query.platform),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/admin-users-summary]', err);
    sendError(res, err, '查询员工任务汇总失败');
  }
});

router.get(
  '/admin-tasks',
  requireStrictPermission(DASHBOARD_PERMISSION.COMPANY_TASK_MANAGE, '无权限访问公司管理'),
  async (req: Request, res: Response) => {
  try {
    const data = await listAdminEmployeeTasks(req.user!, {
      weekStart: firstQueryValue(req.query.weekStart),
      assigneeId: firstQueryValue(req.query.assigneeId),
      status: firstQueryValue(req.query.status),
      platform: firstQueryValue(req.query.platform),
      page: firstQueryValue(req.query.page),
      pageSize: firstQueryValue(req.query.pageSize),
    });
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/admin-tasks]', err);
    sendError(res, err, '查询管理员工任务列表失败');
  }
});

router.get('/:id/comments', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await listEmployeeTaskComments(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/:id/comments]', err);
    sendError(res, err, '查询任务评论失败');
  }
});

router.post('/:id/comments', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await createEmployeeTaskComment(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/:id/comments]', err);
    sendError(res, err, '发表评论失败');
  }
});

router.patch('/:id/due-date', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await updateEmployeeTaskDueDate(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/employee-tasks/:id/due-date]', err);
    sendError(res, err, '更新任务截止日期失败');
  }
});

router.post('/:id/start', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await startEmployeeTask(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[POST /api/employee-tasks/:id/start]', err);
    sendError(res, err, '开始处理任务失败');
  }
});

router.get('/:id', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await getEmployeeTaskDetail(req.user!, id);
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[GET /api/employee-tasks/:id]', err);
    sendError(res, err, '查询任务详情失败');
  }
});

router.patch('/:id/status', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const data = await updateEmployeeTaskStatus(req.user!, id, req.body ?? {});
    res.json({ code: 200, data, message: 'success' });
  } catch (err) {
    console.error('[PATCH /api/employee-tasks/:id/status]', err);
    sendError(res, err, '更新任务状态失败');
  }
});

router.patch('/:id', rejectNonNumericTaskIdParam, async (req: Request, res: Response) => {
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
