#!/usr/bin/env npx ts-node
/**
 * 权限菜单初始化脚本
 * 将系统菜单结构以 upsert 方式写入 Permission 表，并授权给超级管理员角色。
 * 用法: npx ts-node --project tsconfig.scripts.json scripts/init-permissions.ts
 * 或   npx ts-node -e "" scripts/init-permissions.ts（见下方 skipProject）
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL   = process.env.DEST_DATABASE_URL;
}

import { PrismaClient, PermissionType } from '@prisma/client';

const prisma = new PrismaClient();

// ── 菜单定义（与前端菜单树保持 1:1 对应）─────────────────────────────
// 顶级菜单 parentCode = null；子菜单 parentCode 指向上级 code
const MENU_DEFINITIONS: {
  code: string;
  name: string;
  sortOrder: number;
  parentCode: string | null;
}[] = [
  // ── 顶级菜单 ──────────────────────────────────────────────────
  { code: 'MENU_DASHBOARD',         name: '仪表盘',     sortOrder: 1,  parentCode: null },
  { code: 'MENU_PRODUCT_DEV',       name: '产品开发',   sortOrder: 2,  parentCode: null },
  { code: 'MENU_PLATFORM_DATA',     name: '平台数据',   sortOrder: 3,  parentCode: null },
  { code: 'MENU_PURCHASING',        name: '供应采购',   sortOrder: 4,  parentCode: null },
  { code: 'MENU_USER_MANAGE',       name: '用户管理',   sortOrder: 5,  parentCode: null },
  { code: 'MENU_SYSTEM_SETTINGS',   name: '系统设置',   sortOrder: 6,  parentCode: null },

  // ── 产品开发 子菜单 ────────────────────────────────────────────
  { code: 'MENU_PUBLIC_PRODUCTS',   name: '公海产品',   sortOrder: 1,  parentCode: 'MENU_PRODUCT_DEV' },
  { code: 'MENU_INTENT_PRODUCTS',   name: '意向产品',   sortOrder: 2,  parentCode: 'MENU_PRODUCT_DEV' },
  { code: 'MENU_INVENTORY',         name: '库存 SKU',   sortOrder: 3,  parentCode: 'MENU_PRODUCT_DEV' },

  // ── 平台数据 子菜单 ────────────────────────────────────────────
  { code: 'MENU_PLATFORM_PRODUCTS', name: '平台产品',   sortOrder: 1,  parentCode: 'MENU_PLATFORM_DATA' },
  { code: 'MENU_PLATFORM_ORDERS',   name: '平台订单',   sortOrder: 2,  parentCode: 'MENU_PLATFORM_DATA' },

  // ── 供应采购 子菜单 ────────────────────────────────────────────
  { code: 'MENU_PURCHASE_PLAN',     name: '采购计划',   sortOrder: 1,  parentCode: 'MENU_PURCHASING' },
  { code: 'MENU_PURCHASE_MANAGE',   name: '采购管理',   sortOrder: 2,  parentCode: 'MENU_PURCHASING' },

  // ── 用户管理 子菜单 ────────────────────────────────────────────
  { code: 'MENU_ASSIGN_ACCOUNT',    name: '分配账号',   sortOrder: 1,  parentCode: 'MENU_USER_MANAGE' },
  { code: 'MENU_ROLE_MANAGE',       name: '角色管理',   sortOrder: 2,  parentCode: 'MENU_USER_MANAGE' },

  // ── 系统设置 子菜单 ────────────────────────────────────────────
  { code: 'MENU_SHOP_AUTH',         name: '店铺授权',   sortOrder: 1,  parentCode: 'MENU_SYSTEM_SETTINGS' },
  { code: 'MENU_1688_CONFIG',       name: '1688 配置',  sortOrder: 2,  parentCode: 'MENU_SYSTEM_SETTINGS' },
];

async function main() {
  console.log('🚀 权限菜单初始化脚本 启动\n');

  // ─────────────────────────────────────────────────────────────────
  // Step 1: 两轮 upsert（第一轮建顶级菜单，第二轮建子菜单挂 parentId）
  // ─────────────────────────────────────────────────────────────────
  console.log('📝 [1/3] Upsert 权限节点...');

  // 先 upsert 顶级菜单（parentCode === null），拿到自增 id
  const codeToId = new Map<string, number>();

  const topLevel = MENU_DEFINITIONS.filter((m) => m.parentCode === null);
  for (const m of topLevel) {
    const perm = await prisma.permission.upsert({
      where:  { code: m.code },
      update: { name: m.name, sortOrder: m.sortOrder, type: PermissionType.MENU },
      create: { code: m.code, name: m.name, sortOrder: m.sortOrder, type: PermissionType.MENU },
    });
    codeToId.set(perm.code, perm.id);
    console.log(`   ✔ [顶级] ${perm.name}（${perm.code}）id=${perm.id}`);
  }

  // 再 upsert 子菜单，关联 parentId
  const subLevel = MENU_DEFINITIONS.filter((m) => m.parentCode !== null);
  for (const m of subLevel) {
    const parentId = codeToId.get(m.parentCode!);
    if (!parentId) {
      console.warn(`   ⚠ 找不到父节点 ${m.parentCode}，跳过 ${m.code}`);
      continue;
    }
    const perm = await prisma.permission.upsert({
      where:  { code: m.code },
      update: { name: m.name, sortOrder: m.sortOrder, type: PermissionType.MENU, parentId },
      create: { code: m.code, name: m.name, sortOrder: m.sortOrder, type: PermissionType.MENU, parentId },
    });
    codeToId.set(perm.code, perm.id);
    console.log(`   ✔ [子级] ${perm.name}（${perm.code}）parentId=${parentId}`);
  }

  const allIds = [...codeToId.values()];
  console.log(`\n   ✅ 共 upsert ${allIds.length} 个权限节点\n`);

  // ─────────────────────────────────────────────────────────────────
  // Step 2: 找到超级管理员角色
  // ─────────────────────────────────────────────────────────────────
  console.log('👑 [2/3] 查找超级管理员角色...');
  const superAdminRole = await prisma.role.findFirst({
    where: { name: { contains: '超级管理员' } },
  });

  if (!superAdminRole) {
    console.error('   ❌ 未找到「超级管理员」角色！请先运行 prisma/seed.ts 创建基础角色。');
    process.exit(1);
  }
  console.log(`   ✅ 找到角色「${superAdminRole.name}」(id=${superAdminRole.id})\n`);

  // ─────────────────────────────────────────────────────────────────
  // Step 3: 将所有菜单权限授权给超级管理员（upsert 防止重复）
  // ─────────────────────────────────────────────────────────────────
  console.log('🔗 [3/3] 授权给超级管理员...');
  let granted = 0;
  for (const permId of allIds) {
    await prisma.rolePermission.upsert({
      where:  { roleId_permissionId: { roleId: superAdminRole.id, permissionId: permId } },
      update: {},
      create: { roleId: superAdminRole.id, permissionId: permId },
    });
    granted++;
  }
  console.log(`   ✅ 已向「${superAdminRole.name}」授权 ${granted} 个菜单权限\n`);

  // ── 输出摘要 ────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 权限菜单初始化完成！');
  console.log(`   权限节点总数 : ${allIds.length}`);
  console.log(`   授权角色     : ${superAdminRole.name}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('\n❌ 脚本执行失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
