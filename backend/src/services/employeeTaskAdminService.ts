import {
  EmployeeTaskStatus,
  OperationPlatform,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import {
  employeeTaskListInclude,
  formatEmployeeTaskDto,
  normalizeWeekStartInput,
} from './employeeTaskService';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 100;
const PLATFORMS = Object.values(OperationPlatform);

export type AdminStatusFilter = 'ALL' | 'PENDING' | 'DONE' | 'OVERDUE' | 'CANCELLED';
export type AdminPlatformFilter = OperationPlatform | 'ALL';

export type AdminTaskQuery = {
  weekStart?: unknown;
  assigneeId?: unknown;
  status?: unknown;
  platform?: unknown;
  page?: unknown;
  pageSize?: unknown;
};

type ParsedAdminQuery = {
  weekStart: string;
  weekEnd: string;
  start: Date;
  end: Date;
  assigneeId?: number;
  status: AdminStatusFilter;
  platform: AdminPlatformFilter;
  page: number;
  pageSize: number;
  skip: number;
};

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function resolveAdminWeekRange(weekStartInput?: unknown) {
  const weekStart = normalizeWeekStartInput(weekStartInput);
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 7 * DAY_MS - 1);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    start,
    end,
  };
}

function parseOptionalAssigneeId(value: unknown): number | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('assigneeId 必须是正整数');
  }
  return parsed;
}

function parseAdminStatus(value: unknown): AdminStatusFilter {
  const raw = String(value ?? 'ALL').trim().toUpperCase();
  if (raw === 'ALL' || raw === 'PENDING' || raw === 'DONE' || raw === 'OVERDUE' || raw === 'CANCELLED') {
    return raw;
  }
  throw new Error('status 无效，合法值：ALL/PENDING/DONE/OVERDUE/CANCELLED');
}

function parseAdminPlatform(value: unknown): AdminPlatformFilter {
  const raw = String(value ?? 'ALL').trim().toUpperCase();
  if (raw === 'ALL') return 'ALL';
  if (!PLATFORMS.includes(raw as OperationPlatform)) {
    throw new Error('platform 无效');
  }
  return raw as OperationPlatform;
}

function parsePagination(query: Pick<AdminTaskQuery, 'page' | 'pageSize'>) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const requestedPageSize = Number.parseInt(String(query.pageSize ?? '20'), 10) || 20;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, requestedPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function parseAdminQuery(query: AdminTaskQuery): ParsedAdminQuery {
  const range = resolveAdminWeekRange(query.weekStart);
  const pagination = parsePagination(query);
  return {
    ...range,
    assigneeId: parseOptionalAssigneeId(query.assigneeId),
    status: parseAdminStatus(query.status),
    platform: parseAdminPlatform(query.platform),
    ...pagination,
  };
}

function buildWeekScopeWhere(start: Date, end: Date): Prisma.EmployeeTaskWhereInput {
  return {
    OR: [
      { dueDate: { gte: start, lte: end } },
      { createdAt: { gte: start, lte: end } },
      { completedAt: { gte: start, lte: end } },
      { cancelledAt: { gte: start, lte: end } },
    ],
  };
}

function buildPendingStatusWhere(now = new Date()): Prisma.EmployeeTaskWhereInput {
  return {
    status: { in: [EmployeeTaskStatus.TODO, EmployeeTaskStatus.IN_PROGRESS] },
    dueDate: { gte: now },
  };
}

function buildOverdueStatusWhere(now = new Date()): Prisma.EmployeeTaskWhereInput {
  return {
    status: { notIn: [EmployeeTaskStatus.DONE, EmployeeTaskStatus.CANCELLED] },
    dueDate: { lt: now },
  };
}

function buildAdminStatusWhere(status: AdminStatusFilter, now = new Date()): Prisma.EmployeeTaskWhereInput | null {
  switch (status) {
    case 'ALL':
      return null;
    case 'PENDING':
      return buildPendingStatusWhere(now);
    case 'DONE':
      return { status: EmployeeTaskStatus.DONE };
    case 'CANCELLED':
      return { status: EmployeeTaskStatus.CANCELLED };
    case 'OVERDUE':
      return buildOverdueStatusWhere(now);
    default:
      return null;
  }
}

function buildAdminBaseWhere(params: ParsedAdminQuery): Prisma.EmployeeTaskWhereInput {
  const and: Prisma.EmployeeTaskWhereInput[] = [
    buildWeekScopeWhere(params.start, params.end),
  ];
  if (params.assigneeId) {
    and.push({ assigneeId: params.assigneeId });
  }
  if (params.platform !== 'ALL') {
    and.push({ platform: params.platform });
  }
  return { AND: and };
}

function buildAdminTaskWhere(params: ParsedAdminQuery): Prisma.EmployeeTaskWhereInput {
  const and: Prisma.EmployeeTaskWhereInput[] = [buildAdminBaseWhere(params)];
  const statusWhere = buildAdminStatusWhere(params.status);
  if (statusWhere) {
    and.push(statusWhere);
  }
  return { AND: and };
}

function calcCompletionRate(doneCount: number, totalTaskCount: number): number {
  if (totalTaskCount <= 0) return 0;
  return Math.round((doneCount / totalTaskCount) * 10000) / 100;
}

async function buildSummaryCards(params: ParsedAdminQuery) {
  const baseWhere = buildAdminBaseWhere(params);
  const filteredWhere = buildAdminTaskWhere(params);
  const now = new Date();

  if (params.status !== 'ALL') {
    const totalTaskCount = await prisma.employeeTask.count({ where: filteredWhere });
    const assigneeGroups = await prisma.employeeTask.groupBy({
      by: ['assigneeId'],
      where: filteredWhere,
      _count: { _all: true },
    });

    const doneCount = params.status === 'DONE' ? totalTaskCount : 0;
    const pendingCount = params.status === 'PENDING' ? totalTaskCount : 0;
    const overdueCount = params.status === 'OVERDUE' ? totalTaskCount : 0;

    return {
      employeeCount: assigneeGroups.length,
      totalTaskCount,
      doneCount,
      pendingCount,
      overdueCount,
      completionRate: calcCompletionRate(doneCount, totalTaskCount),
    };
  }

  const [totalTaskCount, doneCount, pendingCount, overdueCount, assigneeGroups] = await Promise.all([
    prisma.employeeTask.count({ where: baseWhere }),
    prisma.employeeTask.count({
      where: { AND: [baseWhere, { status: EmployeeTaskStatus.DONE }] },
    }),
    prisma.employeeTask.count({
      where: { AND: [baseWhere, buildPendingStatusWhere(now)] },
    }),
    prisma.employeeTask.count({
      where: { AND: [baseWhere, buildOverdueStatusWhere(now)] },
    }),
    prisma.employeeTask.groupBy({
      by: ['assigneeId'],
      where: baseWhere,
      _count: { _all: true },
    }),
  ]);

  return {
    employeeCount: assigneeGroups.length,
    totalTaskCount,
    doneCount,
    pendingCount,
    overdueCount,
    completionRate: calcCompletionRate(doneCount, totalTaskCount),
  };
}

async function loadAssigneeProfiles(assigneeIds: number[]) {
  if (assigneeIds.length === 0) return new Map<number, { userId: number; name: string; username: string; roleName: string }>();

  const users = await prisma.user.findMany({
    where: { id: { in: assigneeIds } },
    select: {
      id: true,
      name: true,
      username: true,
      role: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });

  return new Map(
    users.map((user) => [
      user.id,
      {
        userId: user.id,
        name: user.name,
        username: user.username,
        roleName: user.role.name,
      },
    ]),
  );
}

async function buildEmployeeSummaries(params: ParsedAdminQuery) {
  const baseWhere = buildAdminBaseWhere(params);
  const filteredWhere = buildAdminTaskWhere(params);
  const now = new Date();

  if (params.status !== 'ALL') {
    const groups = await prisma.employeeTask.groupBy({
      by: ['assigneeId'],
      where: filteredWhere,
      _count: { _all: true },
    });

    const profiles = await loadAssigneeProfiles(groups.map((group) => group.assigneeId));
    return groups
      .map((group) => {
        const profile = profiles.get(group.assigneeId);
        const totalTaskCount = group._count._all;
        const doneCount = params.status === 'DONE' ? totalTaskCount : 0;
        const pendingCount = params.status === 'PENDING' ? totalTaskCount : 0;
        const overdueCount = params.status === 'OVERDUE' ? totalTaskCount : 0;
        return {
          userId: group.assigneeId,
          name: profile?.name ?? `用户#${group.assigneeId}`,
          username: profile?.username,
          roleName: profile?.roleName,
          totalTaskCount,
          doneCount,
          pendingCount,
          overdueCount,
          completionRate: calcCompletionRate(doneCount, totalTaskCount),
        };
      })
      .sort((a, b) => b.totalTaskCount - a.totalTaskCount || a.userId - b.userId);
  }

  const [statusGroups, pendingGroups, overdueGroups] = await Promise.all([
    prisma.employeeTask.groupBy({
      by: ['assigneeId', 'status'],
      where: baseWhere,
      _count: { _all: true },
    }),
    prisma.employeeTask.groupBy({
      by: ['assigneeId'],
      where: { AND: [baseWhere, buildPendingStatusWhere(now)] },
      _count: { _all: true },
    }),
    prisma.employeeTask.groupBy({
      by: ['assigneeId'],
      where: { AND: [baseWhere, buildOverdueStatusWhere(now)] },
      _count: { _all: true },
    }),
  ]);

  const summaryMap = new Map<number, {
    totalTaskCount: number;
    doneCount: number;
    pendingCount: number;
    overdueCount: number;
  }>();

  for (const group of statusGroups) {
    const current = summaryMap.get(group.assigneeId) ?? {
      totalTaskCount: 0,
      doneCount: 0,
      pendingCount: 0,
      overdueCount: 0,
    };
    current.totalTaskCount += group._count._all;
    if (group.status === EmployeeTaskStatus.DONE) {
      current.doneCount += group._count._all;
    }
    summaryMap.set(group.assigneeId, current);
  }

  for (const group of pendingGroups) {
    const current = summaryMap.get(group.assigneeId) ?? {
      totalTaskCount: 0,
      doneCount: 0,
      pendingCount: 0,
      overdueCount: 0,
    };
    current.pendingCount = group._count._all;
    summaryMap.set(group.assigneeId, current);
  }

  for (const group of overdueGroups) {
    const current = summaryMap.get(group.assigneeId) ?? {
      totalTaskCount: 0,
      doneCount: 0,
      pendingCount: 0,
      overdueCount: 0,
    };
    current.overdueCount = group._count._all;
    summaryMap.set(group.assigneeId, current);
  }

  const profiles = await loadAssigneeProfiles([...summaryMap.keys()]);
  return [...summaryMap.entries()]
    .map(([assigneeId, stats]) => {
      const profile = profiles.get(assigneeId);
      return {
        userId: assigneeId,
        name: profile?.name ?? `用户#${assigneeId}`,
        username: profile?.username,
        roleName: profile?.roleName,
        totalTaskCount: stats.totalTaskCount,
        doneCount: stats.doneCount,
        pendingCount: stats.pendingCount,
        overdueCount: stats.overdueCount,
        completionRate: calcCompletionRate(stats.doneCount, stats.totalTaskCount),
      };
    })
    .sort((a, b) => b.totalTaskCount - a.totalTaskCount || a.userId - b.userId);
}

export async function getAdminEmployeeTaskDashboard(_user: JwtPayload, query: AdminTaskQuery) {
  const params = parseAdminQuery(query);
  const summaryCards = await buildSummaryCards(params);
  return { summaryCards };
}

export async function getAdminEmployeeUsersSummary(_user: JwtPayload, query: AdminTaskQuery) {
  const params = parseAdminQuery(query);
  return buildEmployeeSummaries(params);
}

export async function listAdminEmployeeTasks(_user: JwtPayload, query: AdminTaskQuery) {
  const params = parseAdminQuery(query);
  const where = buildAdminTaskWhere(params);

  const [total, tasks] = await Promise.all([
    prisma.employeeTask.count({ where }),
    prisma.employeeTask.findMany({
      where,
      include: employeeTaskListInclude(),
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      skip: params.skip,
      take: params.pageSize,
    }),
  ]);

  return {
    list: tasks.map(formatEmployeeTaskDto),
    total,
    page: params.page,
    pageSize: params.pageSize,
  };
}
