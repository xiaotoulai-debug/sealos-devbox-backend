import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import { normalizeWeekStartInput } from './employeeTaskService';

export const WEEKLY_PLAN_MIGRATION_REQUIRED_MESSAGE =
  'employee_weekly_plans 表尚未创建，请先执行数据库 migration';

export const WEEKLY_PLAN_FIELD_MAX_LEN = 2000;

export type EmployeeWeeklyPlanDto = {
  id: number | null;
  weekStart: string;
  nextWeekPlan: string;
  problems: string;
  supportNeeded: string;
  submittedAt: string | null;
  updatedAt: string | null;
};

export type EmployeeWeeklyPlanSourceSlice = {
  nextWeekPlan: string;
  problems: string;
  supportNeeded: string;
  submittedAt: string | null;
};

const EMPTY_PLAN_SLICE: EmployeeWeeklyPlanSourceSlice = {
  nextWeekPlan: '',
  problems: '',
  supportNeeded: '',
  submittedAt: null,
};

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function sanitizePlanField(raw: unknown): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length > WEEKLY_PLAN_FIELD_MAX_LEN) {
    return trimmed.slice(0, WEEKLY_PLAN_FIELD_MAX_LEN);
  }
  return trimmed;
}

function toDto(
  weekStart: string,
  row: {
    id: number;
    nextWeekPlan: string;
    problems: string;
    supportNeeded: string;
    submittedAt: Date | null;
    updatedAt: Date;
  } | null,
): EmployeeWeeklyPlanDto {
  if (!row) {
    return {
      id: null,
      weekStart,
      nextWeekPlan: '',
      problems: '',
      supportNeeded: '',
      submittedAt: null,
      updatedAt: null,
    };
  }
  return {
    id: row.id,
    weekStart,
    nextWeekPlan: row.nextWeekPlan,
    problems: row.problems,
    supportNeeded: row.supportNeeded,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function rethrowWeeklyPlanDbError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2021') {
      const migrationErr = new Error(WEEKLY_PLAN_MIGRATION_REQUIRED_MESSAGE);
      (migrationErr as { statusCode?: number }).statusCode = 503;
      throw migrationErr;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/employee_weekly_plans|relation .* does not exist|table .* does not exist/i.test(message)) {
    const migrationErr = new Error(WEEKLY_PLAN_MIGRATION_REQUIRED_MESSAGE);
    (migrationErr as { statusCode?: number }).statusCode = 503;
    throw migrationErr;
  }
  throw err;
}

export async function getEmployeeWeeklyPlan(
  user: JwtPayload,
  weekStartInput?: unknown,
): Promise<EmployeeWeeklyPlanDto> {
  const weekStart = normalizeWeekStartInput(weekStartInput);
  const weekStartDate = dateStringToDbDate(weekStart);

  let row;
  try {
    row = await prisma.employeeWeeklyPlan.findUnique({
      where: {
        userId_weekStart: {
          userId: user.userId,
          weekStart: weekStartDate,
        },
      },
    });
  } catch (err) {
    rethrowWeeklyPlanDbError(err);
  }

  return toDto(weekStart, row);
}

export async function saveEmployeeWeeklyPlan(
  user: JwtPayload,
  body: {
    weekStart?: unknown;
    nextWeekPlan?: unknown;
    problems?: unknown;
    supportNeeded?: unknown;
    submit?: unknown;
  },
): Promise<EmployeeWeeklyPlanDto> {
  const weekStart = normalizeWeekStartInput(body.weekStart);
  const weekStartDate = dateStringToDbDate(weekStart);
  const nextWeekPlan = sanitizePlanField(body.nextWeekPlan);
  const problems = sanitizePlanField(body.problems);
  const supportNeeded = sanitizePlanField(body.supportNeeded);
  const shouldSubmit = body.submit === true;

  let row;
  try {
    row = await prisma.employeeWeeklyPlan.upsert({
      where: {
        userId_weekStart: {
          userId: user.userId,
          weekStart: weekStartDate,
        },
      },
      create: {
        userId: user.userId,
        weekStart: weekStartDate,
        nextWeekPlan,
        problems,
        supportNeeded,
        submittedAt: shouldSubmit ? new Date() : null,
      },
      update: {
        nextWeekPlan,
        problems,
        supportNeeded,
        ...(shouldSubmit ? { submittedAt: new Date() } : {}),
      },
    });
  } catch (err) {
    rethrowWeeklyPlanDbError(err);
  }

  return toDto(weekStart, row);
}

/** AI sourcePayload 用：按 userId + weekStart 精确查询 */
export async function loadEmployeeWeeklyPlanForSourcePayload(
  userId: number,
  weekStart: string,
): Promise<EmployeeWeeklyPlanSourceSlice> {
  const weekStartDate = dateStringToDbDate(weekStart);
  const row = await prisma.employeeWeeklyPlan.findUnique({
    where: {
      userId_weekStart: {
        userId,
        weekStart: weekStartDate,
      },
    },
    select: {
      nextWeekPlan: true,
      problems: true,
      supportNeeded: true,
      submittedAt: true,
    },
  });

  if (!row) return { ...EMPTY_PLAN_SLICE };

  return {
    nextWeekPlan: row.nextWeekPlan,
    problems: row.problems,
    supportNeeded: row.supportNeeded,
    submittedAt: row.submittedAt?.toISOString() ?? null,
  };
}

/** 管理端批量生成前可选批量预取（避免 N+1） */
export async function loadEmployeeWeeklyPlansByUserIds(
  userIds: number[],
  weekStart: string,
): Promise<Map<number, EmployeeWeeklyPlanSourceSlice>> {
  const map = new Map<number, EmployeeWeeklyPlanSourceSlice>();
  if (userIds.length === 0) return map;

  const weekStartDate = dateStringToDbDate(weekStart);
  const rows = await prisma.employeeWeeklyPlan.findMany({
    where: {
      weekStart: weekStartDate,
      userId: { in: userIds },
    },
    select: {
      userId: true,
      nextWeekPlan: true,
      problems: true,
      supportNeeded: true,
      submittedAt: true,
    },
  });

  for (const row of rows) {
    map.set(row.userId, {
      nextWeekPlan: row.nextWeekPlan,
      problems: row.problems,
      supportNeeded: row.supportNeeded,
      submittedAt: row.submittedAt?.toISOString() ?? null,
    });
  }
  return map;
}
