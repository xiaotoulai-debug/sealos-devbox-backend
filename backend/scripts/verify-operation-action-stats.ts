/**
 * 一次性验证 operationActionStats API（不提交 Git）
 */
import jwt from 'jsonwebtoken';
import { prisma } from '../src/lib/prisma';

const BASE = `http://127.0.0.1:${process.env.PORT ?? 8080}/api/store-products`;

async function main() {
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true, username: true, role: { select: { id: true, name: true } } },
  });
  if (!user?.role) throw new Error('无可用用户');

  const rolePerms = await prisma.rolePermission.findMany({
    where: { roleId: user.role.id },
    select: { permission: { select: { code: true } } },
  });
  const permissions = rolePerms.map((rp) => rp.permission.code).filter(Boolean);

  const token = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      roleId: user.role.id,
      roleName: user.role.name,
      permissions,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' },
  );

  const shop = await prisma.shopAuthorization.findFirst({ select: { id: true } });
  if (!shop) throw new Error('无店铺');
  const shopId = shop.id;

  const urls = [
    `${BASE}?shopId=${shopId}&productClass=NORMAL`,
    `${BASE}?shopId=${shopId}&productClass=CLEARANCE`,
    `${BASE}?shopId=${shopId}&productClass=CLEARANCE&operationAction=LOWER_PRICE`,
    `${BASE}?shopId=${shopId}&operationAction=ABC`,
    `${BASE}?shopId=${shopId}&productClass=CLEARANCE&page=1&pageSize=20`,
    `${BASE}?shopId=${shopId}&productClass=CLEARANCE&page=2&pageSize=20`,
    `${BASE}?shopId=${shopId}&productClass=NEW`,
  ];

  let statsPage1: string | null = null;
  let statsPage2: string | null = null;

  for (const url of urls) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    console.log('\n=====', url.replace(BASE, ''), '=====');
    console.log('HTTP', res.status, 'code=', body.code, 'message=', body.message);

    if (url.includes('operationAction=ABC')) {
      console.log(res.status === 400 ? '✅ 非法 operationAction 400' : '❌ 应返回 400');
      continue;
    }

    const data = body.data ?? {};
    const stats = data.operationActionStats ?? [];
    console.log('total=', data.total, 'list=', (data.list ?? []).length);
    console.log('stats=', JSON.stringify(stats, null, 0));

    const oldAdKeys = stats.filter((s: { action: string }) =>
      ['CREATE_AD', 'INCREASE_CPC', 'ADVERTISE'].includes(s.action),
    );
    console.log(oldAdKeys.length === 0 ? '✅ 无旧广告 action key' : '❌ 出现旧广告 key', oldAdKeys);

    const join = stats.find((s: { action: string }) => s.action === 'JOIN_CAMPAIGN');
    if (join) console.log('JOIN_CAMPAIGN label=', join.label, join.label === '参与活动' ? '✅' : '❌');

    if (url.includes('operationAction=LOWER_PRICE')) {
      const listActions = (data.list ?? []).flatMap(
        (row: { operationAdvices?: { action: string }[] }) =>
          (row.operationAdvices ?? []).map((a) => a.action),
      );
      const hasOtherInStats = stats.some(
        (s: { action: string }) => !['LOWER_PRICE'].includes(s.action) && s.count > 0,
      );
      console.log(
        'list 仅 LOWER_PRICE?',
        listActions.every((a: string) => a === 'LOWER_PRICE' || ['JOIN_CAMPAIGN', 'ADJUST_ADS', 'PAUSE_PURCHASE'].includes(a)),
      );
      console.log('stats 仍含其他动作?', hasOtherInStats ? '✅' : '❌', stats.map((s: { action: string }) => s.action));
    }

    if (url.includes('productClass=CLEARANCE') && !url.includes('operationAction') && !url.includes('page=')) {
      const expected = ['LOWER_PRICE', 'JOIN_CAMPAIGN', 'ADJUST_ADS', 'PAUSE_PURCHASE'];
      const got = stats.map((s: { action: string }) => s.action);
      for (const e of expected) {
        console.log(got.includes(e) ? `✅ CLEARANCE 含 ${e}` : `❌ CLEARANCE 缺 ${e}`);
      }
    }

    if (url.includes('page=1')) statsPage1 = JSON.stringify(stats);
    if (url.includes('page=2')) statsPage2 = JSON.stringify(stats);
  }

  console.log('\n===== 分页 stats 一致性 =====');
  console.log(statsPage1 === statsPage2 ? '✅ page1/page2 stats 一致' : '❌ stats 不一致');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
