import {
  OperationLogStatus,
  OperationPlatform,
  OperationTaskType,
  Prisma,
  UserStatus,
  WorkdayStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { DASHBOARD_PERMISSION, hasStrictPermission, JwtPayload } from '../middleware/auth';
import { getWorkdayStatusForDate, getWorkdayStatusMap } from './workdayCalendarService';

const TASK_TYPES = Object.values(OperationTaskType);
const PLATFORMS = Object.values(OperationPlatform);
const LOG_STATUSES = Object.values(OperationLogStatus);
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const MAX_REPORT_EDIT_COUNT = 1;
const OTHER_SUMMARY_MAX_LENGTH = 16;

const DAILY_TASK_METRICS = [
  { taskType: OperationTaskType.PRODUCT_SELECTION, taskName: '选品数量', metricName: '选品数量', valueType: 'quantity' },
  { taskType: OperationTaskType.PRODUCT_LISTING, taskName: '上新数量', metricName: '上新数量', valueType: 'quantity' },
  { taskType: OperationTaskType.APPROVED_COUNT, taskName: '合规数量', metricName: '合规数量', valueType: 'quantity' },
  { taskType: OperationTaskType.SHIPMENT_COUNT, taskName: '发货数量', metricName: '发货数量', valueType: 'quantity' },
  { taskType: OperationTaskType.OTHER, taskName: '其他说明', metricName: '其他说明', valueType: 'text' },
] as const;
const REPORT_TASK_TYPES = DAILY_TASK_METRICS.map((metric) => metric.taskType);

export const OPERATION_SCORE_RULES: Record<OperationTaskType, number> = {
  PRODUCT_SELECTION: 1,
  PRODUCT_LISTING: 2,
  APPROVED_COUNT: 2,
  SHIPMENT_COUNT: 1,
  QUALIFICATION: 2,
  ADJUSTMENT: 1,
  REVIEW_FIX: 2,
  AFTER_SALES: 1,
  OTHER: 0,
};

const REPORT_TASK_NAMES: Record<ReportTaskType, string> = {
  PRODUCT_SELECTION: '选品数量',
  PRODUCT_LISTING: '上新数量',
  APPROVED_COUNT: '合规数量',
  SHIPMENT_COUNT: '发货数量',
  OTHER: '其他说明',
};

type TaskCountKey =
  | 'productSelectionCount'
  | 'productListingCount'
  | 'approvedCount'
  | 'shipmentCount'
  | 'otherCount';

const TASK_COUNT_KEY: Record<OperationTaskType, TaskCountKey> = {
  PRODUCT_SELECTION: 'productSelectionCount',
  PRODUCT_LISTING: 'productListingCount',
  APPROVED_COUNT: 'approvedCount',
  SHIPMENT_COUNT: 'shipmentCount',
  QUALIFICATION: 'otherCount',
  ADJUSTMENT: 'otherCount',
  REVIEW_FIX: 'otherCount',
  AFTER_SALES: 'otherCount',
  OTHER: 'otherCount',
};

type ReportTaskType = (typeof DAILY_TASK_METRICS)[number]['taskType'];

export type CreateOperationDailyLogInput = {
  workDate: unknown;
  taskType: unknown;
  platform?: unknown;
  shopId?: unknown;
  quantity: unknown;
  status?: unknown;
  detail?: unknown;
  links?: unknown;
  blockerReason?: unknown;
};

export type OperationDailyReportItemInput = {
  taskType: unknown;
  quantity?: unknown;
  links?: unknown;
  detail?: unknown;
  blockerReason?: unknown;
};

export type SubmitOperationDailyReportInput = {
  workDate: unknown;
  items?: unknown;
};

export function isOperationManager(user?: JwtPayload): boolean {
  if (!user) return false;
  const roleNameLower = (user.roleName ?? '').toLowerCase();
  const permissions = user.permissions ?? [];
  return (
    roleNameLower.includes('admin') ||
    roleNameLower.includes('超级管理员') ||
    permissions.includes('*') ||
    permissions.includes('ALL') ||
    permissions.includes('ADMIN_FULL') ||
    permissions.includes('VIEW_OPERATION_DASHBOARD') ||
    permissions.includes('MANAGE_OPERATION_LOGS')
  );
}

export function canSubmitOperationDaily(user?: JwtPayload): boolean {
  if (!user) return false;
  const roleName = String(user.roleName ?? '').trim();
  if (roleName === '运营专员' || roleName === '运营主管') return true;
  return hasStrictPermission(user, 'ACTION_OPERATION_DAILY_SUBMIT');
}

export function canViewOperationDailyDetail(user?: JwtPayload): boolean {
  if (!user) return false;
  return hasStrictPermission(user, DASHBOARD_PERMISSION.DAILY);
}

function normalizeRoleText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function collectRoleLikeValues(user: unknown): unknown[] {
  const source = (user ?? {}) as {
    role?: { name?: unknown; code?: unknown } | unknown;
    roleCode?: unknown;
    roleName?: unknown;
    roles?: unknown;
  };
  const values: unknown[] = [source.roleCode, source.roleName];

  if (source.role && typeof source.role === 'object') {
    const role = source.role as { name?: unknown; code?: unknown };
    values.push(role.code, role.name);
  } else {
    values.push(source.role);
  }

  if (Array.isArray(source.roles)) {
    for (const role of source.roles) {
      if (role && typeof role === 'object') {
        const item = role as { name?: unknown; code?: unknown; roleName?: unknown; roleCode?: unknown };
        values.push(item.code, item.name, item.roleCode, item.roleName);
      } else {
        values.push(role);
      }
    }
  }

  return values.filter((value) => value != null && String(value).trim() !== '');
}

export const DAILY_REPORT_ROLE_NAMES = ['运营专员', '运营主管'] as const;

export function isDailyReportRole(roleName?: string | null): boolean {
  return DAILY_REPORT_ROLE_NAMES.includes(String(roleName ?? '').trim() as typeof DAILY_REPORT_ROLE_NAMES[number]);
}

type DailyReportParticipantCandidate = {
  role?: { name?: string | null } | null;
};

export function isDailyReportParticipant(user?: DailyReportParticipantCandidate | null): boolean {
  return isDailyReportRole(user?.role?.name);
}

const dailyReportParticipantWhere = {
  status: UserStatus.ACTIVE,
  role: { name: { in: [...DAILY_REPORT_ROLE_NAMES] } },
};

export function isOperationUser(user?: unknown): boolean {
  const source = (user ?? {}) as DailyReportParticipantCandidate & { permissions?: unknown };
  if (isDailyReportParticipant(source)) return true;
  const operationRoleCodes = new Set([
    'operation',
    'operations',
    'operator',
    'operation_specialist',
    'operations_specialist',
    'operationspecialist',
  ].map(normalizeRoleText));

  const hasOperationRole = collectRoleLikeValues(user).some((value) => {
    const raw = String(value);
    const normalized = normalizeRoleText(raw);
    if (!normalized) return false;
    if (/仓库|warehouse/.test(raw.toLowerCase())) return false;
    return operationRoleCodes.has(normalized) || normalized.includes('operationspecialist');
  });
  if (hasOperationRole) return true;

  const permissions = Array.isArray(source.permissions) ? source.permissions : [];
  return permissions.some((permission) => operationRoleCodes.has(normalizeRoleText(permission)));
}

function assertCanSubmitOperationDaily(user: JwtPayload): void {
  if (!canSubmitOperationDaily(user)) {
    throw Object.assign(new Error('仅运营专员或运营主管可以提交每日登记'), { statusCode: 403 });
  }
}

function todayString(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
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

function diffDays(left: string, right: string): number {
  return Math.floor((dateStringToDbDate(left).getTime() - dateStringToDbDate(right).getTime()) / DAY_MS);
}

function assertMonthString(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    throw new Error('month 格式无效，请使用 YYYY-MM');
  }
  const date = new Date(`${raw}-01T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 7) !== raw) {
    throw new Error('month 日期无效');
  }
  return raw;
}

function monthRange(month: string) {
  const startDate = `${month}-01`;
  const start = dateStringToDbDate(startDate);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  const endDate = end.toISOString().slice(0, 10);
  const days: string[] = [];
  for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
    days.push(date);
  }
  return { startDate, endDate, days };
}

function textSummary(value: string | null | undefined): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  return text.length > OTHER_SUMMARY_MAX_LENGTH ? `${text.slice(0, OTHER_SUMMARY_MAX_LENGTH)}...` : text;
}

function parseTaskType(value: unknown): OperationTaskType {
  const raw = String(value ?? '').trim();
  if (!TASK_TYPES.includes(raw as OperationTaskType)) {
    throw new Error(`taskType 无效，合法值：${TASK_TYPES.join('/')}`);
  }
  return raw as OperationTaskType;
}

function parseReportTaskType(value: unknown): ReportTaskType {
  const taskType = parseTaskType(value);
  if (taskType === OperationTaskType.REVIEW_FIX || taskType === OperationTaskType.AFTER_SALES) {
    throw new Error('当前日报不支持该任务类型');
  }
  if (!REPORT_TASK_TYPES.includes(taskType as ReportTaskType)) {
    throw new Error('当前日报不支持该任务类型');
  }
  return taskType as ReportTaskType;
}

function parsePlatform(value: unknown): OperationPlatform | undefined {
  if (value == null || value === '') return undefined;
  const raw = String(value).trim();
  if (!PLATFORMS.includes(raw as OperationPlatform)) {
    throw new Error(`platform 无效，合法值：${PLATFORMS.join('/')}`);
  }
  return raw as OperationPlatform;
}

function parseStatus(value: unknown): OperationLogStatus {
  if (value == null || value === '') return OperationLogStatus.DONE;
  const raw = String(value).trim();
  if (!LOG_STATUSES.includes(raw as OperationLogStatus)) {
    throw new Error(`status 无效，合法值：${LOG_STATUSES.join('/')}`);
  }
  return raw as OperationLogStatus;
}

function parseOptionalShopId(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('shopId 必须是正整数');
  }
  return n;
}

function parseQuantity(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('quantity 必须是非负整数');
  }
  return n;
}

function parseOptionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function parseLinks(value: unknown): Prisma.InputJsonValue | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('links 必须是字符串数组');
  }
  const links = value.map((item) => String(item).trim()).filter(Boolean);
  return links;
}

function assertBackfillAllowed(workDate: string, user: JwtPayload): void {
  if (isOperationManager(user)) return;
  const daysAgo = diffDays(todayString(), workDate);
  if (daysAgo > 7) {
    throw new Error('普通员工只能补录近 7 天的运营登记');
  }
}

function taskCounts() {
  return {
    productSelectionCount: 0,
    productListingCount: 0,
    approvedCount: 0,
    shipmentCount: 0,
    otherCount: 0,
  };
}

function defaultReportItem(taskType: ReportTaskType) {
  return {
    taskType,
    taskName: REPORT_TASK_NAMES[taskType],
    quantity: 0,
    links: [] as string[],
    detail: null as string | null,
    blockerReason: null as string | null,
    score: 0,
  };
}

function normalizeReportItems(inputItems: unknown): Array<{
  taskType: ReportTaskType;
  quantity: number;
  status: OperationLogStatus;
  detail?: string;
  linksJson: Prisma.InputJsonValue;
  blockerReason?: string;
}> {
  const rawItems = inputItems == null ? [] : inputItems;
  if (!Array.isArray(rawItems)) {
    throw new Error('items 必须是数组');
  }

  const normalized = new Map<ReportTaskType, {
    taskType: ReportTaskType;
    quantity: number;
    status: OperationLogStatus;
    detail?: string;
    linksJson: Prisma.InputJsonValue;
    blockerReason?: string;
  }>();

  for (const item of rawItems as OperationDailyReportItemInput[]) {
    const taskType = parseReportTaskType(item?.taskType);
    if (normalized.has(taskType)) {
      throw new Error(`taskType ${taskType} 重复提交`);
    }
    const quantity = item.quantity == null || item.quantity === '' ? 0 : parseQuantity(item.quantity);
    const linksJson = parseLinks(item.links) ?? [];
    const detail = parseOptionalString(item.detail);
    const blockerReason = parseOptionalString(item.blockerReason);
    normalized.set(taskType, {
      taskType,
      quantity,
      status: blockerReason ? OperationLogStatus.BLOCKED : OperationLogStatus.DONE,
      detail,
      linksJson,
      blockerReason,
    });
  }

  return REPORT_TASK_TYPES.map((taskType) => (
    normalized.get(taskType) ?? {
      taskType,
      quantity: 0,
      status: OperationLogStatus.DONE,
      linksJson: [],
    }
  ));
}

function buildReportItems(logs: Array<{
  taskType: OperationTaskType;
  quantity: number;
  detail: string | null;
  linksJson: Prisma.JsonValue | null;
  blockerReason: string | null;
}>) {
  const latestByTask = new Map<ReportTaskType, typeof logs[number]>();
  for (const log of logs) {
    if (!REPORT_TASK_TYPES.includes(log.taskType as ReportTaskType)) continue;
    latestByTask.set(log.taskType as ReportTaskType, log);
  }

  return REPORT_TASK_TYPES.map((taskType) => {
    const log = latestByTask.get(taskType);
    if (!log) return defaultReportItem(taskType);
    const quantity = log.quantity;
    return {
      taskType,
      taskName: REPORT_TASK_NAMES[taskType],
      quantity,
      links: Array.isArray(log.linksJson) ? log.linksJson : [],
      detail: log.detail,
      blockerReason: log.blockerReason,
      score: quantity * OPERATION_SCORE_RULES[taskType],
    };
  });
}

function formatReport(report: {
  id: number;
  userId: number;
  workDate: Date;
  editCount: number;
  submittedAt: Date;
  lastEditedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  logs: Array<{
    taskType: OperationTaskType;
    quantity: number;
    detail: string | null;
    linksJson: Prisma.JsonValue | null;
    blockerReason: string | null;
  }>;
}) {
  return {
    reportId: report.id,
    userId: report.userId,
    workDate: report.workDate.toISOString().slice(0, 10),
    submitted: true,
    canEdit: report.editCount < MAX_REPORT_EDIT_COUNT,
    editCount: report.editCount,
    maxEditCount: MAX_REPORT_EDIT_COUNT,
    submittedAt: report.submittedAt,
    lastEditedAt: report.lastEditedAt,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    items: buildReportItems(report.logs),
  };
}

function emptyReportDto(userId: number, workDate: string) {
  return {
    reportId: null,
    userId,
    workDate,
    submitted: false,
    canEdit: true,
    editCount: 0,
    maxEditCount: MAX_REPORT_EDIT_COUNT,
    submittedAt: null,
    lastEditedAt: null,
    createdAt: null,
    updatedAt: null,
    items: REPORT_TASK_TYPES.map(defaultReportItem),
  };
}

function formatLog(log: {
  id: number;
  userId: number;
  workDate: Date;
  taskType: OperationTaskType;
  platform: OperationPlatform | null;
  shopId: number | null;
  quantity: number;
  status: OperationLogStatus;
  detail: string | null;
  linksJson: Prisma.JsonValue | null;
  blockerReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  shop?: { id: number; shopName: string; region: string | null } | null;
}) {
  return {
    id: log.id,
    userId: log.userId,
    workDate: log.workDate.toISOString().slice(0, 10),
    taskType: log.taskType,
    platform: log.platform,
    shopId: log.shopId,
    quantity: log.quantity,
    status: log.status,
    detail: log.detail,
    links: Array.isArray(log.linksJson) ? log.linksJson : [],
    blockerReason: log.blockerReason,
    shop: log.shop ?? null,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
}

export async function createOperationDailyLog(user: JwtPayload, input: CreateOperationDailyLogInput) {
  assertCanSubmitOperationDaily(user);
  const workDateString = assertDateString(input.workDate, 'workDate');
  const taskType = parseTaskType(input.taskType);
  const platform = parsePlatform(input.platform);
  const shopId = parseOptionalShopId(input.shopId);
  const quantity = parseQuantity(input.quantity);
  const status = parseStatus(input.status);
  const detail = parseOptionalString(input.detail);
  const blockerReason = parseOptionalString(input.blockerReason);
  const linksJson = parseLinks(input.links);

  if (status === OperationLogStatus.BLOCKED && !blockerReason) {
    throw new Error('status=BLOCKED 时 blockerReason 必填');
  }

  assertBackfillAllowed(workDateString, user);

  const created = await prisma.operationDailyLog.create({
    data: {
      userId: user.userId,
      workDate: dateStringToDbDate(workDateString),
      taskType,
      platform,
      shopId,
      quantity,
      status,
      detail,
      linksJson: linksJson ?? Prisma.JsonNull,
      blockerReason,
    },
    include: { shop: { select: { id: true, shopName: true, region: true } } },
  });

  return formatLog(created);
}

export async function submitOperationDailyReport(user: JwtPayload, input: SubmitOperationDailyReportInput) {
  assertCanSubmitOperationDaily(user);
  const workDateString = assertDateString(input.workDate, 'workDate');
  assertBackfillAllowed(workDateString, user);
  const items = normalizeReportItems(input.items);
  const workDate = dateStringToDbDate(workDateString);

  const existing = await prisma.operationDailyReport.findUnique({
    where: { userId_workDate: { userId: user.userId, workDate } },
    select: { id: true },
  });
  if (existing) {
    throw new Error('今日日报已提交，请使用修改接口');
  }

  const report = await prisma.$transaction(async (tx) => {
    const createdReport = await tx.operationDailyReport.create({
      data: {
        userId: user.userId,
        workDate,
      },
    });

    await tx.operationDailyLog.createMany({
      data: items.map((item) => ({
        reportId: createdReport.id,
        userId: user.userId,
        workDate,
        taskType: item.taskType,
        quantity: item.quantity,
        status: item.status,
        detail: item.detail,
        linksJson: item.linksJson,
        blockerReason: item.blockerReason,
      })),
    });

    return tx.operationDailyReport.findUniqueOrThrow({
      where: { id: createdReport.id },
      include: {
        logs: { where: { taskType: { in: [...REPORT_TASK_TYPES] } }, orderBy: { id: 'asc' } },
      },
    });
  });

  return formatReport(report);
}

export async function updateOperationDailyReport(
  user: JwtPayload,
  reportId: number,
  input: SubmitOperationDailyReportInput,
) {
  assertCanSubmitOperationDaily(user);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new Error('reportId 必须是正整数');
  }

  const report = await prisma.operationDailyReport.findUnique({
    where: { id: reportId },
    select: { id: true, userId: true, workDate: true, editCount: true },
  });
  if (!report) {
    throw Object.assign(new Error('日报不存在'), { statusCode: 404 });
  }
  if (report.userId !== user.userId) {
    throw Object.assign(new Error('Phase 1 暂不允许修改别人日报'), { statusCode: 403 });
  }
  if (report.editCount >= MAX_REPORT_EDIT_COUNT) {
    throw new Error('今日日报已提交且修改机会已用完');
  }

  const requestedWorkDate = input.workDate ? assertDateString(input.workDate, 'workDate') : report.workDate.toISOString().slice(0, 10);
  const reportWorkDate = report.workDate.toISOString().slice(0, 10);
  if (requestedWorkDate !== reportWorkDate) {
    throw new Error('修改日报不允许变更 workDate');
  }
  assertBackfillAllowed(reportWorkDate, user);
  const items = normalizeReportItems(input.items);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.operationDailyLog.deleteMany({ where: { reportId: report.id } });
    await tx.operationDailyLog.createMany({
      data: items.map((item) => ({
        reportId: report.id,
        userId: report.userId,
        workDate: report.workDate,
        taskType: item.taskType,
        quantity: item.quantity,
        status: item.status,
        detail: item.detail,
        linksJson: item.linksJson,
        blockerReason: item.blockerReason,
      })),
    });

    return tx.operationDailyReport.update({
      where: { id: report.id },
      data: {
        editCount: { increment: 1 },
        lastEditedAt: new Date(),
      },
      include: {
        logs: { where: { taskType: { in: [...REPORT_TASK_TYPES] } }, orderBy: { id: 'asc' } },
      },
    });
  });

  return formatReport(updated);
}

export async function getMyOperationDailyReport(user: JwtPayload, date?: unknown) {
  return getOperationDailyReportForUser(user.userId, date ?? todayString());
}

export async function getOperationDailyReportForUser(userId: number, date: unknown) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('userId 必须是正整数');
  }
  const workDateString = assertDateString(date, 'date');
  const workDate = dateStringToDbDate(workDateString);
  const report = await prisma.operationDailyReport.findUnique({
    where: { userId_workDate: { userId, workDate } },
    include: {
      logs: { where: { taskType: { in: [...REPORT_TASK_TYPES] } }, orderBy: { id: 'asc' } },
    },
  });

  return report ? formatReport(report) : emptyReportDto(userId, workDateString);
}

export async function getMyTodayOperationLogs(user: JwtPayload) {
  return getUserLogsForDate(user.userId, todayString());
}

export async function getUserLogsForDate(userId: number, date: string) {
  const workDateString = assertDateString(date, 'date');
  const logs = await prisma.operationDailyLog.findMany({
    where: { userId, workDate: dateStringToDbDate(workDateString) },
    orderBy: { createdAt: 'desc' },
    include: { shop: { select: { id: true, shopName: true, region: true } } },
  });
  return logs.map(formatLog);
}

export async function getOperationDailyDashboard(params: { user: JwtPayload; date?: unknown; range?: unknown }) {
  const targetDate = params.date ? assertDateString(params.date, 'date') : todayString();
  const range = String(params.range ?? '7d').trim();
  if (range !== '7d' && range !== '30d') {
    throw new Error('range 无效，合法值：7d/30d');
  }
  const rangeDays = range === '30d' ? 30 : 7;
  const startDate = addDays(targetDate, -(rangeDays - 1));

  const [activeUsers, dayReports, dayLogs, rangeLogs] = await Promise.all([
    prisma.user.findMany({
      where: dailyReportParticipantWhere,
      select: { id: true, name: true, role: { select: { name: true } } },
      orderBy: { id: 'asc' },
    }),
    prisma.operationDailyReport.findMany({
      where: { workDate: dateStringToDbDate(targetDate) },
      select: { id: true, userId: true, editCount: true },
    }),
    prisma.operationDailyLog.findMany({
      where: { workDate: dateStringToDbDate(targetDate), taskType: { in: [...REPORT_TASK_TYPES] } },
      include: { user: { select: { id: true, name: true, role: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.operationDailyLog.findMany({
      where: {
        taskType: { in: [...REPORT_TASK_TYPES] },
        workDate: {
          gte: dateStringToDbDate(startDate),
          lte: dateStringToDbDate(targetDate),
        },
      },
      select: { userId: true, workDate: true, taskType: true, quantity: true },
    }),
  ]);

  const operationUsers = activeUsers;
  const operationUserIds = new Set(operationUsers.map((user) => user.id));
  const reportsByUser = new Map(
    dayReports
      .filter((report) => operationUserIds.has(report.userId))
      .map((report) => [report.userId, report]),
  );
  const dayLogsByUser = new Map<number, typeof dayLogs>();
  for (const log of dayLogs) {
    if (!operationUserIds.has(log.userId)) continue;
    const list = dayLogsByUser.get(log.userId) ?? [];
    list.push(log);
    dayLogsByUser.set(log.userId, list);
  }

  const registeredUserIds = new Set(reportsByUser.keys());
  const summaryCards = {
    registeredUserCount: registeredUserIds.size,
    unregisteredUserCount: Math.max(0, operationUsers.length - registeredUserIds.size),
    productSelectionCount: 0,
    productListingCount: 0,
    approvedCount: 0,
    shipmentCount: 0,
    otherCount: 0,
  };

  for (const log of dayLogs) {
    if (!operationUserIds.has(log.userId)) continue;
    const key = TASK_COUNT_KEY[log.taskType];
    summaryCards[key] += log.quantity;
  }

  const employeeRankings = operationUsers.map((user) => {
    const logs = dayLogsByUser.get(user.id) ?? [];
    const counts = taskCounts();
    let totalQuantity = 0;
    let score = 0;
    let hasBlockedTask = false;

    for (const log of logs) {
      counts[TASK_COUNT_KEY[log.taskType]] += log.quantity;
      totalQuantity += log.quantity;
      score += log.quantity * OPERATION_SCORE_RULES[log.taskType];
      if (log.status === OperationLogStatus.BLOCKED) hasBlockedTask = true;
    }

    return {
      userId: user.id,
      name: user.name,
      roleName: user.role.name,
      registered: registeredUserIds.has(user.id),
      ...counts,
      totalQuantity,
      score,
      hasBlockedTask,
      canEditTodayReport: (reportsByUser.get(user.id)?.editCount ?? MAX_REPORT_EDIT_COUNT) < MAX_REPORT_EDIT_COUNT,
    };
  }).sort((a, b) => b.score - a.score || b.totalQuantity - a.totalQuantity || a.userId - b.userId);

  const missingUsers = operationUsers
    .filter((user) => !registeredUserIds.has(user.id))
    .map((user) => ({ userId: user.id, name: user.name }));

  const zeroOutputUsers = employeeRankings
    .filter((row) => row.registered && row.totalQuantity === 0)
    .map((row) => ({ userId: row.userId, name: row.name }));

  const blockedItems = dayLogs
    .filter((log) => operationUserIds.has(log.userId) && (log.status === OperationLogStatus.BLOCKED || Boolean(log.blockerReason?.trim())))
    .map((log) => ({
      id: log.id,
      reportId: log.reportId,
      userId: log.userId,
      name: log.user.name,
      taskType: log.taskType,
      blockerReason: log.blockerReason,
    }));

  const trendMap = new Map<string, {
    productSelectionCount: number;
    productListingCount: number;
    approvedCount: number;
    shipmentCount: number;
    otherCount: number;
  }>();

  for (let i = 0; i < rangeDays; i++) {
    trendMap.set(addDays(startDate, i), {
      productSelectionCount: 0,
      productListingCount: 0,
      approvedCount: 0,
      shipmentCount: 0,
      otherCount: 0,
    });
  }

  for (const log of rangeLogs) {
    if (!operationUserIds.has(log.userId)) continue;
    const date = log.workDate.toISOString().slice(0, 10);
    const item = trendMap.get(date);
    if (!item) continue;
    if (log.taskType === OperationTaskType.PRODUCT_SELECTION) item.productSelectionCount += log.quantity;
    if (log.taskType === OperationTaskType.PRODUCT_LISTING) item.productListingCount += log.quantity;
    if (log.taskType === OperationTaskType.APPROVED_COUNT) item.approvedCount += log.quantity;
    if (log.taskType === OperationTaskType.SHIPMENT_COUNT) item.shipmentCount += log.quantity;
    if (log.taskType === OperationTaskType.OTHER) item.otherCount += log.quantity;
  }

  const trendSeries = [...trendMap.entries()].map(([date, item]) => ({ date, ...item }));

  return {
    date: targetDate,
    range,
    summaryCards,
    employeeRankings,
    missingUsers,
    zeroOutputUsers,
    blockedItems,
    trendSeries,
  };
}

export async function getOperationDailyMonthlyOverview(params: { user: JwtPayload; month?: unknown }) {
  const month = params.month ? assertMonthString(params.month) : todayString().slice(0, 7);
  const { startDate, endDate, days } = monthRange(month);
  const today = todayString();
  const yesterday = addDays(today, -1);
  const monthStart = dateStringToDbDate(startDate);
  const monthEnd = dateStringToDbDate(endDate);
  const yesterdayDate = dateStringToDbDate(yesterday);

  const [activeUsers, monthReports, monthLogs, yesterdayReports, workdayStatusMap, yesterdayWorkdayStatus] = await Promise.all([
    prisma.user.findMany({
      where: dailyReportParticipantWhere,
      select: { id: true, name: true, role: { select: { name: true } } },
      orderBy: { id: 'asc' },
    }),
    prisma.operationDailyReport.findMany({
      where: {
        workDate: {
          gte: monthStart,
          lte: monthEnd,
        },
      },
      select: { id: true, userId: true, workDate: true, editCount: true },
    }),
    prisma.operationDailyLog.findMany({
      where: {
        workDate: {
          gte: monthStart,
          lte: monthEnd,
        },
        taskType: { in: [...REPORT_TASK_TYPES] },
      },
      select: {
        reportId: true,
        userId: true,
        workDate: true,
        taskType: true,
        quantity: true,
        detail: true,
        blockerReason: true,
      },
    }),
    prisma.operationDailyReport.findMany({
      where: { workDate: yesterdayDate },
      select: { userId: true },
    }),
    getWorkdayStatusMap(startDate, endDate),
    getWorkdayStatusForDate(yesterday),
  ]);

  const operationUsers = activeUsers;
  const operationUserIds = new Set(operationUsers.map((user) => user.id));
  const reportMap = new Map<string, { id: number; userId: number; workDate: Date; editCount: number }>();
  for (const report of monthReports) {
    if (!operationUserIds.has(report.userId)) continue;
    reportMap.set(`${report.userId}:${report.workDate.toISOString().slice(0, 10)}`, report);
  }

  const logMap = new Map<string, typeof monthLogs[number]>();
  const logsByUser = new Map<number, typeof monthLogs>();
  const summaryCards = {
    yesterdayRegisteredCount: 0,
    yesterdayMissingCount: 0,
    monthlyProductSelectionCount: 0,
    monthlyProductListingCount: 0,
    monthlyApprovedCount: 0,
    monthlyShipmentCount: 0,
  };

  for (const log of monthLogs) {
    if (!operationUserIds.has(log.userId)) continue;
    const date = log.workDate.toISOString().slice(0, 10);
    logMap.set(`${log.userId}:${date}:${log.taskType}`, log);
    const list = logsByUser.get(log.userId) ?? [];
    list.push(log);
    logsByUser.set(log.userId, list);

    if (log.taskType === OperationTaskType.PRODUCT_SELECTION) summaryCards.monthlyProductSelectionCount += log.quantity;
    if (log.taskType === OperationTaskType.PRODUCT_LISTING) summaryCards.monthlyProductListingCount += log.quantity;
    if (log.taskType === OperationTaskType.APPROVED_COUNT) summaryCards.monthlyApprovedCount += log.quantity;
    if (log.taskType === OperationTaskType.SHIPMENT_COUNT) summaryCards.monthlyShipmentCount += log.quantity;
  }

  const yesterdayRegisteredUserIds = new Set(
    yesterdayReports
      .filter((report) => operationUserIds.has(report.userId))
      .map((report) => report.userId),
  );

  let yesterdayMissingUsers: Array<{ userId: number; name: string; roleName: string }> = [];
  let yesterdayRequired = false;
  let yesterdayMessage: string | null = null;

  if (yesterdayWorkdayStatus === WorkdayStatus.WORKDAY) {
    yesterdayRequired = true;
    summaryCards.yesterdayRegisteredCount = yesterdayRegisteredUserIds.size;
    summaryCards.yesterdayMissingCount = Math.max(0, operationUsers.length - yesterdayRegisteredUserIds.size);
    yesterdayMissingUsers = operationUsers
      .filter((user) => !yesterdayRegisteredUserIds.has(user.id))
      .map((user) => ({
        userId: user.id,
        name: user.name,
        roleName: user.role.name,
      }));
  } else if (yesterdayWorkdayStatus === WorkdayStatus.REST) {
    summaryCards.yesterdayRegisteredCount = 0;
    summaryCards.yesterdayMissingCount = 0;
    yesterdayMessage = '昨日为休息日，无需登记';
  } else {
    summaryCards.yesterdayRegisteredCount = 0;
    summaryCards.yesterdayMissingCount = 0;
    yesterdayMessage = '昨日运营日历待定，暂不统计未登记';
  }

  const monthlyScores = operationUsers.map((user) => {
    const counts = taskCounts();
    const scoreBreakdown = {
      productSelectionScore: 0,
      productListingScore: 0,
      approvedScore: 0,
      shipmentScore: 0,
      otherScore: 0,
    };
    let monthlyScore = 0;

    for (const log of logsByUser.get(user.id) ?? []) {
      counts[TASK_COUNT_KEY[log.taskType]] += log.quantity;
      const score = log.quantity * OPERATION_SCORE_RULES[log.taskType];
      monthlyScore += score;
      if (log.taskType === OperationTaskType.PRODUCT_SELECTION) scoreBreakdown.productSelectionScore += score;
      if (log.taskType === OperationTaskType.PRODUCT_LISTING) scoreBreakdown.productListingScore += score;
      if (log.taskType === OperationTaskType.APPROVED_COUNT) scoreBreakdown.approvedScore += score;
      if (log.taskType === OperationTaskType.SHIPMENT_COUNT) scoreBreakdown.shipmentScore += score;
    }

    return {
      userId: user.id,
      name: user.name,
      roleName: user.role.name,
      score: monthlyScore,
      monthlyScore,
      rank: 0,
      scoreText: '本月累计',
      scoreBreakdown: {
        ...counts,
        ...scoreBreakdown,
      },
    };
  }).sort((a, b) => b.monthlyScore - a.monthlyScore || a.userId - b.userId);

  const monthlyScoreTop = monthlyScores.slice(0, 5).map((item, index) => ({
    ...item,
    rank: index + 1,
  }));

  const employees = operationUsers.map((user) => ({
    userId: user.id,
    name: user.name,
    roleName: user.role.name,
    rows: DAILY_TASK_METRICS.map((metric) => {
      let total = 0;
      const dailyValues = days.map((date) => {
        const isFuture = date > today;
        const workdayStatus = workdayStatusMap.get(date) ?? WorkdayStatus.PENDING;
        const registrationRequired = workdayStatus === WorkdayStatus.WORKDAY;
        const report = reportMap.get(`${user.id}:${date}`);
        const log = logMap.get(`${user.id}:${date}:${metric.taskType}`);

        if (isFuture) {
          return {
            date,
            workdayStatus,
            registrationRequired,
            displayStatus: 'FUTURE' as const,
            missingRequired: false,
            value: null as number | null,
            text: null as string | null,
            submitted: false,
            isFuture,
            reportId: null as number | null,
          };
        }

        if (workdayStatus === WorkdayStatus.REST) {
          return {
            date,
            workdayStatus,
            registrationRequired: false,
            displayStatus: 'REST' as const,
            missingRequired: false,
            value: report && log ? (metric.valueType === 'text' ? log.quantity : log.quantity) : null,
            text: report && metric.valueType === 'text' ? textSummary(log?.detail) : null,
            submitted: Boolean(report),
            isFuture,
            reportId: report?.id ?? null,
          };
        }

        if (workdayStatus === WorkdayStatus.PENDING) {
          return {
            date,
            workdayStatus,
            registrationRequired: false,
            displayStatus: 'PENDING' as const,
            missingRequired: false,
            value: report && log ? log.quantity : null,
            text: report && metric.valueType === 'text' ? textSummary(log?.detail) : null,
            submitted: Boolean(report),
            isFuture,
            reportId: report?.id ?? null,
          };
        }

        if (!report) {
          return {
            date,
            workdayStatus,
            registrationRequired: true,
            displayStatus: 'MISSING' as const,
            missingRequired: true,
            value: null as number | null,
            text: null as string | null,
            submitted: false,
            isFuture,
            reportId: null as number | null,
          };
        }

        if (metric.valueType === 'text') {
          return {
            date,
            workdayStatus,
            registrationRequired: true,
            displayStatus: 'SUBMITTED' as const,
            missingRequired: false,
            value: log?.quantity ?? null,
            text: textSummary(log?.detail),
            submitted: true,
            isFuture,
            reportId: report.id,
          };
        }

        const value = log?.quantity ?? 0;
        total += value;
        return {
          date,
          workdayStatus,
          registrationRequired: true,
          displayStatus: 'SUBMITTED' as const,
          missingRequired: false,
          value,
          text: null as string | null,
          submitted: true,
          isFuture,
          reportId: report.id,
        };
      });

      return {
        metricType: metric.taskType,
        metricName: metric.metricName,
        dailyValues,
        total: metric.valueType === 'text' ? '—' : total,
      };
    }),
  }));

  return {
    summaryCards,
    yesterdayMissingUsers,
    yesterdayWorkdayStatus,
    yesterdayRequired,
    yesterdayMessage,
    monthlyScoreTop,
    heatmap: {
      month,
      days,
      employees,
    },
  };
}
