/**
 * AI 周报 v3 验证脚本（不提交 Git）
 */
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';
import {
  buildRuleFallbackSections,
  generateWeeklyAiSummary,
  isV3SummaryJson,
  mergeWeeklySummaryWithAiCache,
} from '../src/services/weeklyAiSummaryService';
import { buildRuleWeeklySummary } from '../src/services/employeeTaskService';
import { listAdminWeeklySummaries } from '../src/services/adminWeeklySummaryService';

async function getToken(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  if (!user?.role) throw new Error('user not found');
  const perms = await prisma.rolePermission.findMany({
    where: { roleId: user.roleId },
    include: { permission: true },
  });
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      roleId: user.roleId,
      roleName: user.role.name,
      permissions: perms.map((p) => p.permission.code),
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );
}

function jwtPayload(userId: number, username: string, roleId: number, roleName: string) {
  return { userId, username, roleId, roleName, permissions: [] };
}

async function main() {
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE' },
    include: { role: true },
  });
  if (!user?.role) throw new Error('no active user');

  const payload = jwtPayload(user.id, user.username, user.roleId, user.role.name);
  const weekStart = '2026-06-02';

  console.log('=== 1. 生成 AI 周报 v3 ===');
  const gen1 = await generateWeeklyAiSummary(payload, { weekStart, force: true });
  console.log('aiStatus=', gen1.aiStatus);
  console.log('aiSummary keys=', gen1.aiSummary ? Object.keys(gen1.aiSummary) : null);
  console.log('aiReport.source=', gen1.aiReport.source);
  console.log('sections=', JSON.stringify(gen1.aiReport.sections, null, 2));

  const ok3 =
    gen1.aiSummary &&
    isV3SummaryJson(gen1.aiSummary) &&
    ['completed', 'unfinished', 'nextFocus'].every((k) => k in gen1.aiSummary!) &&
    !('overview' in (gen1.aiSummary as object));
  console.log(ok3 ? '✅ 仅三块 v3 结构' : '❌ 结构不对');

  console.log('\n=== 2. 非 force 二次调用（应读缓存）===');
  const t0 = Date.now();
  const gen2 = await generateWeeklyAiSummary(payload, { weekStart, force: false });
  console.log('elapsed ms=', Date.now() - t0, 'aiStatus=', gen2.aiStatus);
  console.log(
    gen2.aiStatus === 'READY' && gen2.aiReport.source === 'AI' ? '✅ 缓存命中' : '⚠️ 状态',
  );

  console.log('\n=== 3. force=true 重新生成 ===');
  const gen3 = await generateWeeklyAiSummary(payload, { weekStart, force: true });
  console.log(gen3.aiStatus === 'READY' ? '✅ force 重新生成成功' : '❌', gen3.aiStatus);

  console.log('\n=== 4. 管理员列表 sections ===');
  const admin = await listAdminWeeklySummaries({ weekStart, assigneeId: user.id });
  const item = admin.list[0];
  console.log('sections=', item?.sections ? Object.keys(item.sections) : null);
  console.log('summaryPreview=', item?.summaryPreview?.slice(0, 40));
  console.log(item?.sections ? '✅ admin sections 存在' : '❌ admin sections 缺失');

  console.log('\n=== 5. 规则兜底 ===');
  const rule = await buildRuleWeeklySummary(payload, weekStart);
  const fallback = buildRuleFallbackSections(rule);
  console.log('fallback=', JSON.stringify(fallback));
  console.log(isV3SummaryJson(fallback) ? '✅ 规则兜底三块结构' : '❌');

  console.log('\n=== 6. GET weekly-summary merge cache ===');
  const merged = await mergeWeeklySummaryWithAiCache(payload, rule);
  console.log('merged aiReport.source=', merged.aiReport.source);
  console.log(merged.aiReport.sections ? '✅ GET 有 sections' : '❌');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
