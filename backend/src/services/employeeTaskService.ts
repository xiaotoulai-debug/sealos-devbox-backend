import {
  EmployeeTaskLogAction,
  EmployeeTaskPriority,
  EmployeeTaskStatus,
  EmployeeTaskType,
  OperationTaskType,
  OperationPlatform,
  Prisma,
  UserStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';

const TASK_TYPES = Object.values(EmployeeTaskType);
const PLATFORMS = Object.values(OperationPlatform);
const PRIORITIES = Object.values(EmployeeTaskPriority);
const STATUSES = Object.values(EmployeeTaskStatus);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const WEEKLY_SUMMARY_TASK_LIMIT = 5;

const TASK_TYPE_NAMES: Record<EmployeeTaskType, string> = {
  PRODUCT_LISTING: '选品上架',
  QUALIFICATION: '资质维护',
  AD_OPTIMIZATION: '广告优化',
  MARKETING_STRATEGY: '营销策略',
  SHIPPING: '发货模块',
  PURCHASE: '采购模块',
  OTHER: '其他任务',
};

const STATUS_NAMES: Record<EmployeeTaskStatus, string> = {
  TODO: '待开始',
  IN_PROGRESS: '进行中',
  DONE: '已完成',
  CANCELLED: '已取消',
};

const PRIORITY_NAMES: Record<EmployeeTaskPriority, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
};

const PLATFORM_NAMES: Record<OperationPlatform, string> = {
  SHEIN: 'SHEIN',
  TEMU: 'TEMU',
  ALIEXPRESS: 'AliExpress',
  EMAG: 'eMAG',
  AMAZON: 'Amazon',
  OTHER: '其他',
};

const DAILY_REPORT_TASK_TYPES = [
  OperationTaskType.PRODUCT_SELECTION,
  OperationTaskType.PRODUCT_LISTING,
  OperationTaskType.APPROVED_COUNT,
  OperationTaskType.SHIPMENT_COUNT,
  OperationTaskType.OTHER,
] as const;

const DAILY_REPORT_TASK_NAMES: Record<(typeof DAILY_REPORT_TASK_TYPES)[number], string> = {
  PRODUCT_SELECTION: '选品数量',
  PRODUCT_LISTING: '上新数量',
  APPROVED_COUNT: '合规数量',
  SHIPMENT_COUNT: '发货数量',
  OTHER: '其他说明',
};

type EmployeeTaskWithRelations = Prisma.EmployeeTaskGetPayload<{
  include: {
    creator: { select: { id: true; name: true } };
    assignee: { select: { id: true; name: true } };
    shop: { select: { id: true; shopName: true } };
  };
}>;

type EmployeeTaskDetail = Prisma.EmployeeTaskGetPayload<{
  include: {
    creator: { select: { id: true; name: true } };
    assignee: { select: { id: true; name: true } };
    shop: { select: { id: true; shopName: true } };
    logs: {
      include: { operator: { select: { id: true; name: true } } };
      orderBy: { createdAt: 'desc' };
    };
  };
}>;

export type CreateEmployeeTaskInput = {
  title?: unknown;
  description?: unknown;
  taskType?: unknown;
  platform?: unknown;
  shopId?: unknown;
  assigneeId?: unknown;
  dueDate?: unknown;
  priority?: unknown;
  relatedSkuText?: unknown;
  remark?: unknown;
};

export type UpdateEmployeeTaskInput = {
  title?: unknown;
  description?: unknown;
  platform?: unknown;
  shopId?: unknown;
  dueDate?: unknown;
  priority?: unknown;
  relatedSkuText?: unknown;
  remark?: unknown;
};

function parseRequiredString(value: unknown, fieldName: string, maxLength = 255): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${fieldName} 为必填`);
  if (text.length > maxLength) throw new Error(`${fieldName} 长度不能超过 ${maxLength}`);
  return text;
}

function parseOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function parseTaskType(value: unknown): EmployeeTaskType {
  const raw = String(value ?? '').trim();
  if (!TASK_TYPES.includes(raw as EmployeeTaskType)) {
    throw new Error(`taskType 无效，合法值：${TASK_TYPES.join('/')}`);
  }
  return raw as EmployeeTaskType;
}

function parsePlatform(value: unknown): OperationPlatform | undefined {
  if (value == null || value === '') return undefined;
  const raw = String(value).trim();
  if (!PLATFORMS.includes(raw as OperationPlatform)) {
    throw new Error(`platform 无效，合法值：${PLATFORMS.join('/')}`);
  }
  return raw as OperationPlatform;
}

function parsePriority(value: unknown): EmployeeTaskPriority {
  if (value == null || value === '') return EmployeeTaskPriority.MEDIUM;
  const raw = String(value).trim();
  if (!PRIORITIES.includes(raw as EmployeeTaskPriority)) {
    throw new Error(`priority 无效，合法值：${PRIORITIES.join('/')}`);
  }
  return raw as EmployeeTaskPriority;
}

function parseStatus(value: unknown): EmployeeTaskStatus {
  const raw = String(value ?? '').trim();
  if (!STATUSES.includes(raw as EmployeeTaskStatus)) {
    throw new Error(`status 无效，合法值：${STATUSES.join('/')}`);
  }
  return raw as EmployeeTaskStatus;
}

function parsePositiveInt(value: unknown, fieldName: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return n;
}

function parseOptionalPositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value == null || value === '') return undefined;
  return parsePositiveInt(value, fieldName);
}

function parseDueDate(value: unknown): Date {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('dueDate 为必填');
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.000Z` : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error('dueDate 日期无效');
  }
  return date;
}

function assertDateString(value: unknown, fieldName: string): string {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${fieldName} 格式无效，请使用 YYYY-MM-DD`);
  }
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${fieldName} 日期无效`);
  }
  return raw;
}

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number): string {
  const d = dateStringToDbDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekRange(weekStart?: unknown) {
  if (weekStart) {
    const startDate = assertDateString(weekStart, 'weekStart');
    return {
      start: dateStringToDbDate(startDate),
      end: new Date(dateStringToDbDate(addDays(startDate, 7)).getTime() - 1),
    };
  }
  const today = dateStringToDbDate(todayString());
  const day = today.getUTCDay() || 7;
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - day + 1);
  const end = new Date(start.getTime() + 7 * DAY_MS - 1);
  return { start, end };
}

function resolveWeeklySummaryRange(weekStartInput?: unknown) {
  let startDate: string;
  if (weekStartInput) {
    startDate = assertDateString(weekStartInput, 'weekStart');
  } else {
    const today = dateStringToDbDate(todayString());
    const day = today.getUTCDay() || 7;
    today.setUTCDate(today.getUTCDate() - day - 6);
    startDate = today.toISOString().slice(0, 10);
  }

  const start = dateStringToDbDate(startDate);
  if (start.getUTCDay() !== 1) {
    throw new Error('weekStart 必须是周一日期');
  }

  const endDate = addDays(startDate, 6);
  return {
    weekStart: startDate,
    weekEnd: endDate,
    start,
    end: new Date(dateStringToDbDate(addDays(startDate, 7)).getTime() - 1),
    reportEnd: dateStringToDbDate(endDate),
  };
}

function monthRangeFor(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1);
  return { start, end };
}

function parsePagination(query: { page?: unknown; pageSize?: unknown }) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const requestedPageSize = Number.parseInt(String(query.pageSize ?? '20'), 10) || 20;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function rangeWhere(range: unknown): Prisma.EmployeeTaskWhereInput {
  const raw = String(range ?? 'all').trim();
  if (raw === 'all' || raw === '') return {};
  if (raw === 'thisWeek') {
    const { start, end } = weekRange();
    return { dueDate: { gte: start, lte: end } };
  }
  if (raw === 'thisMonth') {
    const { start, end } = monthRangeFor();
    return { dueDate: { gte: start, lte: end } };
  }
  throw new Error('range 无效，合法值：thisWeek/thisMonth/all');
}

function currentUserWhere(userId: number): Prisma.EmployeeTaskWhereInput {
  return { OR: [{ creatorId: userId }, { assigneeId: userId }] };
}

function isOverdue(task: { status: EmployeeTaskStatus; dueDate: Date }): boolean {
  return (
    task.status !== EmployeeTaskStatus.DONE &&
    task.status !== EmployeeTaskStatus.CANCELLED &&
    task.dueDate.getTime() < Date.now()
  );
}

function taskInclude() {
  return {
    creator: { select: { id: true, name: true } },
    assignee: { select: { id: true, name: true } },
    shop: { select: { id: true, shopName: true } },
  } satisfies Prisma.EmployeeTaskInclude;
}

function taskDetailInclude() {
  return {
    ...taskInclude(),
    logs: {
      include: { operator: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    },
  } satisfies Prisma.EmployeeTaskInclude;
}

function formatTask(task: EmployeeTaskWithRelations) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    taskType: task.taskType,
    taskTypeName: TASK_TYPE_NAMES[task.taskType],
    platform: task.platform,
    platformName: task.platform ? PLATFORM_NAMES[task.platform] : null,
    shopId: task.shopId,
    shopName: task.shop?.shopName ?? null,
    priority: task.priority,
    priorityName: PRIORITY_NAMES[task.priority],
    status: task.status,
    statusName: STATUS_NAMES[task.status],
    isOverdue: isOverdue(task),
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    cancelledAt: task.cancelledAt,
    creatorId: task.creatorId,
    creatorName: task.creator.name,
    assigneeId: task.assigneeId,
    assigneeName: task.assignee.name,
    relatedSkuText: task.relatedSkuText,
    remark: task.remark,
    scoreImpact: null,
    scoreStatus: 'NOT_CONFIGURED',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function formatTaskDetail(task: EmployeeTaskDetail) {
  return {
    ...formatTask(task),
    logs: task.logs.map((log) => ({
      id: log.id,
      taskId: log.taskId,
      operatorId: log.operatorId,
      operatorName: log.operator.name,
      action: log.action,
      fromStatus: log.fromStatus,
      toStatus: log.toStatus,
      remark: log.remark,
      createdAt: log.createdAt,
    })),
  };
}

async function assertAssigneeActive(assigneeId: number) {
  const assignee = await prisma.user.findFirst({
    where: { id: assigneeId, status: UserStatus.ACTIVE },
    select: { id: true },
  });
  if (!assignee) {
    throw new Error('assigneeId 不存在或不是 ACTIVE 用户');
  }
}

async function assertShopExists(shopId?: number) {
  if (!shopId) return;
  const shop = await prisma.shopAuthorization.findUnique({
    where: { id: shopId },
    select: { id: true },
  });
  if (!shop) {
    throw new Error('shopId 不存在');
  }
}

async function getVisibleTaskOrThrow(taskId: number, userId: number) {
  const task = await prisma.employeeTask.findUnique({
    where: { id: taskId },
    include: taskDetailInclude(),
  });
  if (!task) {
    throw Object.assign(new Error('任务不存在'), { statusCode: 404 });
  }
  if (task.creatorId !== userId && task.assigneeId !== userId) {
    throw Object.assign(new Error('无权限查看该任务'), { statusCode: 403 });
  }
  return task;
}

export async function createEmployeeTask(user: JwtPayload, input: CreateEmployeeTaskInput) {
  const title = parseRequiredString(input.title, 'title');
  const description = parseOptionalString(input.description);
  const taskType = parseTaskType(input.taskType);
  const platform = parsePlatform(input.platform);
  const shopId = parseOptionalPositiveInt(input.shopId, 'shopId');
  const assigneeId = parsePositiveInt(input.assigneeId, 'assigneeId');
  const dueDate = parseDueDate(input.dueDate);
  const priority = parsePriority(input.priority);
  const relatedSkuText = parseOptionalString(input.relatedSkuText);
  const remark = parseOptionalString(input.remark);

  await Promise.all([assertAssigneeActive(assigneeId), assertShopExists(shopId)]);

  const created = await prisma.$transaction(async (tx) => {
    const task = await tx.employeeTask.create({
      data: {
        title,
        description,
        taskType,
        platform,
        shopId,
        priority,
        creatorId: user.userId,
        assigneeId,
        dueDate,
        relatedSkuText,
        remark,
      },
    });
    await tx.employeeTaskLog.create({
      data: {
        taskId: task.id,
        operatorId: user.userId,
        action: EmployeeTaskLogAction.CREATED,
        toStatus: task.status,
        remark,
      },
    });
    return tx.employeeTask.findUniqueOrThrow({
      where: { id: task.id },
      include: taskDetailInclude(),
    });
  });

  return formatTaskDetail(created);
}

export async function getAssignableUsers() {
  const users = await prisma.user.findMany({
    where: { status: UserStatus.ACTIVE },
    select: { id: true, name: true, role: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    roleName: user.role.name,
  }));
}

export async function getEmployeeTaskDetail(user: JwtPayload, taskId: number) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error('id 必须是正整数');
  }
  const task = await getVisibleTaskOrThrow(taskId, user.userId);
  return formatTaskDetail(task);
}

export async function listReceivedEmployeeTasks(user: JwtPayload, query: { status?: unknown; range?: unknown; page?: unknown; pageSize?: unknown }) {
  return listEmployeeTasks({
    baseWhere: { assigneeId: user.userId },
    status: query.status,
    range: query.range,
    page: query.page,
    pageSize: query.pageSize,
  });
}

export async function listCreatedEmployeeTasks(user: JwtPayload, query: { status?: unknown; range?: unknown; page?: unknown; pageSize?: unknown }) {
  return listEmployeeTasks({
    baseWhere: { creatorId: user.userId },
    status: query.status,
    range: query.range,
    page: query.page,
    pageSize: query.pageSize,
  });
}

async function listEmployeeTasks(params: {
  baseWhere: Prisma.EmployeeTaskWhereInput;
  status?: unknown;
  range?: unknown;
  page?: unknown;
  pageSize?: unknown;
}) {
  const { page, pageSize, skip } = parsePagination({ page: params.page, pageSize: params.pageSize });
  const where: Prisma.EmployeeTaskWhereInput = {
    AND: [
      params.baseWhere,
      rangeWhere(params.range),
    ],
  };

  if (params.status) {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { status: parseStatus(params.status) }];
  } else {
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { status: { not: EmployeeTaskStatus.CANCELLED } }];
  }

  const [total, tasks] = await Promise.all([
    prisma.employeeTask.count({ where }),
    prisma.employeeTask.findMany({
      where,
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      skip,
      take: pageSize,
    }),
  ]);

  return {
    items: tasks.map(formatTask),
    total,
    page,
    pageSize,
  };
}

export async function getMyEmployeeTaskDashboard(user: JwtPayload, params: { weekStart?: unknown }) {
  const { start: weekStart, end: weekEnd } = weekRange(params.weekStart);
  const { start: monthStart, end: monthEnd } = monthRangeFor();
  const relatedWhere = currentUserWhere(user.userId);
  const nonCancelledMonthWhere: Prisma.EmployeeTaskWhereInput = {
    AND: [
      relatedWhere,
      { dueDate: { gte: monthStart, lte: monthEnd } },
      { status: { not: EmployeeTaskStatus.CANCELLED } },
    ],
  };

  const [
    weeklyPendingCount,
    weeklyDoneCount,
    monthTotalCount,
    monthDoneCount,
    receivedTaskCount,
    weeklyTasks,
    historyTasks,
    receivedTasks,
    createdTasks,
  ] = await Promise.all([
    prisma.employeeTask.count({
      where: {
        AND: [
          relatedWhere,
          { dueDate: { gte: weekStart, lte: weekEnd } },
          { status: { notIn: [EmployeeTaskStatus.DONE, EmployeeTaskStatus.CANCELLED] } },
        ],
      },
    }),
    prisma.employeeTask.count({
      where: {
        AND: [
          relatedWhere,
          { completedAt: { gte: weekStart, lte: weekEnd } },
          { status: EmployeeTaskStatus.DONE },
        ],
      },
    }),
    prisma.employeeTask.count({ where: nonCancelledMonthWhere }),
    prisma.employeeTask.count({
      where: {
        AND: [
          relatedWhere,
          { dueDate: { gte: monthStart, lte: monthEnd } },
          { status: EmployeeTaskStatus.DONE },
        ],
      },
    }),
    prisma.employeeTask.count({
      where: { assigneeId: user.userId, status: { not: EmployeeTaskStatus.CANCELLED } },
    }),
    prisma.employeeTask.findMany({
      where: {
        AND: [
          relatedWhere,
          { dueDate: { gte: weekStart, lte: weekEnd } },
        ],
      },
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      take: 50,
    }),
    prisma.employeeTask.findMany({
      where: relatedWhere,
      include: taskInclude(),
      orderBy: [{ updatedAt: 'desc' }],
      take: 20,
    }),
    prisma.employeeTask.findMany({
      where: { assigneeId: user.userId, status: { not: EmployeeTaskStatus.CANCELLED } },
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      take: 20,
    }),
    prisma.employeeTask.findMany({
      where: { creatorId: user.userId, status: { not: EmployeeTaskStatus.CANCELLED } },
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      take: 20,
    }),
  ]);

  return {
    summaryCards: {
      weeklyPendingCount,
      weeklyDoneCount,
      monthlyCompletionRate: monthTotalCount === 0 ? 0 : Number((monthDoneCount / monthTotalCount).toFixed(4)),
      receivedTaskCount,
    },
    weeklyTasks: weeklyTasks.map(formatTask),
    historyTasks: historyTasks.map(formatTask),
    receivedTasks: receivedTasks.map(formatTask),
    createdTasks: createdTasks.map(formatTask),
  };
}

function aggregateTaskSummary(tasks: EmployeeTaskWithRelations[], includeInProgress = false) {
  const doneTasks = tasks.filter((task) => task.status === EmployeeTaskStatus.DONE);
  const pendingTasks = tasks.filter((task) => task.status !== EmployeeTaskStatus.DONE && task.status !== EmployeeTaskStatus.CANCELLED);
  const overdueTasks = pendingTasks.filter(isOverdue);
  const base = {
    totalCount: tasks.length,
    doneCount: doneTasks.length,
    pendingCount: pendingTasks.length,
    overdueCount: overdueTasks.length,
    doneTasks: doneTasks.slice(0, WEEKLY_SUMMARY_TASK_LIMIT).map(formatTask),
    pendingTasks: pendingTasks.slice(0, WEEKLY_SUMMARY_TASK_LIMIT).map(formatTask),
    overdueTasks: overdueTasks.slice(0, WEEKLY_SUMMARY_TASK_LIMIT).map(formatTask),
  };
  return includeInProgress
    ? { ...base, inProgressCount: tasks.filter((task) => task.status === EmployeeTaskStatus.IN_PROGRESS).length }
    : base;
}

function buildPlanSuggestions(params: {
  dailyReportSummary: { missingDays: number; blockedItems: unknown[] };
  receivedTaskSummary: { overdueCount: number };
  createdTaskSummary: { overdueCount: number };
}) {
  const suggestions: string[] = [];
  if (params.receivedTaskSummary.overdueCount > 0 || params.createdTaskSummary.overdueCount > 0) {
    suggestions.push('建议优先处理逾期任务。');
  }
  if (params.dailyReportSummary.blockedItems.length > 0) {
    suggestions.push('建议优先解决阻塞事项。');
  }
  if (params.dailyReportSummary.missingDays > 0) {
    suggestions.push('建议本周保持每日登记。');
  }
  if (suggestions.length === 0) {
    suggestions.push('建议延续当前节奏，继续提升任务完成率。');
  }
  return suggestions;
}

export async function getEmployeeTaskWeeklySummary(user: JwtPayload, params: { weekStart?: unknown }) {
  const range = resolveWeeklySummaryRange(params.weekStart);
  const userId = user.userId;

  const [reports, logs, receivedTasks, createdTasks] = await Promise.all([
    prisma.operationDailyReport.findMany({
      where: {
        userId,
        workDate: { gte: range.start, lte: range.reportEnd },
      },
      select: { workDate: true },
    }),
    prisma.operationDailyLog.findMany({
      where: {
        userId,
        workDate: { gte: range.start, lte: range.reportEnd },
        taskType: { in: [...DAILY_REPORT_TASK_TYPES] },
      },
      select: {
        workDate: true,
        taskType: true,
        quantity: true,
        detail: true,
        blockerReason: true,
      },
      orderBy: [{ workDate: 'asc' }, { id: 'asc' }],
    }),
    prisma.employeeTask.findMany({
      where: {
        assigneeId: userId,
        status: { not: EmployeeTaskStatus.CANCELLED },
        OR: [
          { dueDate: { gte: range.start, lte: range.end } },
          { completedAt: { gte: range.start, lte: range.end } },
        ],
      },
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
    }),
    prisma.employeeTask.findMany({
      where: {
        creatorId: userId,
        status: { not: EmployeeTaskStatus.CANCELLED },
        OR: [
          { createdAt: { gte: range.start, lte: range.end } },
          { dueDate: { gte: range.start, lte: range.end } },
          { completedAt: { gte: range.start, lte: range.end } },
        ],
      },
      include: taskInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
    }),
  ]);

  const submittedDates = new Set(reports.map((report) => report.workDate.toISOString().slice(0, 10)));
  const dailyReportSummary = {
    submittedDays: submittedDates.size,
    missingDays: Math.max(0, 7 - submittedDates.size),
    productSelectionCount: 0,
    productListingCount: 0,
    approvedCount: 0,
    shipmentCount: 0,
    otherNotes: [] as Array<{ date: string; text: string }>,
    blockedItems: [] as Array<{ date: string; taskType: string; taskTypeName: string; blockerReason: string }>,
  };

  for (const log of logs) {
    const date = log.workDate.toISOString().slice(0, 10);
    if (log.taskType === OperationTaskType.PRODUCT_SELECTION) dailyReportSummary.productSelectionCount += log.quantity;
    if (log.taskType === OperationTaskType.PRODUCT_LISTING) dailyReportSummary.productListingCount += log.quantity;
    if (log.taskType === OperationTaskType.APPROVED_COUNT) dailyReportSummary.approvedCount += log.quantity;
    if (log.taskType === OperationTaskType.SHIPMENT_COUNT) dailyReportSummary.shipmentCount += log.quantity;
    if (log.taskType === OperationTaskType.OTHER && log.detail?.trim()) {
      dailyReportSummary.otherNotes.push({ date, text: log.detail.trim() });
    }
    if (log.blockerReason?.trim()) {
      const taskType = log.taskType as (typeof DAILY_REPORT_TASK_TYPES)[number];
      dailyReportSummary.blockedItems.push({
        date,
        taskType: log.taskType,
        taskTypeName: DAILY_REPORT_TASK_NAMES[taskType],
        blockerReason: log.blockerReason.trim(),
      });
    }
  }

  const receivedTaskSummary = aggregateTaskSummary(receivedTasks, true);
  const createdTaskSummary = aggregateTaskSummary(createdTasks, false);
  const planSuggestions = buildPlanSuggestions({
    dailyReportSummary,
    receivedTaskSummary,
    createdTaskSummary,
  });
  const summaryText = {
    dailyReport: `上周共提交日报 ${dailyReportSummary.submittedDays} 天，缺失 ${dailyReportSummary.missingDays} 天；累计选品 ${dailyReportSummary.productSelectionCount} 个，上新 ${dailyReportSummary.productListingCount} 个，合规 ${dailyReportSummary.approvedCount} 个，发货 ${dailyReportSummary.shipmentCount} 个。`,
    receivedTasks: `上周收到任务 ${receivedTaskSummary.totalCount} 个，完成 ${receivedTaskSummary.doneCount} 个，未完成 ${receivedTaskSummary.pendingCount} 个，逾期 ${receivedTaskSummary.overdueCount} 个。`,
    createdTasks: `上周发起任务 ${createdTaskSummary.totalCount} 个，已完成 ${createdTaskSummary.doneCount} 个，待跟进 ${createdTaskSummary.pendingCount} 个，逾期 ${createdTaskSummary.overdueCount} 个。`,
    nextWeekPlan: planSuggestions.join(' '),
  };

  return {
    weekStart: range.weekStart,
    weekEnd: range.weekEnd,
    dailyReportSummary,
    receivedTaskSummary,
    createdTaskSummary,
    planSuggestions,
    summaryText,
    aiStatus: 'NOT_ENABLED',
  };
}

export async function updateEmployeeTaskStatus(user: JwtPayload, taskId: number, input: { status?: unknown; remark?: unknown }) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error('id 必须是正整数');
  }
  const nextStatus = parseStatus(input.status);
  const remark = parseOptionalString(input.remark);
  const existing = await getVisibleTaskOrThrow(taskId, user.userId);

  if (existing.status === EmployeeTaskStatus.DONE || existing.status === EmployeeTaskStatus.CANCELLED) {
    throw new Error('任务已完成或已取消，不能再修改状态');
  }
  if (nextStatus === existing.status) {
    return formatTaskDetail(existing);
  }

  const isAssignee = existing.assigneeId === user.userId;
  const isCreator = existing.creatorId === user.userId;
  const assigneeAllowedStatuses: EmployeeTaskStatus[] = [
    EmployeeTaskStatus.TODO,
    EmployeeTaskStatus.IN_PROGRESS,
    EmployeeTaskStatus.DONE,
  ];
  const assigneeAllowed = isAssignee && assigneeAllowedStatuses.includes(nextStatus);
  const creatorAllowed = isCreator && nextStatus === EmployeeTaskStatus.CANCELLED;

  if (!assigneeAllowed && !creatorAllowed) {
    throw Object.assign(new Error('无权限执行该状态流转'), { statusCode: 403 });
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    await tx.employeeTask.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        completedAt: nextStatus === EmployeeTaskStatus.DONE ? now : existing.completedAt,
        cancelledAt: nextStatus === EmployeeTaskStatus.CANCELLED ? now : existing.cancelledAt,
      },
    });
    await tx.employeeTaskLog.create({
      data: {
        taskId: existing.id,
        operatorId: user.userId,
        action: nextStatus === EmployeeTaskStatus.CANCELLED ? EmployeeTaskLogAction.CANCELLED : EmployeeTaskLogAction.STATUS_CHANGED,
        fromStatus: existing.status,
        toStatus: nextStatus,
        remark,
      },
    });
    return tx.employeeTask.findUniqueOrThrow({
      where: { id: existing.id },
      include: taskDetailInclude(),
    });
  });

  return formatTaskDetail(updated);
}

export async function updateEmployeeTask(user: JwtPayload, taskId: number, input: UpdateEmployeeTaskInput) {
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error('id 必须是正整数');
  }
  const existing = await getVisibleTaskOrThrow(taskId, user.userId);
  if (existing.creatorId !== user.userId) {
    throw Object.assign(new Error('只有创建人可以修改任务内容'), { statusCode: 403 });
  }
  if (existing.status === EmployeeTaskStatus.DONE || existing.status === EmployeeTaskStatus.CANCELLED) {
    throw new Error('任务已完成或已取消，不能修改内容');
  }

  const data: Prisma.EmployeeTaskUpdateInput = {};
  if (input.title !== undefined) data.title = parseRequiredString(input.title, 'title');
  if (input.description !== undefined) data.description = parseOptionalString(input.description) ?? null;
  if (input.platform !== undefined) data.platform = parsePlatform(input.platform) ?? null;
  if (input.shopId !== undefined) data.shop = parseOptionalPositiveInt(input.shopId, 'shopId')
    ? { connect: { id: parseOptionalPositiveInt(input.shopId, 'shopId') } }
    : { disconnect: true };
  if (input.dueDate !== undefined) data.dueDate = parseDueDate(input.dueDate);
  if (input.priority !== undefined) data.priority = parsePriority(input.priority);
  if (input.relatedSkuText !== undefined) data.relatedSkuText = parseOptionalString(input.relatedSkuText) ?? null;
  if (input.remark !== undefined) data.remark = parseOptionalString(input.remark) ?? null;

  const nextShopId = parseOptionalPositiveInt(input.shopId, 'shopId');
  await assertShopExists(nextShopId);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.employeeTask.update({
      where: { id: existing.id },
      data,
    });
    await tx.employeeTaskLog.create({
      data: {
        taskId: existing.id,
        operatorId: user.userId,
        action: EmployeeTaskLogAction.UPDATED,
        fromStatus: existing.status,
        toStatus: existing.status,
        remark: parseOptionalString(input.remark),
      },
    });
    return tx.employeeTask.findUniqueOrThrow({
      where: { id: existing.id },
      include: taskDetailInclude(),
    });
  });

  return formatTaskDetail(updated);
}
