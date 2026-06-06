import {
  OperationPlatform,
  Prisma,
  ReminderAssignmentTargetType,
  ReminderCategory,
  ReminderCheckStatus,
  ReminderFrequency,
  ReminderPriority,
  UserStatus,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload, DASHBOARD_PERMISSION, hasStrictPermission } from '../middleware/auth';

const CATEGORIES = Object.values(ReminderCategory);
const PRIORITIES = Object.values(ReminderPriority);
const FREQUENCIES = Object.values(ReminderFrequency);
const PLATFORMS = Object.values(OperationPlatform);
const CHECK_STATUSES: ReminderCheckStatus[] = [ReminderCheckStatus.CHECKED, ReminderCheckStatus.ABNORMAL];
const PAGE_SIZE_MAX = 100;

const CATEGORY_NAMES: Record<ReminderCategory, string> = {
  PLATFORM_MESSAGE: '平台消息',
  QUALIFICATION: '资质维护',
  PRODUCT_REVIEW: '商品审核',
  AD_CHECK: '广告检查',
  SHIPPING_FOLLOW: '发货跟进',
  INVENTORY_CHECK: '库存检查',
  AFTER_SALES: '售后异常',
  PRODUCT_SELECTION: '选品动作',
  OTHER: '其他',
};

const PRIORITY_NAMES: Record<ReminderPriority, string> = {
  P0: 'P0 必做',
  P1: 'P1 重要',
  P2: 'P2 常规',
};

const FREQUENCY_NAMES: Record<ReminderFrequency, string> = {
  DAILY: '每日',
  WORKDAY: '工作日',
  WEEKLY: '每周',
};

const CHECK_STATUS_NAMES: Record<ReminderCheckStatus, string> = {
  PENDING: '待检查',
  CHECKED: '已检查',
  ABNORMAL: '有异常',
};

const PLATFORM_NAMES: Record<OperationPlatform, string> = {
  SHEIN: 'SHEIN',
  TEMU: 'TEMU',
  ALIEXPRESS: 'AliExpress',
  EMAG: 'eMAG',
  AMAZON: 'Amazon',
  OTHER: '其他',
};

type TemplateInput = {
  title?: unknown;
  category?: unknown;
  priority?: unknown;
  frequency?: unknown;
  weekdays?: unknown;
  suggestedTime?: unknown;
  requireCheck?: unknown;
  platform?: unknown;
  shopId?: unknown;
  description?: unknown;
  assignments?: unknown;
};

type AssignmentInput = {
  targetType?: unknown;
  userId?: unknown;
  roleId?: unknown;
};

type TemplateWithRelations = Prisma.DailyReminderTemplateGetPayload<{
  include: {
    shop: { select: { id: true; shopName: true } };
    createdBy: { select: { id: true; name: true } };
    updatedBy: { select: { id: true; name: true } };
    assignments: {
      include: {
        user: { select: { id: true; name: true } };
        role: { select: { id: true; name: true } };
      };
    };
  };
}>;

type TodayTemplate = Prisma.DailyReminderTemplateGetPayload<{
  include: {
    shop: { select: { id: true; shopName: true } };
    assignments: true;
  };
}>;

function assertReminderTemplateRead(user: JwtPayload): void {
  if (
    hasStrictPermission(user, DASHBOARD_PERMISSION.TASK_CENTER)
    || hasStrictPermission(user, DASHBOARD_PERMISSION.REMINDER_TEMPLATE_MANAGE)
  ) {
    return;
  }
  throw Object.assign(new Error('无权限访问提醒模板'), { statusCode: 403 });
}

function assertReminderTemplateWrite(user: JwtPayload): void {
  if (hasStrictPermission(user, DASHBOARD_PERMISSION.REMINDER_TEMPLATE_MANAGE)) {
    return;
  }
  throw Object.assign(new Error('无权限管理提醒模板'), { statusCode: 403 });
}

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

function parseDateString(value: unknown, fieldName: string): string {
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

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function parseCategory(value: unknown): ReminderCategory {
  const raw = String(value ?? '').trim();
  if (!CATEGORIES.includes(raw as ReminderCategory)) {
    throw new Error(`category 无效，合法值：${CATEGORIES.join('/')}`);
  }
  return raw as ReminderCategory;
}

function parsePriority(value: unknown): ReminderPriority {
  const raw = String(value ?? '').trim();
  if (!PRIORITIES.includes(raw as ReminderPriority)) {
    throw new Error(`priority 无效，合法值：${PRIORITIES.join('/')}`);
  }
  return raw as ReminderPriority;
}

function parseFrequency(value: unknown): ReminderFrequency {
  const raw = String(value ?? '').trim();
  if (!FREQUENCIES.includes(raw as ReminderFrequency)) {
    throw new Error(`frequency 无效，合法值：${FREQUENCIES.join('/')}`);
  }
  return raw as ReminderFrequency;
}

function parsePlatform(value: unknown): OperationPlatform | undefined {
  if (value == null || value === '') return undefined;
  const raw = String(value).trim();
  if (!PLATFORMS.includes(raw as OperationPlatform)) {
    throw new Error(`platform 无效，合法值：${PLATFORMS.join('/')}`);
  }
  return raw as OperationPlatform;
}

function parseOptionalPositiveInt(value: unknown, fieldName: string): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return n;
}

function parseSuggestedTime(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const raw = String(value).trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) throw new Error('suggestedTime 格式无效，请使用 HH:mm');
  const [hour, minute] = raw.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('suggestedTime 时间无效');
  }
  return raw;
}

function parseWeekdays(value: unknown, frequency: ReminderFrequency): number[] {
  if (value == null || value === '') {
    if (frequency === ReminderFrequency.WEEKLY) {
      throw new Error('frequency=WEEKLY 时 weekdays 必填');
    }
    return [];
  }
  if (!Array.isArray(value)) throw new Error('weekdays 必须是数组');
  const weekdays = value.map((item) => Number(item));
  if (weekdays.some((item) => !Number.isInteger(item) || item < 1 || item > 7)) {
    throw new Error('weekdays 只能包含 1-7 的整数');
  }
  const unique = [...new Set(weekdays)].sort((a, b) => a - b);
  if (frequency === ReminderFrequency.WEEKLY && unique.length === 0) {
    throw new Error('frequency=WEEKLY 时 weekdays 必填');
  }
  return unique;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value == null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('布尔字段格式无效');
}

function parsePagination(query: { page?: unknown; pageSize?: unknown }) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const requestedPageSize = Number.parseInt(String(query.pageSize ?? '20'), 10) || 20;
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, requestedPageSize));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function templateInclude() {
  return {
    shop: { select: { id: true, shopName: true } },
    createdBy: { select: { id: true, name: true } },
    updatedBy: { select: { id: true, name: true } },
    assignments: {
      include: {
        user: { select: { id: true, name: true } },
        role: { select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    },
  } satisfies Prisma.DailyReminderTemplateInclude;
}

function formatTemplate(template: TemplateWithRelations) {
  return {
    id: template.id,
    title: template.title,
    category: template.category,
    categoryName: CATEGORY_NAMES[template.category],
    priority: template.priority,
    priorityName: PRIORITY_NAMES[template.priority],
    frequency: template.frequency,
    frequencyName: FREQUENCY_NAMES[template.frequency],
    weekdays: template.weekdays,
    suggestedTime: template.suggestedTime,
    requireCheck: template.requireCheck,
    platform: template.platform,
    platformName: template.platform ? PLATFORM_NAMES[template.platform] : null,
    shopId: template.shopId,
    shopName: template.shop?.shopName ?? null,
    description: template.description,
    isActive: template.isActive,
    createdById: template.createdById,
    createdByName: template.createdBy.name,
    updatedById: template.updatedById,
    updatedByName: template.updatedBy?.name ?? null,
    assignments: template.assignments.map((assignment) => ({
      id: assignment.id,
      targetType: assignment.targetType,
      userId: assignment.userId,
      userName: assignment.user?.name ?? null,
      roleId: assignment.roleId,
      roleName: assignment.role?.name ?? null,
    })),
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function weekdayOf(date: string): number {
  const day = dateStringToDbDate(date).getUTCDay();
  return day === 0 ? 7 : day;
}

function frequencyMatches(template: Pick<TodayTemplate, 'frequency' | 'weekdays'>, date: string): boolean {
  const weekday = weekdayOf(date);
  if (template.frequency === ReminderFrequency.DAILY) return true;
  if (template.frequency === ReminderFrequency.WORKDAY) return weekday >= 1 && weekday <= 5;
  return template.weekdays.includes(weekday);
}

function computeIsOverdue(date: string, suggestedTime: string | null, checkStatus: ReminderCheckStatus): boolean {
  if (checkStatus !== ReminderCheckStatus.PENDING || !suggestedTime) return false;
  return new Date(`${date}T${suggestedTime}:00.000+08:00`).getTime() < Date.now();
}

function priorityWeight(priority: ReminderPriority): number {
  if (priority === ReminderPriority.P0) return 3;
  if (priority === ReminderPriority.P1) return 2;
  return 1;
}

function suggestedMinutes(value: string | null): number {
  if (!value) return 24 * 60;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function formatTodayItem(template: TodayTemplate, check: { status: ReminderCheckStatus; note: string | null; checkedAt: Date | null } | undefined, date: string) {
  const checkStatus = check?.status ?? ReminderCheckStatus.PENDING;
  const isDone = checkStatus === ReminderCheckStatus.CHECKED;
  const isAbnormal = checkStatus === ReminderCheckStatus.ABNORMAL;
  const isOverdue = computeIsOverdue(date, template.suggestedTime, checkStatus);
  const sortWeight = (isDone ? 100000 : 0)
    + (isOverdue ? -10000 : 0)
    - priorityWeight(template.priority) * 1000
    + suggestedMinutes(template.suggestedTime)
    + (isAbnormal ? 100 : 0);
  return {
    id: template.id,
    title: template.title,
    category: template.category,
    categoryName: CATEGORY_NAMES[template.category],
    priority: template.priority,
    priorityName: PRIORITY_NAMES[template.priority],
    suggestedTime: template.suggestedTime,
    platform: template.platform,
    platformName: template.platform ? PLATFORM_NAMES[template.platform] : null,
    shopId: template.shopId,
    shopName: template.shop?.shopName ?? null,
    description: template.description,
    requireCheck: template.requireCheck,
    checkStatus,
    checkStatusName: CHECK_STATUS_NAMES[checkStatus],
    note: check?.note ?? null,
    checkedAt: check?.checkedAt ?? null,
    isOverdue,
    sortWeight,
  };
}

async function assertShopExists(shopId?: number) {
  if (!shopId) return;
  const shop = await prisma.shopAuthorization.findUnique({ where: { id: shopId }, select: { id: true } });
  if (!shop) throw new Error('shopId 不存在');
}

async function validateAssignments(assignmentsRaw: unknown) {
  const assignments = assignmentsRaw ?? [];
  if (!Array.isArray(assignments)) throw new Error('assignments 必须是数组');
  const parsed = assignments.map((item: AssignmentInput) => {
    const targetType = String(item.targetType ?? '').trim();
    if (targetType !== ReminderAssignmentTargetType.USER && targetType !== ReminderAssignmentTargetType.ROLE) {
      throw new Error('assignment.targetType 无效，合法值：USER/ROLE');
    }
    const userId = parseOptionalPositiveInt(item.userId, 'assignment.userId');
    const roleId = parseOptionalPositiveInt(item.roleId, 'assignment.roleId');
    if (targetType === ReminderAssignmentTargetType.USER && !userId) throw new Error('targetType=USER 时 userId 必填');
    if (targetType === ReminderAssignmentTargetType.ROLE && !roleId) throw new Error('targetType=ROLE 时 roleId 必填');
    return {
      targetType: targetType as ReminderAssignmentTargetType,
      userId: targetType === ReminderAssignmentTargetType.USER ? userId : undefined,
      roleId: targetType === ReminderAssignmentTargetType.ROLE ? roleId : undefined,
    };
  });

  const userIds = parsed.map((item) => item.userId).filter((id): id is number => Boolean(id));
  const roleIds = parsed.map((item) => item.roleId).filter((id): id is number => Boolean(id));
  const [users, roles] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds }, status: UserStatus.ACTIVE }, select: { id: true } })
      : Promise.resolve([]),
    roleIds.length
      ? prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true } })
      : Promise.resolve([]),
  ]);
  const foundUserIds = new Set(users.map((user) => user.id));
  const foundRoleIds = new Set(roles.map((role) => role.id));
  for (const userId of userIds) {
    if (!foundUserIds.has(userId)) throw new Error(`userId ${userId} 不存在或不是 ACTIVE 用户`);
  }
  for (const roleId of roleIds) {
    if (!foundRoleIds.has(roleId)) throw new Error(`roleId ${roleId} 不存在`);
  }
  return parsed;
}

function parseTemplateInput(input: TemplateInput, partial = false) {
  const category = input.category !== undefined ? parseCategory(input.category) : undefined;
  const priority = input.priority !== undefined ? parsePriority(input.priority) : undefined;
  const frequency = input.frequency !== undefined ? parseFrequency(input.frequency) : undefined;
  const platform = input.platform !== undefined ? parsePlatform(input.platform) : undefined;
  const shopId = input.shopId !== undefined ? parseOptionalPositiveInt(input.shopId, 'shopId') : undefined;
  const suggestedTime = input.suggestedTime !== undefined ? parseSuggestedTime(input.suggestedTime) : undefined;
  const requireCheck = input.requireCheck !== undefined ? parseBoolean(input.requireCheck, true) : undefined;
  const resolvedFrequency = frequency ?? ReminderFrequency.DAILY;
  return {
    title: input.title !== undefined ? parseRequiredString(input.title, 'title') : partial ? undefined : parseRequiredString(input.title, 'title'),
    category: category ?? (partial ? undefined : parseCategory(input.category)),
    priority: priority ?? (partial ? undefined : parsePriority(input.priority)),
    frequency: frequency ?? (partial ? undefined : parseFrequency(input.frequency)),
    weekdays: input.weekdays !== undefined ? parseWeekdays(input.weekdays, resolvedFrequency) : partial ? undefined : [],
    suggestedTime,
    requireCheck,
    platform,
    shopId,
    description: input.description !== undefined ? parseOptionalString(input.description) : undefined,
  };
}

async function findApplicableTemplates(user: JwtPayload, date: string) {
  const templates = await prisma.dailyReminderTemplate.findMany({
    where: {
      isActive: true,
      assignments: {
        some: {
          OR: [
            { targetType: ReminderAssignmentTargetType.USER, userId: user.userId },
            { targetType: ReminderAssignmentTargetType.ROLE, roleId: user.roleId },
          ],
        },
      },
    },
    include: {
      shop: { select: { id: true, shopName: true } },
      assignments: true,
    },
    orderBy: { id: 'asc' },
  });
  return templates.filter((template) => frequencyMatches(template, date));
}

export async function getTodayReminders(user: JwtPayload, params: { date?: unknown; userId?: unknown }) {
  if (params.userId != null) throw new Error('today 不允许传 userId');
  const date = params.date ? parseDateString(params.date, 'date') : todayString();
  const templates = await findApplicableTemplates(user, date);
  const templateIds = templates.map((template) => template.id);
  const checks = templateIds.length
    ? await prisma.dailyReminderCheck.findMany({
      where: {
        userId: user.userId,
        checkDate: dateStringToDbDate(date),
        templateId: { in: templateIds },
      },
      select: { templateId: true, status: true, note: true, checkedAt: true },
    })
    : [];
  const checkMap = new Map(checks.map((check) => [check.templateId, check]));
  return templates
    .map((template) => formatTodayItem(template, checkMap.get(template.id), date))
    .sort((a, b) => a.sortWeight - b.sortWeight || a.id - b.id);
}

export async function checkReminder(user: JwtPayload, templateId: number, input: { date?: unknown; status?: unknown; note?: unknown }) {
  if (!Number.isInteger(templateId) || templateId <= 0) throw new Error('templateId 必须是正整数');
  const date = input.date ? parseDateString(input.date, 'date') : todayString();
  const status = String(input.status ?? '').trim() as ReminderCheckStatus;
  if (!CHECK_STATUSES.includes(status)) throw new Error('status 只允许 CHECKED 或 ABNORMAL');
  const note = parseOptionalString(input.note);
  if (status === ReminderCheckStatus.ABNORMAL && !note) throw new Error('status=ABNORMAL 时 note 必填');
  const templates = await findApplicableTemplates(user, date);
  const template = templates.find((item) => item.id === templateId);
  if (!template) throw Object.assign(new Error('提醒模板不存在、未启用或不适用于当前用户'), { statusCode: 403 });

  await prisma.dailyReminderCheck.upsert({
    where: {
      templateId_userId_checkDate: {
        templateId,
        userId: user.userId,
        checkDate: dateStringToDbDate(date),
      },
    },
    create: {
      templateId,
      userId: user.userId,
      checkDate: dateStringToDbDate(date),
      status,
      note,
      checkedAt: new Date(),
    },
    update: {
      status,
      note,
      checkedAt: new Date(),
    },
  });

  return (await getTodayReminders(user, { date })).find((item) => item.id === templateId);
}

export async function createReminderTemplate(user: JwtPayload, input: TemplateInput) {
  assertReminderTemplateWrite(user);
  const parsed = parseTemplateInput(input);
  const assignments = await validateAssignments(input.assignments);
  await assertShopExists(parsed.shopId);
  const created = await prisma.$transaction(async (tx) => {
    const template = await tx.dailyReminderTemplate.create({
      data: {
        title: parsed.title!,
        category: parsed.category!,
        priority: parsed.priority!,
        frequency: parsed.frequency!,
        weekdays: parsed.weekdays ?? [],
        suggestedTime: parsed.suggestedTime,
        requireCheck: parsed.requireCheck ?? true,
        platform: parsed.platform,
        shopId: parsed.shopId,
        description: parsed.description,
        createdById: user.userId,
        assignments: { create: assignments },
      },
    });
    return tx.dailyReminderTemplate.findUniqueOrThrow({ where: { id: template.id }, include: templateInclude() });
  });
  return formatTemplate(created);
}

export async function updateReminderTemplate(user: JwtPayload, id: number, input: TemplateInput) {
  assertReminderTemplateWrite(user);
  if (!Number.isInteger(id) || id <= 0) throw new Error('id 必须是正整数');
  const existing = await prisma.dailyReminderTemplate.findUnique({ where: { id }, select: { id: true, frequency: true } });
  if (!existing) throw Object.assign(new Error('提醒模板不存在'), { statusCode: 404 });
  const parsed = parseTemplateInput(input, true);
  const nextFrequency = parsed.frequency ?? existing.frequency;
  const nextWeekdays = input.weekdays !== undefined ? parseWeekdays(input.weekdays, nextFrequency) : undefined;
  const assignments = input.assignments !== undefined ? await validateAssignments(input.assignments) : undefined;
  await assertShopExists(parsed.shopId);

  const data: Prisma.DailyReminderTemplateUpdateInput = {
    updatedBy: { connect: { id: user.userId } },
  };
  if (parsed.title !== undefined) data.title = parsed.title;
  if (parsed.category !== undefined) data.category = parsed.category;
  if (parsed.priority !== undefined) data.priority = parsed.priority;
  if (parsed.frequency !== undefined) data.frequency = parsed.frequency;
  if (nextWeekdays !== undefined) data.weekdays = nextWeekdays;
  if (input.suggestedTime !== undefined) data.suggestedTime = parsed.suggestedTime ?? null;
  if (parsed.requireCheck !== undefined) data.requireCheck = parsed.requireCheck;
  if (input.platform !== undefined) data.platform = parsed.platform ?? null;
  if (input.shopId !== undefined) data.shop = parsed.shopId ? { connect: { id: parsed.shopId } } : { disconnect: true };
  if (input.description !== undefined) data.description = parsed.description ?? null;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.dailyReminderTemplate.update({ where: { id }, data });
    if (assignments) {
      await tx.dailyReminderTemplateAssignment.deleteMany({ where: { templateId: id } });
      if (assignments.length > 0) {
        await tx.dailyReminderTemplateAssignment.createMany({
          data: assignments.map((assignment) => ({ templateId: id, ...assignment })),
        });
      }
    }
    return tx.dailyReminderTemplate.findUniqueOrThrow({ where: { id }, include: templateInclude() });
  });
  return formatTemplate(updated);
}

export async function updateReminderTemplateStatus(user: JwtPayload, id: number, input: { isActive?: unknown }) {
  assertReminderTemplateWrite(user);
  if (!Number.isInteger(id) || id <= 0) throw new Error('id 必须是正整数');
  if (typeof input.isActive !== 'boolean') throw new Error('isActive 必须是 boolean');
  const updated = await prisma.dailyReminderTemplate.update({
    where: { id },
    data: { isActive: input.isActive, updatedById: user.userId },
    include: templateInclude(),
  });
  return formatTemplate(updated);
}

export async function listReminderTemplates(user: JwtPayload, query: { page?: unknown; pageSize?: unknown; isActive?: unknown; category?: unknown; priority?: unknown }) {
  assertReminderTemplateRead(user);
  const { page, pageSize, skip } = parsePagination(query);
  const where: Prisma.DailyReminderTemplateWhereInput = {};
  if (query.isActive !== undefined && query.isActive !== '') where.isActive = parseBoolean(query.isActive, true);
  if (query.category) where.category = parseCategory(query.category);
  if (query.priority) where.priority = parsePriority(query.priority);
  const [total, templates] = await Promise.all([
    prisma.dailyReminderTemplate.count({ where }),
    prisma.dailyReminderTemplate.findMany({
      where,
      include: templateInclude(),
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: pageSize,
    }),
  ]);
  return { items: templates.map(formatTemplate), total, page, pageSize };
}

export async function getReminderTemplateDetail(user: JwtPayload, id: number) {
  assertReminderTemplateRead(user);
  if (!Number.isInteger(id) || id <= 0) throw new Error('id 必须是正整数');
  const template = await prisma.dailyReminderTemplate.findUnique({
    where: { id },
    include: templateInclude(),
  });
  if (!template) throw Object.assign(new Error('提醒模板不存在'), { statusCode: 404 });
  return formatTemplate(template);
}

export async function deleteReminderTemplate(
  user: JwtPayload,
  id: number,
  options?: { force?: boolean },
) {
  assertReminderTemplateWrite(user);

  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('id 必须是正整数');
  }

  const existing = await prisma.dailyReminderTemplate.findUnique({
    where: { id },
    select: { id: true, title: true },
  });

  if (!existing) {
    throw Object.assign(new Error('提醒模板不存在'), { statusCode: 404 });
  }

  const force = options?.force === true;

  const checkCount = await prisma.dailyReminderCheck.count({
    where: { templateId: id },
  });

  if (checkCount > 0 && !force) {
    throw Object.assign(
      new Error('该模板已有历史处理记录，无法直接删除，请使用强制删除或先停用'),
      { statusCode: 409 },
    );
  }

  if (force && checkCount > 0) {
    console.log('[DailyReminder] force delete template', {
      templateId: existing.id,
      title: existing.title,
      checkCount,
      operatorUserId: user.userId,
    });
  }

  await prisma.$transaction(async (tx) => {
    if (checkCount > 0) {
      await tx.dailyReminderCheck.deleteMany({
        where: { templateId: id },
      });
    }

    await tx.dailyReminderTemplateAssignment.deleteMany({
      where: { templateId: id },
    });

    await tx.dailyReminderTemplate.delete({
      where: { id },
    });
  });

  return true;
}
