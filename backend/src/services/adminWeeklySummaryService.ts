import { EmployeeWeeklyAiSummaryStatus, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import { normalizeWeekStartInput } from './employeeTaskService';
import {
  AiSummaryJson,
  generateWeeklyAiSummary,
  isWeeklyAiEnabled,
} from './weeklyAiSummaryService';

const PREVIEW_MAX = 120;

export type AdminWeeklySummaryStatus = 'NONE' | 'GENERATING' | 'SUCCESS' | 'FAILED';

export type AdminWeeklySummaryListItem = {
  id: number | null;
  assigneeId: number;
  assigneeName: string;
  username: string;
  roleName: string;
  weekStart: string;
  weekEnd: string;
  status: AdminWeeklySummaryStatus;
  summaryPreview: string | null;
  summaryText: string | null;
  completedSummary: string | null;
  pendingSummary: string | null;
  problemSummary: string | null;
  suggestionSummary: string | null;
  nextWeekPlan: string | null;
  generatedAt: string | null;
  updatedAt: string | null;
  errorMessage: string | null;
};

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: string, days: number): string {
  const d = dateStringToDbDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseOptionalAssigneeId(value: unknown): number | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('assigneeId 必须是正整数');
  }
  return parsed;
}

function mapDbStatusToApi(status: EmployeeWeeklyAiSummaryStatus | null | undefined): AdminWeeklySummaryStatus {
  if (!status) return 'NONE';
  if (status === EmployeeWeeklyAiSummaryStatus.PENDING) return 'GENERATING';
  if (status === EmployeeWeeklyAiSummaryStatus.READY) return 'SUCCESS';
  if (status === EmployeeWeeklyAiSummaryStatus.FAILED) return 'FAILED';
  return 'NONE';
}

function joinTextParts(parts: Array<string | null | undefined>, separator = '；'): string | null {
  const text = parts.map((part) => String(part ?? '').trim()).filter(Boolean).join(separator);
  return text || null;
}

function mapSummaryJsonToAdminFields(summaryJson: unknown) {
  if (!summaryJson || typeof summaryJson !== 'object' || Array.isArray(summaryJson)) {
    return {
      summaryPreview: null,
      summaryText: null,
      completedSummary: null,
      pendingSummary: null,
      problemSummary: null,
      suggestionSummary: null,
      nextWeekPlan: null,
    };
  }

  const summary = summaryJson as Partial<AiSummaryJson>;
  const overview = String(summary.overview ?? '').trim();
  const completionAnalysis = String(summary.completionAnalysis ?? '').trim();
  const highlights = Array.isArray(summary.highlights)
    ? summary.highlights.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const risks = Array.isArray(summary.risks)
    ? summary.risks.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const nextWeekSuggestions = Array.isArray(summary.nextWeekSuggestions)
    ? summary.nextWeekSuggestions.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const summaryText = joinTextParts([overview, completionAnalysis], '\n\n');
  const suggestionText = nextWeekSuggestions.length > 0 ? nextWeekSuggestions.join('；') : null;

  return {
    summaryPreview: overview ? overview.slice(0, PREVIEW_MAX) : null,
    summaryText,
    completedSummary: joinTextParts([...highlights, completionAnalysis]),
    pendingSummary: risks.length > 0 ? risks.join('；') : null,
    problemSummary: risks.length > 0 ? risks.join('；') : null,
    suggestionSummary: suggestionText,
    nextWeekPlan: suggestionText,
  };
}

function buildNonePlaceholder(
  employee: { id: number; name: string; username: string; role: { name: string } },
  weekStart: string,
  weekEnd: string,
): AdminWeeklySummaryListItem {
  return {
    id: null,
    assigneeId: employee.id,
    assigneeName: employee.name,
    username: employee.username,
    roleName: employee.role.name,
    weekStart,
    weekEnd,
    status: 'NONE',
    summaryPreview: null,
    summaryText: null,
    completedSummary: null,
    pendingSummary: null,
    problemSummary: null,
    suggestionSummary: null,
    nextWeekPlan: null,
    generatedAt: null,
    updatedAt: null,
    errorMessage: null,
  };
}

async function loadActiveEmployees(assigneeId?: number) {
  return prisma.user.findMany({
    where: {
      status: UserStatus.ACTIVE,
      ...(assigneeId ? { id: assigneeId } : {}),
    },
    select: {
      id: true,
      username: true,
      name: true,
      roleId: true,
      role: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
}

function toJwtPayload(employee: {
  id: number;
  username: string;
  roleId: number;
  role: { name: string };
}): JwtPayload {
  return {
    userId: employee.id,
    username: employee.username,
    roleId: employee.roleId,
    roleName: employee.role.name,
    permissions: [],
  };
}

async function runAdminWeeklySummaryBatch(
  employees: Awaited<ReturnType<typeof loadActiveEmployees>>,
  weekStart: string,
  force: boolean,
) {
  for (const employee of employees) {
    const pseudoUser = toJwtPayload(employee);
    try {
      await generateWeeklyAiSummary(pseudoUser, { weekStart, force });
    } catch (err) {
      console.error(
        `[admin-weekly-ai] userId=${employee.id} weekStart=${weekStart} batch failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function listAdminWeeklySummaries(query: {
  weekStart?: unknown;
  assigneeId?: unknown;
}) {
  const weekStart = normalizeWeekStartInput(query.weekStart);
  const weekEnd = addDays(weekStart, 6);
  const weekStartDate = dateStringToDbDate(weekStart);
  const assigneeId = parseOptionalAssigneeId(query.assigneeId);

  const employees = await loadActiveEmployees(assigneeId);
  const employeeIds = employees.map((employee) => employee.id);

  const caches = employeeIds.length > 0
    ? await prisma.employeeWeeklyAiSummary.findMany({
      where: {
        weekStart: weekStartDate,
        userId: { in: employeeIds },
      },
    })
    : [];

  const cacheByUserId = new Map(caches.map((cache) => [cache.userId, cache]));

  const list = employees.map((employee) => {
    const cache = cacheByUserId.get(employee.id);
    if (!cache) {
      return buildNonePlaceholder(employee, weekStart, weekEnd);
    }

    const mapped = mapSummaryJsonToAdminFields(cache.summaryJson);
    return {
      id: cache.id,
      assigneeId: employee.id,
      assigneeName: employee.name,
      username: employee.username,
      roleName: employee.role.name,
      weekStart,
      weekEnd,
      status: mapDbStatusToApi(cache.status),
      ...mapped,
      generatedAt: cache.generatedAt?.toISOString() ?? null,
      updatedAt: cache.updatedAt.toISOString(),
      errorMessage: cache.errorMessage ?? null,
    };
  });

  return { list };
}

export async function enqueueAdminWeeklySummaryGeneration(input: {
  weekStart?: unknown;
  assigneeId?: unknown;
  force?: unknown;
}) {
  if (!isWeeklyAiEnabled()) {
    throw Object.assign(new Error('AI 周报未启用，请检查 WEEKLY_AI_ENABLED 与 DEEPSEEK_API_KEY'), { statusCode: 503 });
  }

  const weekStart = normalizeWeekStartInput(input.weekStart);
  const assigneeId = parseOptionalAssigneeId(input.assigneeId);
  const force = input.force === true;
  const employees = await loadActiveEmployees(assigneeId);

  if (employees.length === 0) {
    throw new Error('未找到符合条件的 ACTIVE 员工');
  }

  void runAdminWeeklySummaryBatch(employees, weekStart, force);

  return {
    accepted: true,
    totalEmployees: employees.length,
    queuedCount: employees.length,
  };
}
