import { PrismaClient } from '@prisma/client';
import { generateWeeklyAiSummary } from '../src/services/weeklyAiSummaryService';
import { getEmployeeTaskWeeklySummary } from '../src/services/employeeTaskService';
import { listAdminWeeklySummaries } from '../src/services/adminWeeklySummaryService';

const prisma = new PrismaClient();

async function main() {
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
  console.log('env WEEKLY_AI_PROMPT_VERSION=', process.env.WEEKLY_AI_PROMPT_VERSION ?? '(unset, code default v3.2)');

  const gen = await generateWeeklyAiSummary(payload, { weekStart, force: true });
  const s = gen.aiReport.sections;
  console.log('aiStatus=', gen.aiStatus, 'source=', gen.aiReport.source);
  console.log('blocks=', s ? Object.keys(s) : null);

  if (s) {
    const maxSummary = Math.max(s.completed.summary.length, s.unfinished.summary.length, s.nextFocus.summary.length);
    const allItems = [...s.completed.items, ...s.unfinished.items, ...s.nextFocus.items];
    const maxItem = allItems.reduce((m, i) => Math.max(m, i.length), 0);
    console.log('maxSummary len=', maxSummary, 'maxItem len=', maxItem);
    console.log('item counts=', [s.completed.items.length, s.unfinished.items.length, s.nextFocus.items.length]);
    const ell = JSON.stringify(s).includes('...') || JSON.stringify(s).includes('…');
    console.log(ell ? '❌ ellipsis in JSON' : '✅ no ellipsis');
  }

  const get = await getEmployeeTaskWeeklySummary(payload, { weekStart });
  const admin = await listAdminWeeklySummaries({ weekStart, assigneeId: user.id });
  console.log('GET aiReport.sections=', !!get.aiReport.sections);
  console.log('admin sections=', !!admin.list[0]?.sections);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
