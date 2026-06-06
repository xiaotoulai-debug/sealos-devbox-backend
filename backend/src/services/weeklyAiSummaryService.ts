import { createHash } from 'crypto';
import axios from 'axios';
import { EmployeeWeeklyAiSummaryStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { JwtPayload } from '../middleware/auth';
import { buildRuleWeeklySummary, normalizeWeekStartInput, RuleWeeklySummary } from './employeeTaskService';

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

export type AiSummaryJson = {
  overview: string;
  highlights: string[];
  risks: string[];
  completionAnalysis: string;
  nextWeekSuggestions: string[];
  managerNote: string;
};

export type WeeklySummaryWithAi = RuleWeeklySummary & {
  aiStatus: string;
  aiGeneratedAt: string | null;
  aiSummary: AiSummaryJson | null;
  aiErrorMessage: string | null;
};

const AI_TASK_LIMIT = 5;
const AI_NOTE_LIMIT = 10;
const RAW_TEXT_MAX = 8000;
const FORBIDDEN_AI_FIELDS = ['review', 'nextActions', 'suggestionText', 'content', 'markdown'];

const inflight = new Map<string, Promise<WeeklySummaryWithAi>>();

const SYSTEM_PROMPT = `你是「员工本人周报助手」，帮助员工基于结构化工作数据撰写上周个人复盘周报。
输入 JSON 中的 sourcePayload 仅包含：每日日报登记、我收到的任务、我发起/指派的任务、我参与的协同任务。不包含任何销售额、订单量、利润、GMV、转化率等销售或平台业绩数据（meta.hasSalesData=false）。
严禁推测、编造或引用任何销售表现；若数据中没有某项，不要提及。

写作视角：
- overview、highlights、risks、completionAnalysis、nextWeekSuggestions 必须使用第一人称「我」，以员工本人口吻复盘。
- 禁止使用「该员工」「他/她」「员工表现」等第三人称表述。
- 仅 managerNote 可使用克制的主管视角，给主管简短管理提醒。

字段含义：
- overview：我上周整体复盘，覆盖日报、收到任务、协同任务、指派任务。
- highlights：自我表扬；若无明显亮点，如实写「本周暂未形成明显完成亮点，需要下周补齐基础动作」，不要硬夸。
- risks：自我批评与风险，含日报缺失、任务逾期、未完成、协同停滞、指派任务未推进等。
- completionAnalysis：明确判断我本周完成情况（完成较好/一般/较差），并给出数据依据。
- nextWeekSuggestions：下周可执行的具体动作，如每天几点前提交日报、优先完成哪些任务、跟进协同、检查指派任务推进。
- managerNote：给主管的简短提醒，可提示是否需要介入、一对一沟通或拆解任务。

必须严格返回 JSON 对象，且只包含以下 6 个字段：
overview(string)、highlights(string[])、risks(string[])、completionAnalysis(string)、nextWeekSuggestions(string[])、managerNote(string)。
禁止返回 review、nextActions、suggestionText、content、markdown 或其他字段。
使用简体中文，语气专业简洁。`;

function dateStringToDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function isWeeklyAiEnabled(): boolean {
  return process.env.WEEKLY_AI_ENABLED === 'true' && Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

function getAiConfig() {
  return {
    provider: process.env.WEEKLY_AI_PROVIDER ?? 'deepseek',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    promptVersion: process.env.WEEKLY_AI_PROMPT_VERSION ?? 'v2',
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
  const overview = obj.overview;
  const highlights = obj.highlights;
  const risks = obj.risks;
  const completionAnalysis = obj.completionAnalysis;
  const nextWeekSuggestions = obj.nextWeekSuggestions;
  const managerNote = obj.managerNote;

  if (typeof overview !== 'string' || !overview.trim()) {
    throw new Error('AI 返回 overview 无效');
  }
  if (typeof completionAnalysis !== 'string' || !completionAnalysis.trim()) {
    throw new Error('AI 返回 completionAnalysis 无效');
  }
  if (typeof managerNote !== 'string') {
    throw new Error('AI 返回 managerNote 无效');
  }
  if (!Array.isArray(highlights) || !highlights.every((item) => typeof item === 'string')) {
    throw new Error('AI 返回 highlights 无效');
  }
  if (!Array.isArray(risks) || !risks.every((item) => typeof item === 'string')) {
    throw new Error('AI 返回 risks 无效');
  }
  if (!Array.isArray(nextWeekSuggestions) || !nextWeekSuggestions.every((item) => typeof item === 'string')) {
    throw new Error('AI 返回 nextWeekSuggestions 无效');
  }

  return {
    overview: overview.trim(),
    highlights,
    risks,
    completionAnalysis: completionAnalysis.trim(),
    nextWeekSuggestions,
    managerNote: managerNote.trim(),
  };
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

function isReusableCache(
  cache: { status: EmployeeWeeklyAiSummaryStatus; sourceHash: string; summaryJson: unknown } | null,
  sourceHash: string,
): boolean {
  if (!cache) return false;
  return (
    cache.status === EmployeeWeeklyAiSummaryStatus.READY &&
    cache.sourceHash === sourceHash
  );
}

function attachCacheToSummary(
  ruleSummary: RuleWeeklySummary,
  cache: {
    status: EmployeeWeeklyAiSummaryStatus;
    sourceHash: string;
    summaryJson: unknown;
    generatedAt: Date | null;
    errorMessage: string | null;
  } | null,
  sourceHash: string,
): WeeklySummaryWithAi {
  const base = {
    ...ruleSummary,
    aiGeneratedAt: null as string | null,
    aiSummary: null as AiSummaryJson | null,
    aiErrorMessage: null as string | null,
  };

  if (!cache) {
    return { ...base, aiStatus: 'RULE_ONLY' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.READY && cache.sourceHash === sourceHash) {
    return {
      ...base,
      aiStatus: 'READY',
      aiGeneratedAt: cache.generatedAt?.toISOString() ?? null,
      aiSummary: cache.summaryJson as AiSummaryJson,
    };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.READY && cache.sourceHash !== sourceHash) {
    return { ...base, aiStatus: 'RULE_ONLY' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.PENDING) {
    return { ...base, aiStatus: 'PENDING' };
  }

  if (cache.status === EmployeeWeeklyAiSummaryStatus.FAILED) {
    return {
      ...base,
      aiStatus: 'FAILED',
      aiErrorMessage: cache.errorMessage ?? 'AI 生成失败',
    };
  }

  return { ...base, aiStatus: 'RULE_ONLY' };
}

export async function mergeWeeklySummaryWithAiCache(
  user: JwtPayload,
  ruleSummary: RuleWeeklySummary,
): Promise<WeeklySummaryWithAi> {
  if (!isWeeklyAiEnabled()) {
    return {
      ...ruleSummary,
      aiStatus: 'NOT_ENABLED',
      aiGeneratedAt: null,
      aiSummary: null,
      aiErrorMessage: null,
    };
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

  return attachCacheToSummary(ruleSummary, cache, sourceHash);
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
      max_tokens: 1200,
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
  const source = await buildAiSourcePayload(user, ruleSummary);
  const sourceHash = computeSourceHash(source);
  const weekStartDate = dateStringToDbDate(ruleSummary.weekStart);

  const existing = await prisma.employeeWeeklyAiSummary.findUnique({
    where: {
      userId_weekStart: {
        userId: user.userId,
        weekStart: weekStartDate,
      },
    },
  });

  if (!force && isReusableCache(existing, sourceHash)) {
    return attachCacheToSummary(ruleSummary, existing, sourceHash);
  }

  await upsertPendingRecord({
    userId: user.userId,
    weekStart: ruleSummary.weekStart,
    weekEnd: ruleSummary.weekEnd,
    sourceHash,
  });

  try {
    const result = await callDeepSeek(source);
    const parsed = parseAiSummaryJson(result.content);
    const rawText = sanitizeRawText(result.content);

    await upsertReadyRecord({
      userId: user.userId,
      weekStart: ruleSummary.weekStart,
      weekEnd: ruleSummary.weekEnd,
      sourceHash,
      summaryJson: parsed,
      rawText,
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

    return attachCacheToSummary(ruleSummary, cache, sourceHash);
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
    return {
      ...ruleSummary,
      aiStatus: 'NOT_ENABLED',
      aiGeneratedAt: null,
      aiSummary: null,
      aiErrorMessage: null,
    };
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
