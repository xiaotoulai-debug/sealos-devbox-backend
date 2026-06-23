/**
 * 安全补充角色脚本（幂等）
 * 使用 upsert，不会清空任何现有数据。
 * 运行：npx tsx prisma/addRoles.ts
 */
import { PrismaClient, PermissionType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔧 开始同步角色与权限...\n');

  // ── 确保超级管理员角色存在 ───────────────────────────────
  const adminRole = await prisma.role.upsert({
    where:  { name: '超级管理员' },
    update: {},
    create: { name: '超级管理员', description: '系统预置角色，拥有全部权限' },
  });

  // ── 确保普通员工角色存在 ─────────────────────────────────
  const staffRole = await prisma.role.upsert({
    where:  { name: '普通员工' },
    update: {},
    create: { name: '普通员工', description: '基础操作角色，可查看公海产品并加入入选池' },
  });

  // ── 确保核心权限节点存在 ─────────────────────────────────
  const permViewPool = await prisma.permission.upsert({
    where:  { code: 'VIEW_PUBLIC_POOL' },
    update: {},
    create: { code: 'VIEW_PUBLIC_POOL', name: '查看公海产品', type: PermissionType.MENU, sortOrder: 2 },
  });

  const permBtnSelect = await prisma.permission.upsert({
    where:  { code: 'BTN_SELECT_PRODUCT' },
    update: {},
    create: {
      code: 'BTN_SELECT_PRODUCT', name: '加入私有入选池',
      type: PermissionType.BUTTON, sortOrder: 1,
      parentId: permViewPool.id,
    },
  });

  // ── 为普通员工绑定基础权限（跳过已存在的绑定）─────────────
  const staffPerms = [permViewPool, permBtnSelect];
  for (const perm of staffPerms) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: staffRole.id, permissionId: perm.id } },
      update: {},
      create: { roleId: staffRole.id, permissionId: perm.id },
    });
  }

  console.log(`✅ 角色「${adminRole.name}」(ID: ${adminRole.id})`);
  console.log(`✅ 角色「${staffRole.name}」(ID: ${staffRole.id}) 已绑定 ${staffPerms.length} 个权限`);
  console.log('\n🎉 角色同步完成，现有产品数据未受影响！');
}

main()
  .catch((e) => { console.error('❌ 执行失败:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
