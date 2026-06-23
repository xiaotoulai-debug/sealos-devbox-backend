import cron from 'node-cron';
import { isWeeklyAiEnabled } from './weeklyAiSummaryService';

/**
 * 员工任务上周汇总 AI 定时任务框架。
 * 默认关闭（WEEKLY_AI_CRON_ENABLED !== true），当前阶段不批量生成，避免费用不可控。
 */
export function startWeeklyAiSummaryCron(): void {
  if (process.env.WEEKLY_AI_CRON_ENABLED !== 'true') {
    return;
  }

  if (!isWeeklyAiEnabled()) {
    console.log('[weekly-ai-cron] WEEKLY_AI_CRON_ENABLED=true 但 AI 未启用，跳过注册');
    return;
  }

  // 每周一 08:00 UTC 占位；Phase 1 不执行批量生成，仅注册框架
  cron.schedule('0 8 * * 1', () => {
    console.log('[weekly-ai-cron] tick skipped: batch generation disabled in phase 1');
  });

  console.log('[weekly-ai-cron] registered (batch generation disabled in phase 1)');
}
