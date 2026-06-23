/**
 * 验证 AI 周报 v3.1 长度放宽（不提交 Git）
 */
import { PrismaClient } from '@prisma/client';
import { generateWeeklyAiSummary } from '../src/services/weeklyAiSummaryService';
import { listAdminWeeklySummaries } from '../src/services/adminWeeklySummaryService';
import { getEmployeeTaskWeeklySummary } from '../src/services/employeeTaskService';

const prisma = new PrismaClient();

function maxLen(sections: { completed: { summary: string; items: string[] }; unfinished: { summary: string; items: string[] }; nextFocus: { summary: string; items: string[] } } | null) {
  if (!sections) return { summary: 0, item: 0 };
  let summary = 0;
  let item = 0;
  for (const key of ['completed', 'unfinished', 'nextFocus'] as const) {
    summary = Math.max(summary, sections[key].summary.length);
    for (const i of sections[key].items) item = Math.max(item, i.length);
  }
  return { summary, item };
}

async function main() {
  const promptVersion = process.env.WEEKLY_AI_PROMPT_VERSION ?? 'v3.1';
  console.log('effective promptVersion=', promptVersion, '(env override:', process.env.WEEKLY_AI_PROMPT_VERSION ?? 'none', ')');

  const user = await prisma.user.findFirst({ where: { status: 'ACTIVE' }, include: { role: true } });
  if (!user?.role) throw new Error('no user');
  const payload = {
    userId: user.id,
    username: user.username,
    roleId: user.roleId,
    roleName: user.role.name,
    permissions: [] as string[],
  };
  const weekStart = '2026-06-02';

  console.log('\n=== force=true 重新生成 ===');
  const gen = await generateWeeklyAiSummary(payload, { weekStart, force: true });
  const sections = gen.aiReport.sections;
  console.log('aiStatus=', gen.aiStatus, 'source=', gen.aiReport.source);
  console.log('keys=', sections ? Object.keys(sections) : null);
  const lens = maxLen(sections);
  console.log('max summary len=', lens.summary, 'max item len=', lens.item);
  console.log('sample completed.summary=', sections?.completed.summary);
  console.log('items counts=', sections ? [sections.completed.items.length, sections.unfinished.items.length, sections.nextFocus.items.length] : null);

  const okStructure = sections && ['completed', 'unfinished', 'nextFocus'].every((k) => k in sections);
  const okItems = sections && [sections.completed, sections.unfinished, sections.nextFocus].every((s) => s.items.length <= 3);
  const okLen = lens.summary <= 120 && lens.item <= 120;
  console.log(okStructure ? '✅ 三块结构' : '❌ 结构');
  console.log(okItems ? '✅ items<=3' : '❌ items');
  console.log(okLen ? '✅ 长度<=120' : '❌ 超长');

  console.log('\n=== GET weekly-summary ===');
  const getSummary = await getEmployeeTaskWeeklySummary(payload, { weekStart });
  const getLens = maxLen(getSummary.aiReport.sections);
  console.log('GET max summary=', getLens.summary, 'max item=', getLens.item);

  console.log('\n=== admin-weekly-summaries ===');
  const admin = await listAdminWeeklySummaries({ weekStart, assigneeId: user.id });
  const adminSections = admin.list[0]?.sections ?? null;
  const adminLens = maxLen(adminSections);
  console.log('admin max summary=', adminLens.summary, 'admin sections present=', !!adminSections);

  console.log('\n=== 非 force 缓存 ===');
  const cached = await generateWeeklyAiSummary(payload, { weekStart, force: false });
  console.log('cached aiStatus=', cached.aiStatus, 'same summary=', cached.aiReport.sections?.completed.summary === sections?.completed.summary ? '✅' : '⚠️');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
