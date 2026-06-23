import { createHash } from 'crypto';
import axios from 'axios';
import { EmployeeWeeklyAiSummaryStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import { buildRuleWeeklySummary, normalizeWeekStartInput, RuleWeeklySummary } from './employeeTaskService';
import {
  loadEmployeeWeeklyPlanForSourcePayload,
  type EmployeeWeeklyPlanSourceSlice,
} from './employeeWeeklyPlanService';

function createConcurrencyLimiter(maxConcurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        activeCount += 1;
        fn()
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1;
            const next = queue.shift();
            if (next) next();
          });
      };

      if (activeCount < maxConcurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

const globalLimit = createConcurrencyLimiter(Number(process.env.WEEKLY_AI_CONCURRENCY ?? 2));

const AI_TASK_LIMIT = 5;
const AI_NOTE_LIMIT = 10;
const RAW_TEXT_MAX = 8000;
/** 仅防异常超长 AI 响应撑爆接口，不用于业务展示截断；正常内容不应触达 */
const AI_WEEKLY_TECHNICAL_MAX_ITEMS = 20;
const AI_WEEKLY_TECHNICAL_MAX_TEXT_LENGTH = 2000;
const NO_DATA_TEXT = '暂无有效数据';

const FORBIDDEN_AI_FIELDS = [
  'review', 'nextActions', 'suggestionText', 'content', 'markdown',
  'overview', 'highlights', 'risks', 'completionAnalysis', 'nextWeekSuggestions', 'managerNote',
];

const inflight = new Map<string, Promise<WeeklySummaryWithAi>>();

const SYSTEM_PROMPT = `你是员工周报助手。输入 JSON 为 sourcePayload，含：日报登记、收到任务、发起/指派任务、协同任务、员工自填的 employeeWeeklyPlan（下周计划/问题/需协助）。
禁止编造销售/GMV/利润数据（meta.hasSalesData=false）。无相关数据时 summary 写「暂无有效数据」，items 为 []。

只输出 JSON 对象，且 ONLY 3 个顶层字段：
{
  "completed":  { "summary": string, "items": string[] },
  "unfinished": { "summary": string, "items": string[] },
  "nextFocus":  { "summary": string, "items": string[] }
}

规则：
- completed：上周已完成事项（已完成任务、已提交日报、已推进协同/指派任务）
- unfinished：上周未完成事项（未完成任务、延期任务、日报缺失、阻塞项）；若 employeeWeeklyPlan.problems 或 supportNeeded 有内容，须结合任务数据体现，不要忽略
- nextFocus：基于 unfinished 与 employeeWeeklyPlan.nextWeekPlan 推导本周优先动作；结合 problems/supportNeeded 转为可执行建议，不要只复述员工原文；若计划不合理可温和指出重点
- 若 employeeWeeklyPlan 有内容，必须结合员工自填的下周计划、问题、需协助事项，并与任务完成情况交叉验证
- summary：用 1-2 句话完整概括，不要写成长篇作文，第一人称「我」
- items：用编号要点表达，建议 3-5 条；每条表达完整，不要为了压缩而省略关键信息，必须是可核对事实
- 禁止空话：「继续努力」「保持沟通」「加强协作」等
- 三块之间禁止重复表达
- 禁止 Markdown、禁止解释文字、禁止额外字段
- 使用简体中文`;

export type AiSummarySection = {
  summary: string;
  items: string[];
};

export type AiSummaryJson = {
  completed: AiSummarySection;
  unfinished: AiSummarySection;
  nextFocus: AiSummarySection;
};

export type AiReportSource = 'AI' | 'RULE_FALLBACK' | null;

export type AiReportView = {
  id: number | null;
  employee: { id: number; name: string };
  period: { start: string; end: string };
  generatedAt: string | null;
  sections: AiSummaryJson | null;
  source: AiReportSource;
};

export type WeeklySummaryWithAi = RuleWeeklySummary & {
  aiStatus: string;
  aiGeneratedAt: string | null;
  aiSummary: AiSummaryJson | null;
  aiErrorMessage: string | null;
  aiReport: AiReportView;
};

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** trim + 极端超长安全兜底（silent slice，不加省略号） */
function sanitizeText(text: string): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  if (trimmed.length > AI_WEEKLY_TECHNICAL_MAX_TEXT_LENGTH) {
    return trimmed.slice(0, AI_WEEKLY_TECHNICAL_MAX_TEXT_LENGTH);
  }
  return trimmed;
}

export function isV3SummaryJson(json: unknown): json is AiSummaryJson {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const obj = json as Record<string, unknown>;
  return ['completed', 'unfinished', 'nextFocus'].every((key) => {
    const section = obj[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
    const s = section as Record<string, unknown>;
    return typeof s.summary === 'string' && Array.isArray(s.items) && s.items.every((i) => typeof i === 'string');
  });
}

function normalizeSection(raw: unknown): AiSummarySection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { summary: NO_DATA_TEXT, items: [] };
  }
  const obj = raw as Record<string, unknown>;
  let summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) summary = NO_DATA_TEXT;
  else summary = sanitizeText(summary) || NO_DATA_TEXT;

  const items = Array.isArray(obj.items)
    ? obj.items
      .map((item) => sanitizeText(typeof item === 'string' ? item : String(item ?? '')))
      .filter(Boolean)
      .slice(0, AI_WEEKLY_TECHNICAL_MAX_ITEMS)
    : [];

  return { summary, items };
}

export function normalizeAiSummaryJson(raw: unknown): AiSummaryJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      completed: { summary: NO_DATA_TEXT, items: [] },
      unfinished: { summary: NO_DATA_TEXT, items: [] },
      nextFocus: { summary: NO_DATA_TEXT, items: [] },
    };
  }
  const obj = raw as Record<string, unknown>;
  return {
    completed: normalizeSection(obj.completed),
    unfinished: normalizeSection(obj.unfinished),
    nextFocus: normalizeSection(obj.nextFocus),
  };
}

export function isWeeklyAiEnabled(): boolean {
  return process.env.WEEKLY_AI_ENABLED === 'true' && Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

function getAiConfig() {
  return {
    provider: process.env.WEEKLY_AI_PROVIDER ?? 'deepseek',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    promptVersion: process.env.WEEKLY_AI_PROMPT_VERSION ?? 'v3.3',
    timeoutMs: Number(process.env.WEEKLY_AI_TIMEOUT_MS ?? 25000),
    baseUrl: (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, ''),
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function computeSourceHash(source: unknown): string {
  const cfg = getAiConfig();
  return createHash('sha256')
    .update(`${stableStringify(source)}|${cfg.provider}|${cfg.model}|${cfg.promptVersion}`)
    .digest('hex');
}

type TaskSummarySlice = {
  totalCount: number;
  doneCount: number;
  pendingCount: number;
  overdueCount: number;
  doneTasks?: Array<{ title?: string; platform?: string | null; priority?: string; dueDate?: Date | string }>;
  pendingTasks?: Array<{ title?: string; platform?: string | null; priority?: string; dueDate?: Date | string }>;
  overdueTasks?: Array<{ title?: string; platform?: string | null; priority?: string; dueDate?: Date | string }>;
};

function formatDueDate(value: Date | string | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function slimTaskList(
  tasks: TaskSummarySlice['doneTasks'],
  mode: 'done' | 'pending',
): Array<{ title: string; platform: string | null; priority: string; dueDate?: string }> {
  if (!Array.isArray(tasks)) return [];
  return tasks.slice(0, AI_TASK_LIMIT).map((task) => {
    const base = {
      title: String(task?.title ?? ''),
      platform: task?.platform ?? null,
      priority: String(task?.priority ?? ''),
    };
    return mode === 'done'
      ? base
      : { ...base, dueDate: formatDueDate(task?.dueDate) };
  });
}

function slimTaskSummary(summary: TaskSummarySlice) {
  return {
    totalCount: summary.totalCount,
    doneCount: summary.doneCount,
    pendingCount: summary.pendingCount,
    overdueCount: summary.overdueCount,
    doneTasks: slimTaskList(summary.doneTasks, 'done'),
    pendingTasks: slimTaskList(summary.pendingTasks, 'pending'),
    overdueTasks: slimTaskList(summary.overdueTasks, 'pending'),
  };
}

export async function buildAiSourcePayload(user: JwtPayload, ruleSummary: RuleWeeklySummary) {
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { id: true, name: true },
  });

  const daily = ruleSummary.dailyReportSummary;
  const cfg = getAiConfig();
  const employeeWeeklyPlan = await loadEmployeeWeeklyPlanForSourcePayload(user.userId, ruleSummary.weekStart);
  return {
    user: {
      userId: user.userId,
      name: dbUser?.name ?? user.username,
      username: user.username,
    },
    week: { weekStart: ruleSummary.weekStart, weekEnd: ruleSummary.weekEnd },
    dailyReportSummary: {
      submittedDays: daily.submittedDays,
      missingDays: daily.missingDays,
      requiredDays: daily.requiredDays,
      productSelectionCount: daily.productSelectionCount,
      productListingCount: daily.productListingCount,
      approvedCount: daily.approvedCount,
      shipmentCount: daily.shipmentCount,
      otherNotes: (daily.otherNotes ?? []).slice(0, AI_NOTE_LIMIT).map((item) => item.text),
      blockedItems: (daily.blockedItems ?? []).slice(0, AI_NOTE_LIMIT).map((item) => item.blockerReason),
    },
    receivedTaskSummary: slimTaskSummary(ruleSummary.receivedTaskSummary),
    createdTaskSummary: slimTaskSummary(ruleSummary.createdTaskSummary),
    collaborationTaskSummary: {
      ...slimTaskSummary(ruleSummary.collaborationTaskSummary),
      sampleTasks: ruleSummary.collaborationSampleTasks,
    },
    employeeWeeklyPlan,
    meta: {
      promptVersion: cfg.promptVersion,
      hasSalesData: false,
    },
  };
}

function parseAiSummaryJson(raw: string): AiSummaryJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI 返回非 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回 JSON 结构无效');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of FORBIDDEN_AI_FIELDS) {
    if (key in obj) {
      throw new Error(`AI 返回禁止字段: ${key}`);
    }
  }
  for (const key of ['completed', 'unfinished', 'nextFocus']) {
    if (!(key in obj)) {
      throw new Error(`AI 返回缺少字段: ${key}`);
    }
  }
  const extraKeys = Object.keys(obj).filter((k) => !['completed', 'unfinished', 'nextFocus'].includes(k));
  if (extraKeys.length > 0) {
    throw new Error(`AI 返回额外字段: ${extraKeys.join(',')}`);
  }

  return normalizeAiSummaryJson(parsed);
}

function sanitizeRawText(raw: string): string {
  return raw.slice(0, RAW_TEXT_MAX);
}

function safeErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      return 'AI 服务请求超时';
    }
    return 'AI 服务请求失败';
  }
  if (err instanceof Error) {
    return err.message.slice(0, 500);
  }
  return 'AI 生成失败';
}

function collectTaskTitles(
  summaries: TaskSummarySlice[],
  kind: 'done' | 'pending' | 'overdue',
): string[] {
  const items: string[] = [];
  for (const summary of summaries) {
    const list = kind === 'done'
      ? summary.doneTasks
      : kind === 'overdue'
        ? summary.overdueTasks
        : summary.pendingTasks;
    for (const task of list ?? []) {
      const title = sanitizeText(String(task?.title ?? ''));
      if (title && !items.includes(title)) items.push(title);
      if (items.length >= AI_WEEKLY_TECHNICAL_MAX_ITEMS) return items;
    }
  }
  return items;
}

export function buildRuleFallbackSections(
  ruleSummary: RuleWeeklySummary,
  employeeWeeklyPlan?: EmployeeWeeklyPlanSourceSlice,
): AiSummaryJson {
  const received = ruleSummary.receivedTaskSummary;
  const created = ruleSummary.createdTaskSummary;
  const collaboration = ruleSummary.collaborationTaskSummary;
  const daily = ruleSummary.dailyReportSummary;

  const doneItems = collectTaskTitles([received, created, collaboration], 'done');
  if (daily.submittedDays > 0) {
    const note = sanitizeText(`已提交日报${daily.submittedDays}天`);
    if (note && !doneItems.includes(note) && doneItems.length < AI_WEEKLY_TECHNICAL_MAX_ITEMS) {
      doneItems.push(note);
    }
  }

  let completedSummary = NO_DATA_TEXT;
  if (doneItems.length > 0 || received.doneCount + created.doneCount + collaboration.doneCount > 0) {
    const totalDone = received.doneCount + created.doneCount + collaboration.doneCount;
    completedSummary = sanitizeText(`上周共完成${totalDone}项任务`) || NO_DATA_TEXT;
  }

  const unfinishedItems: string[] = [];
  if (daily.missingDays > 0) {
    unfinishedItems.push(sanitizeText(`日报缺失${daily.missingDays}天`));
  }
  for (const title of collectTaskTitles([received, created, collaboration], 'overdue')) {
    if (unfinishedItems.length >= AI_WEEKLY_TECHNICAL_MAX_ITEMS) break;
    if (!unfinishedItems.includes(title)) unfinishedItems.push(title);
  }
  for (const title of collectTaskTitles([received, created, collaboration], 'pending')) {
    if (unfinishedItems.length >= AI_WEEKLY_TECHNICAL_MAX_ITEMS) break;
    if (!unfinishedItems.includes(title)) unfinishedItems.push(title);
  }

  let unfinishedSummary = NO_DATA_TEXT;
  const totalPending = received.pendingCount + created.pendingCount + collaboration.pendingCount;
  const totalOverdue = received.overdueCount + created.overdueCount + collaboration.overdueCount;
  if (unfinishedItems.length > 0 || totalPending > 0 || totalOverdue > 0) {
    unfinishedSummary = sanitizeText(
      totalOverdue > 0
        ? `仍有${totalPending}项待办、${totalOverdue}项逾期`
        : `仍有${totalPending}项待办`,
    ) || NO_DATA_TEXT;
  }

  const nextItems = (ruleSummary.planSuggestions ?? [])
    .map((s) => sanitizeText(s))
    .filter(Boolean);

  const plan = employeeWeeklyPlan ?? {
    nextWeekPlan: '',
    problems: '',
    supportNeeded: '',
    submittedAt: null,
  };
  if (plan.problems) {
    const t = sanitizeText(`本周问题：${plan.problems}`);
    if (t && !unfinishedItems.includes(t)) unfinishedItems.push(t);
  }
  if (plan.supportNeeded) {
    const t = sanitizeText(`需主管协助：${plan.supportNeeded}`);
    if (t && !unfinishedItems.includes(t)) unfinishedItems.push(t);
  }

  const nextFromPlan = [
    plan.nextWeekPlan ? sanitizeText(`员工计划：${plan.nextWeekPlan}`) : '',
    ...nextItems,
  ].filter(Boolean).slice(0, AI_WEEKLY_TECHNICAL_MAX_ITEMS);

  let nextFocusSummary = NO_DATA_TEXT;
  if (nextFromPlan.length > 0) {
    nextFocusSummary = sanitizeText('本周按以下重点推进') || NO_DATA_TEXT;
  }

  return normalizeAiSummaryJson({
    completed: { summary: completedSummary, items: doneItems },
    unfinished: { summary: unfinishedSummary, items: unfinishedItems.slice(0, AI_WEEKLY_TECHNICAL_MAX_ITEMS) },
    nextFocus: { summary: nextFocusSummary, items: nextFromPlan },
  });
}

function buildAiReportView(params: {
  user: JwtPayload;
  employeeName: string;
  ruleSummary: RuleWeeklySummary;
  cacheId: number | null;
  sections: AiSummaryJson | null;
  generatedAt: string | null;
  source: AiReportSource;
}): AiReportView {
  return {
    id: params.cacheId,
    employee: { id: params.user.userId, name: params.employeeName },
    period: { start: params.ruleSummary.weekStart, end: params.ruleSummary.weekEnd },
    generatedAt: params.generatedAt,
    sections: params.sections,
    source: params.source,
  };
}

async function resolveEmployeeName(user: JwtPayload): Promise<string> {
  const dbUser = await prisma.user.findUnique({
    where: { id: user.userId },
    select: { name: true },
  });
  return dbUser?.name ?? user.username;
}

function isReusableCache(
  cache: { status: EmployeeWeeklyAiSummaryStatus; sourceHash: string; summaryJson: unknown } | null,
  sourceHash: string,
): boolean {
  if (!cache) return false;
  return (
    cache.status === EmployeeWeeklyAiSummaryStatus.READY &&
    cache.sourceHash === sourceHash &&
    isV3SummaryJson(cache.summaryJson)
  );
}

async function attachCacheToSummary(
  user: JwtPayload,
  ruleSummary: RuleWeeklySummary,
  cache: {
    id?: number;
    status: EmployeeWeeklyAiSummaryStatus;
    sourceHash: string;
    summaryJson: unknown;
    generatedAt: Date | null;
    errorMessage: string | null;
  } | null,
  sourceHash: string,
  employeeName?: string,
): Promise<WeeklySummaryWithAi> {
  const name = employeeName ?? await resolveEmployeeName(user);
  const employeeWeeklyPlan = await loadEmployeeWeeklyPlanForSourcePayload(user.userId, ruleSummary.weekStart);
  const fallbackSections = buildRuleFallbackSections(ruleSummary, employeeWeeklyPlan);

  const baseReport = (sections: AiSummaryJson | null, source: AiReportSource, generatedAt: string | null) =>
    buildAiReportView({
      user,
      employeeName: name,
      ruleSummary,
      cacheId: cache?.id ?? null,
      sections,
      generatedAt,
      source,
    });

  const empty = {
    aiGeneratedAt: null as string | null,
    aiSummary: null as AiSummaryJson | null,
    aiErrorMessage: null as string | null,
    aiReport: baseReport(null, null, null),
  };

  if (!cache) {
    return { ...ruleSummary, ...empty, aiStatus: 'RULE_ONLY' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.READY && cache.sourceHash === sourceHash) {
    if (isV3SummaryJson(cache.summaryJson)) {
      const sections = normalizeAiSummaryJson(cache.summaryJson);
      const generatedAt = cache.generatedAt?.toISOString() ?? null;
      return {
        ...ruleSummary,
        aiStatus: 'READY',
        aiGeneratedAt: generatedAt,
        aiSummary: sections,
        aiErrorMessage: null,
        aiReport: baseReport(sections, 'AI', generatedAt),
      };
    }
    return {
      ...ruleSummary,
      aiStatus: 'STALE',
      aiGeneratedAt: cache.generatedAt?.toISOString() ?? null,
      aiSummary: null,
      aiErrorMessage: 'AI 周报格式已过期，请重新生成',
      aiReport: baseReport(fallbackSections, 'RULE_FALLBACK', cache.generatedAt?.toISOString() ?? null),
    };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.READY && cache.sourceHash !== sourceHash) {
    return { ...ruleSummary, ...empty, aiStatus: 'RULE_ONLY' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.PENDING) {
    return { ...ruleSummary, ...empty, aiStatus: 'PENDING' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.FAILED) {
    return {
      ...ruleSummary,
      aiStatus: 'FAILED',
      aiGeneratedAt: null,
      aiSummary: null,
      aiErrorMessage: cache.errorMessage ?? 'AI 生成失败',
      aiReport: baseReport(fallbackSections, 'RULE_FALLBACK', null),
    };
  }

  return { ...ruleSummary, ...empty, aiStatus: 'RULE_ONLY' };
}

function buildDisabledSummary(ruleSummary: RuleWeeklySummary, user: JwtPayload, employeeName: string): WeeklySummaryWithAi {
  return {
    ...ruleSummary,
    aiStatus: 'NOT_ENABLED',
    aiGeneratedAt: null,
    aiSummary: null,
    aiErrorMessage: null,
    aiReport: buildAiReportView({
      user,
      employeeName,
      ruleSummary,
      cacheId: null,
      sections: null,
      generatedAt: null,
      source: null,
    }),
  };
}

export async function mergeWeeklySummaryWithAiCache(
  user: JwtPayload,
  ruleSummary: RuleWeeklySummary,
): Promise<WeeklySummaryWithAi> {
  const employeeName = await resolveEmployeeName(user);

  if (!isWeeklyAiEnabled()) {
    return buildDisabledSummary(ruleSummary, user, employeeName);
  }

  const source = await buildAiSourcePayload(user, ruleSummary);
  const sourceHash = computeSourceHash(source);
  const weekStartDate = dateStringToDbDate(ruleSummary.weekStart);

  const cache = await prisma.employeeWeeklyAiSummary.findUnique({
    where: {
      userId_weekStart: {
        userId: user.userId,
        weekStart: weekStartDate,
      },
    },
  });

  return attachCacheToSummary(user, ruleSummary, cache, sourceHash, employeeName);
}

async function callDeepSeek(source: unknown): Promise<{ content: string; inputTokens?: number; outputTokens?: number }> {
  const cfg = getAiConfig();
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY 未配置');
  }

  const response = await axios.post(
    `${cfg.baseUrl}/chat/completions`,
    {
      model: cfg.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(source) },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: cfg.timeoutMs,
    },
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI 返回内容为空');
  }

  return {
    content,
    inputTokens: response.data?.usage?.prompt_tokens,
    outputTokens: response.data?.usage?.completion_tokens,
  };
}

async function callDeepSeekAndParse(source: unknown): Promise<{
  parsed: AiSummaryJson;
  rawText: string;
  inputTokens?: number;
  outputTokens?: number;
}> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await callDeepSeek(source);
      const parsed = parseAiSummaryJson(result.content);
      return {
        parsed,
        rawText: sanitizeRawText(result.content),
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        console.warn('[weekly-ai] parse failed, retry once:', err instanceof Error ? err.message : err);
      }
    }
  }
  throw lastErr;
}

async function upsertPendingRecord(params: {
  userId: number;
  weekStart: string;
  weekEnd: string;
  sourceHash: string;
}) {
  const cfg = getAiConfig();
  const weekStartDate = dateStringToDbDate(params.weekStart);
  const weekEndDate = dateStringToDbDate(params.weekEnd);

  return prisma.employeeWeeklyAiSummary.upsert({
    where: {
      userId_weekStart: {
        userId: params.userId,
        weekStart: weekStartDate,
      },
    },
    create: {
      userId: params.userId,
      weekStart: weekStartDate,
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.PENDING,
    },
    update: {
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.PENDING,
      summaryJson: Prisma.DbNull,
      rawText: null,
      errorMessage: null,
      inputTokens: null,
      outputTokens: null,
      costEstimate: null,
      generatedAt: null,
    },
  });
}

async function upsertReadyRecord(params: {
  userId: number;
  weekStart: string;
  weekEnd: string;
  sourceHash: string;
  summaryJson: AiSummaryJson;
  rawText: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const cfg = getAiConfig();
  const generatedAt = new Date();
  const weekStartDate = dateStringToDbDate(params.weekStart);
  const weekEndDate = dateStringToDbDate(params.weekEnd);

  await prisma.employeeWeeklyAiSummary.upsert({
    where: {
      userId_weekStart: {
        userId: params.userId,
        weekStart: weekStartDate,
      },
    },
    create: {
      userId: params.userId,
      weekStart: weekStartDate,
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.READY,
      summaryJson: params.summaryJson,
      rawText: params.rawText,
      inputTokens: params.inputTokens ?? null,
      outputTokens: params.outputTokens ?? null,
      generatedAt,
    },
    update: {
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.READY,
      summaryJson: params.summaryJson,
      rawText: params.rawText,
      errorMessage: null,
      inputTokens: params.inputTokens ?? null,
      outputTokens: params.outputTokens ?? null,
      generatedAt,
    },
  });

  console.log(
    `[weekly-ai] userId=${params.userId} weekStart=${params.weekStart} hash=${params.sourceHash.slice(0, 8)} status=READY`,
  );
}

async function upsertFailedRecord(params: {
  userId: number;
  weekStart: string;
  weekEnd: string;
  sourceHash: string;
  errorMessage: string;
}) {
  const cfg = getAiConfig();
  const weekStartDate = dateStringToDbDate(params.weekStart);
  const weekEndDate = dateStringToDbDate(params.weekEnd);

  await prisma.employeeWeeklyAiSummary.upsert({
    where: {
      userId_weekStart: {
        userId: params.userId,
        weekStart: weekStartDate,
      },
    },
    create: {
      userId: params.userId,
      weekStart: weekStartDate,
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.FAILED,
      errorMessage: params.errorMessage,
    },
    update: {
      weekEnd: weekEndDate,
      sourceHash: params.sourceHash,
      provider: cfg.provider,
      model: cfg.model,
      promptVersion: cfg.promptVersion,
      status: EmployeeWeeklyAiSummaryStatus.FAILED,
      summaryJson: Prisma.DbNull,
      rawText: null,
      errorMessage: params.errorMessage,
      generatedAt: null,
    },
  });

  console.log(
    `[weekly-ai] userId=${params.userId} weekStart=${params.weekStart} hash=${params.sourceHash.slice(0, 8)} status=FAILED`,
  );
}

async function runGenerateJob(
  user: JwtPayload,
  ruleSummary: RuleWeeklySummary,
  force: boolean,
): Promise<WeeklySummaryWithAi> {
  const employeeName = await resolveEmployeeName(user);
  const employeeWeeklyPlan = await loadEmployeeWeeklyPlanForSourcePayload(user.userId, ruleSummary.weekStart);
  const source = await buildAiSourcePayload(user, ruleSummary);
  const sourceHash = computeSourceHash(source);
  const weekStartDate = dateStringToDbDate(ruleSummary.weekStart);
  const fallbackSections = buildRuleFallbackSections(ruleSummary, employeeWeeklyPlan);

  const existing = await prisma.employeeWeeklyAiSummary.findUnique({
    where: {
      userId_weekStart: {
        userId: user.userId,
        weekStart: weekStartDate,
      },
    },
  });

  if (!force && isReusableCache(existing, sourceHash)) {
    return attachCacheToSummary(user, ruleSummary, existing, sourceHash, employeeName);
  }

  await upsertPendingRecord({
    userId: user.userId,
    weekStart: ruleSummary.weekStart,
    weekEnd: ruleSummary.weekEnd,
    sourceHash,
  });

  try {
    const result = await callDeepSeekAndParse(source);

    await upsertReadyRecord({
      userId: user.userId,
      weekStart: ruleSummary.weekStart,
      weekEnd: ruleSummary.weekEnd,
      sourceHash,
      summaryJson: result.parsed,
      rawText: result.rawText,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    const cache = await prisma.employeeWeeklyAiSummary.findUnique({
      where: {
        userId_weekStart: {
          userId: user.userId,
          weekStart: weekStartDate,
        },
      },
    });

    return attachCacheToSummary(user, ruleSummary, cache, sourceHash, employeeName);
  } catch (err) {
    const errorMessage = safeErrorMessage(err);
    await upsertFailedRecord({
      userId: user.userId,
      weekStart: ruleSummary.weekStart,
      weekEnd: ruleSummary.weekEnd,
      sourceHash,
      errorMessage,
    });

    return {
      ...ruleSummary,
      aiStatus: 'FAILED',
      aiGeneratedAt: null,
      aiSummary: null,
      aiErrorMessage: errorMessage,
      aiReport: buildAiReportView({
        user,
        employeeName,
        ruleSummary,
        cacheId: existing?.id ?? null,
        sections: fallbackSections,
        generatedAt: null,
        source: 'RULE_FALLBACK',
      }),
    };
  }
}

export async function generateWeeklyAiSummary(
  user: JwtPayload,
  input: { weekStart?: unknown; force?: boolean },
): Promise<WeeklySummaryWithAi> {
  const normalizedWeekStart = normalizeWeekStartInput(input.weekStart);
  const ruleSummary = await buildRuleWeeklySummary(user, normalizedWeekStart);

  if (!isWeeklyAiEnabled()) {
    const employeeName = await resolveEmployeeName(user);
    return buildDisabledSummary(ruleSummary, user, employeeName);
  }

  const lockKey = `${user.userId}:${ruleSummary.weekStart}`;
  const existingJob = inflight.get(lockKey);
  if (existingJob) {
    return existingJob;
  }

  const jobPromise = globalLimit(() => runGenerateJob(user, ruleSummary, input.force === true));
  inflight.set(lockKey, jobPromise);

  try {
    return await jobPromise;
  } finally {
    inflight.delete(lockKey);
  }
}

/** 将 v3 sections 映射为管理端旧扁平字段（兼容未同步前端） */
export function mapV3SectionsToLegacyAdminFields(sections: AiSummaryJson | null) {
  if (!sections) {
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

  const joinParts = (parts: Array<string | null | undefined>, separator = '；') => {
    const text = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(separator);
    return text || null;
  };

  const completedText = joinParts([sections.completed.summary, ...sections.completed.items]);
  const unfinishedText = joinParts([sections.unfinished.summary, ...sections.unfinished.items]);
  const nextFocusText = joinParts([sections.nextFocus.summary, ...sections.nextFocus.items]);
  const summaryText = joinParts(
    [sections.completed.summary, sections.unfinished.summary, sections.nextFocus.summary],
    '\n\n',
  );

  return {
    summaryPreview: sections.completed.summary || null,
    summaryText,
    completedSummary: completedText,
    pendingSummary: unfinishedText,
    problemSummary: unfinishedText,
    suggestionSummary: nextFocusText,
    nextWeekPlan: sections.nextFocus.items.length > 0
      ? sections.nextFocus.items.join('；')
      : sections.nextFocus.summary || null,
  };
}
