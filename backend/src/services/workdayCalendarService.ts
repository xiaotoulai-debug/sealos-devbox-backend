import { WorkdayStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import { isOperationManager } from './operationDailyService';

const STATUSES = Object.values(WorkdayStatus);

const WORKDAY_STATUS_NAMES: Record<WorkdayStatus, string> = {
  WORKDAY: '运营日',
  REST: '休息日',
  PENDING: '待定',
};

function assertCalendarManager(user: JwtPayload): void {
  if (!isOperationManager(user)) {
    throw Object.assign(new Error('无权限编辑运营日历'), { statusCode: 403 });
  }
}

function parseYear(value: unknown): number {
  const year = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('year 无效，请传入 2000-2100 之间的整数');
  }
  return year;
}

function parseDateString(value: unknown, fieldName = 'date'): string {
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

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function enumerateDateStrings(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function yearDateRange(year: number) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const days = isLeapYear(year) ? 366 : 365;
  return { start, end, days };
}

function parseWorkdayStatus(value: unknown): WorkdayStatus {
  const raw = String(value ?? '').trim();
  if (!STATUSES.includes(raw as WorkdayStatus)) {
    throw new Error(`status 无效，合法值：${STATUSES.join('/')}`);
  }
  return raw as WorkdayStatus;
}

function parseOptionalRemark(value: unknown): string | null {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (text.length > 255) throw new Error('remark 长度不能超过 255');
  return text || null;
}

function formatCalendarDay(
  date: string,
  record?: {
    status: WorkdayStatus;
    remark: string | null;
    updatedById: number | null;
    updatedAt: Date;
    updatedBy: { id: number; name: string } | null;
  },
) {
  return {
    date,
    status: record?.status ?? WorkdayStatus.PENDING,
    statusName: WORKDAY_STATUS_NAMES[record?.status ?? WorkdayStatus.PENDING],
    remark: record?.remark ?? null,
    updatedById: record?.updatedById ?? null,
    updatedByName: record?.updatedBy?.name ?? null,
    updatedAt: record?.updatedAt?.toISOString() ?? null,
  };
}

export async function getWorkdayCalendarYear(_user: JwtPayload, yearInput: unknown) {
  const year = parseYear(yearInput ?? new Date().getUTCFullYear());
  const { start, end, days } = yearDateRange(year);
  const allDates = enumerateDateStrings(start, end);
  if (allDates.length !== days) {
    throw new Error('运营日历日期生成异常');
  }

  const records = await prisma.workdayCalendar.findMany({
    where: {
      date: {
        gte: dateStringToDbDate(start),
        lte: dateStringToDbDate(end),
      },
    },
    include: {
      updatedBy: { select: { id: true, name: true } },
    },
  });
  const recordMap = new Map(records.map((record) => [record.date.toISOString().slice(0, 10), record]));

  return {
    year,
    days: allDates.map((date) => formatCalendarDay(date, recordMap.get(date))),
  };
}

export async function upsertWorkdayCalendarDay(
  user: JwtPayload,
  dateInput: unknown,
  input: { status?: unknown; remark?: unknown },
) {
  assertCalendarManager(user);
  const date = parseDateString(dateInput);
  const status = parseWorkdayStatus(input.status);
  const remark = parseOptionalRemark(input.remark);

  const saved = await prisma.workdayCalendar.upsert({
    where: { date: dateStringToDbDate(date) },
    create: {
      date: dateStringToDbDate(date),
      status,
      remark,
      updatedById: user.userId,
    },
    update: {
      status,
      remark,
      updatedById: user.userId,
    },
    include: {
      updatedBy: { select: { id: true, name: true } },
    },
  });

  return formatCalendarDay(date, saved);
}

export async function batchUpdateWorkdayCalendar(
  user: JwtPayload,
  input: { dates?: unknown; status?: unknown; remark?: unknown },
) {
  assertCalendarManager(user);
  if (!Array.isArray(input.dates) || input.dates.length === 0) {
    throw new Error('dates 必须是非空数组');
  }
  const dates = [...new Set(input.dates.map((item) => parseDateString(item, 'dates')))];
  const status = parseWorkdayStatus(input.status);
  const remark = parseOptionalRemark(input.remark);

  const updatedCount = await prisma.$transaction(async (tx) => {
    let count = 0;
    for (const date of dates) {
      await tx.workdayCalendar.upsert({
        where: { date: dateStringToDbDate(date) },
        create: {
          date: dateStringToDbDate(date),
          status,
          remark,
          updatedById: user.userId,
        },
        update: {
          status,
          remark,
          updatedById: user.userId,
        },
      });
      count += 1;
    }
    return count;
  });

  return { updatedCount, dates, status, remark };
}

export type WorkdayRangeStats = {
  allDates: string[];
  workdayDates: string[];
  restDates: string[];
  pendingDates: string[];
  calendarStatus: 'CONFIGURED' | 'NOT_CONFIGURED';
};

export async function getWorkdayStatusForDate(date: string): Promise<WorkdayStatus> {
  const row = await prisma.workdayCalendar.findUnique({
    where: { date: dateStringToDbDate(date) },
    select: { status: true },
  });
  return row?.status ?? WorkdayStatus.PENDING;
}

export async function getWorkdayStatusMap(startDate: string, endDate: string): Promise<Map<string, WorkdayStatus>> {
  const records = await prisma.workdayCalendar.findMany({
    where: {
      date: {
        gte: dateStringToDbDate(startDate),
        lte: dateStringToDbDate(endDate),
      },
    },
    select: { date: true, status: true },
  });
  const map = new Map<string, WorkdayStatus>();
  for (const record of records) {
    map.set(record.date.toISOString().slice(0, 10), record.status);
  }
  return map;
}

export async function getWorkdayDatesInRange(startDate: string, endDate: string): Promise<WorkdayRangeStats> {
  const allDates = enumerateDateStrings(startDate, endDate);
  const configuredMap = await getWorkdayStatusMap(startDate, endDate);

  const workdayDates = allDates.filter((date) => configuredMap.get(date) === WorkdayStatus.WORKDAY);
  const restDates = allDates.filter((date) => configuredMap.get(date) === WorkdayStatus.REST);
  const pendingDates = allDates.filter((date) => {
    const status = configuredMap.get(date);
    return !status || status === WorkdayStatus.PENDING;
  });

  return {
    allDates,
    workdayDates,
    restDates,
    pendingDates,
    calendarStatus: workdayDates.length > 0 ? 'CONFIGURED' : 'NOT_CONFIGURED',
  };
}

export type WeekWorkdayReportStats = WorkdayRangeStats & {
  requiredDays: number;
  submittedReportDays: number;
  missingDays: number;
  missingDates: string[];
};

export async function resolveWeekWorkdayReportStats(
  weekStart: string,
  weekEnd: string,
  submittedDates: Set<string>,
): Promise<WeekWorkdayReportStats> {
  const range = await getWorkdayDatesInRange(weekStart, weekEnd);
  const workdayDateSet = new Set(range.workdayDates);
  const submittedReportDays = [...submittedDates].filter((date) => workdayDateSet.has(date)).length;
  const missingDates = range.workdayDates.filter((date) => !submittedDates.has(date));
  const requiredDays = range.workdayDates.length;
  const missingDays = requiredDays > 0 ? Math.max(0, requiredDays - submittedReportDays) : 0;

  return {
    ...range,
    requiredDays,
    submittedReportDays,
    missingDays,
    missingDates,
  };
}
