#!/usr/bin/env npx ts-node
/**
 * 权限菜单初始化脚本
 * 将系统菜单结构以 upsert 方式写入 Permission 表，并授权给超级管理员角色。
 * 用法: npx tsx scripts/init-permissions.ts
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL   = process.env.DEST_DATABASE_URL;
}

import { PrismaClient, PermissionType } from '@prisma/client';

const prisma = new PrismaClient();

const MENU_DEFINITIONS: {
  code: string;
  name: string;
  sortOrder: number;
  parentCode: string | null;
}[] = [
  { code: 'MENU_DASHBOARD',         name: '仪表盘',     sortOrder: 1,  parentCode: null },
  { code: 'MENU_PRODUCT_DEV',       name: '产品开发',   sortOrder: 2,  parentCode: null },
  { code: 'MENU_PLATFORM_DATA',     name: '平台数据',   sortOrder: 3,  parentCode: null },
  { code: 'MENU_PURCHASING',        name: '供应采购',   sortOrder: 4,  parentCode: null },
  { code: 'MENU_USER_MANAGE',       name: '用户管理',   sortOrder: 5,  parentCode: null },
  { code: 'MENU_SYSTEM_SETTINGS',   name: '系统设置',   sortOrder: 6,  parentCode: null },

  { code: 'MENU_DASHBOARD_DAILY',              name: '每日登记', sortOrder: 1, parentCode: 'MENU_DASHBOARD' },
  { code: 'MENU_DASHBOARD_TASK_CENTER',        name: '个人任务', sortOrder: 2, parentCode: 'MENU_DASHBOARD' },
  { code: 'MENU_DASHBOARD_COMPANY_MANAGEMENT', name: '团队任务', sortOrder: 3, parentCode: 'MENU_DASHBOARD' },

  { code: 'MENU_PUBLIC_PRODUCTS',   name: '公海产品',   sortOrder: 1,  parentCode: 'MENU_PRODUCT_DEV' },
  { code: 'MENU_INTENT_PRODUCTS',   name: '意向产品',   sortOrder: 2,  parentCode: 'MENU_PRODUCT_DEV' },
  { code: 'MENU_INVENTORY',         name: '库存 SKU',   sortOrder: 3,  parentCode: 'MENU_PRODUCT_DEV' },

  { code: 'MENU_PLATFORM_PRODUCTS', name: '平台产品',   sortOrder: 1,  parentCode: 'MENU_PLATFORM_DATA' },
  { code: 'MENU_PLATFORM_ORDERS',   name: '平台订单',   sortOrder: 2,  parentCode: 'MENU_PLATFORM_DATA' },

  { code: 'MENU_PURCHASE_PLAN',     name: '采购计划',   sortOrder: 1,  parentCode: 'MENU_PURCHASING' },
  { code: 'MENU_PURCHASE_MANAGE',   name: '采购管理',   sortOrder: 2,  parentCode: 'MENU_PURCHASING' },

  { code: 'MENU_ASSIGN_ACCOUNT',    name: '分配账号',   sortOrder: 1,  parentCode: 'MENU_USER_MANAGE' },
  { code: 'MENU_ROLE_MANAGE',       name: '角色管理',   sortOrder: 2,  parentCode: 'MENU_USER_MANAGE' },
  { code: 'MENU_ADMIN_EMPLOYEE_TASKS', name: '管理员工任务', sortOrder: 3, parentCode: 'MENU_USER_MANAGE' },

  { code: 'MENU_SHOP_AUTH',         name: '店铺授权',   sortOrder: 1,  parentCode: 'MENU_SYSTEM_SETTINGS' },
  { code: 'MENU_1688_CONFIG',       name: '1688 配置',  sortOrder: 2,  parentCode: 'MENU_SYSTEM_SETTINGS' },

  { code: 'MENU_WAREHOUSE',         name: '仓储管理',   sortOrder: 7,  parentCode: null },

  { code: 'MENU_WAREHOUSE_LIST',    name: '仓库列表',   sortOrder: 1,  parentCode: 'MENU_WAREHOUSE' },
  { code: 'MENU_FBE_SHIPMENTS',     name: 'FBE 发货单', sortOrder: 2,  parentCode: 'MENU_WAREHOUSE' },
];

const BUTTON_DEFINITIONS: {
  code: string;
  name: string;
  sortOrder: number;
  parentCode: string;
}[] = [
  {
    code: 'ACTION_DASHBOARD_REMINDER_TEMPLATE_MANAGE',
    name: '管理提醒模板',
    sortOrder: 1,
    parentCode: 'MENU_DASHBOARD_TASK_CENTER',
  },
  {
    code: 'ACTION_DASHBOARD_COMPANY_TASK_MANAGE',
    name: '团队任务-任务管理',
    sortOrder: 1,
    parentCode: 'MENU_DASHBOARD_COMPANY_MANAGEMENT',
  },
  {
    code: 'ACTION_DASHBOARD_COMPANY_WEEKLY_AI_GENERATE',
    name: '团队任务-生成AI周报',
    sortOrder: 2,
    parentCode: 'MENU_DASHBOARD_COMPANY_MANAGEMENT',
  },
];

const SUPERVISOR_ROLE_NAMES = ['运营主管', '仓库主管'] as const;

const SUPERVISOR_DEFAULT_PERMISSION_CODES = [
  'MENU_DASHBOARD',
  'MENU_DASHBOARD_DAILY',
  'MENU_DASHBOARD_TASK_CENTER',
  'MENU_DASHBOARD_COMPANY_MANAGEMENT',
  'ACTION_DASHBOARD_REMINDER_TEMPLATE_MANAGE',
  'ACTION_DASHBOARD_COMPANY_TASK_MANAGE',
  'ACTION_DASHBOARD_COMPANY_WEEKLY_AI_GENERATE',
] as const;

async function grantPermissions(roleId: number, permissionIds: number[]) {
  for (const permissionId of permissionIds) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      update: {},
      create: { roleId, permissionId },
    });
  }
}

async function main() {
  console.log('🚀 权限菜单初始化脚本 启动\n');
  console.log('📝 [1/4] Upsert 权限节点...');

  const codeToId = new Map<string, number>();

  for (const menu of MENU_DEFINITIONS.filter((item) => item.parentCode === null)) {
    const perm = await prisma.permission.upsert({
      where: { code: menu.code },
      update: { name: menu.name, sortOrder: menu.sortOrder, type: PermissionType.MENU, parentId: null },
      create: { code: menu.code, name: menu.name, sortOrder: menu.sortOrder, type: PermissionType.MENU },
    });
    codeToId.set(perm.code, perm.id);
    console.log(`   ✔ [顶级] ${perm.name}（${perm.code}）id=${perm.id}`);
  }

  for (const menu of MENU_DEFINITIONS.filter((item) => item.parentCode !== null)) {
    const parentId = codeToId.get(menu.parentCode!);
    if (!parentId) {
      console.warn(`   ⚠ 找不到父节点 ${menu.parentCode}，跳过 ${menu.code}`);
      continue;
    }
    const perm = await prisma.permission.upsert({
      where: { code: menu.code },
      update: { name: menu.name, sortOrder: menu.sortOrder, type: PermissionType.MENU, parentId },
      create: { code: menu.code, name: menu.name, sortOrder: menu.sortOrder, type: PermissionType.MENU, parentId },
    });
    codeToId.set(perm.code, perm.id);
    console.log(`   ✔ [子级] ${perm.name}（${perm.code}）parentId=${parentId}`);
  }

  for (const button of BUTTON_DEFINITIONS) {
    const parentId = codeToId.get(button.parentCode);
    if (!parentId) {
      console.warn(`   ⚠ 找不到父节点 ${button.parentCode}，跳过 ${button.code}`);
      continue;
    }
    const perm = await prisma.permission.upsert({
      where: { code: button.code },
      update: { name: button.name, sortOrder: button.sortOrder, type: PermissionType.BUTTON, parentId },
      create: { code: button.code, name: button.name, sortOrder: button.sortOrder, type: PermissionType.BUTTON, parentId },
    });
    codeToId.set(perm.code, perm.id);
    console.log(`   ✔ [按钮] ${perm.name}（${perm.code}）parentId=${parentId}`);
  }

  const allPermissionIds = [...codeToId.values()];
  console.log(`\n   ✅ 共 upsert ${allPermissionIds.length} 个权限节点\n`);

  console.log('👑 [2/4] 查找超级管理员角色...');
  const superAdminRole = await prisma.role.findFirst({
    where: { name: { contains: '超级管理员' } },
  });
  if (!superAdminRole) {
    console.error('   ❌ 未找到「超级管理员」角色！请先运行 prisma/seed.ts 创建基础角色。');
    process.exit(1);
  }
  console.log(`   ✅ 找到角色「${superAdminRole.name}」(id=${superAdminRole.id})\n`);

  console.log('🔗 [3/4] 授权给超级管理员...');
  await grantPermissions(superAdminRole.id, allPermissionIds);
  console.log(`   ✅ 已向「${superAdminRole.name}」授权 ${allPermissionIds.length} 个权限\n`);

  console.log('👥 [4/4] upsert 运营主管/仓库主管并赋权...');
  for (const roleName of SUPERVISOR_ROLE_NAMES) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName, description: `${roleName}，默认拥有仪表盘公司管理与任务中心相关权限` },
    });
    const permissionIds = SUPERVISOR_DEFAULT_PERMISSION_CODES
      .map((code) => codeToId.get(code))
      .filter((id): id is number => typeof id === 'number');
    await grantPermissions(role.id, permissionIds);
    console.log(`   ✅ 「${role.name}」已授权 ${permissionIds.length} 个仪表盘相关权限`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 权限菜单初始化完成！');
  console.log(`   权限节点总数 : ${allPermissionIds.length}`);
  console.log(`   超级管理员   : ${superAdminRole.name}`);
  console.log(`   主管角色     : ${SUPERVISOR_ROLE_NAMES.join('、')}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('\n❌ 脚本执行失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
