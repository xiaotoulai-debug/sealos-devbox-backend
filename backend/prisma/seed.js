"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('🌱 开始执行数据库 Seed...\n');
    // ============================================================
    // Step 1: 清理旧数据
    // 必须严格按外键约束的反向顺序删除，防止 FK 冲突
    // ============================================================
    console.log('🧹 [1/4] 清理旧数据...');
    await prisma.product.deleteMany(); // products -> users (FK)
    await prisma.user.deleteMany(); // users -> roles (FK)
    await prisma.rolePermission.deleteMany(); // role_permissions -> roles & permissions (FK)
    await prisma.role.deleteMany(); // roles（此时已无子表引用）
    // permissions 有自关联（parentId），必须先解除父子关系再删除
    await prisma.permission.updateMany({ data: { parentId: null } });
    await prisma.permission.deleteMany();
    console.log('   ✅ 清理完成\n');
    // ============================================================
    // Step 2: 创建权限节点（树状结构）
    // 层级：ALL_ROOT → 二级菜单 → 操作按钮
    // ============================================================
    console.log('🔐 [2/4] 创建权限节点...');
    // 根节点：超级权限（无父节点，超管专属）
    const permAllRoot = await prisma.permission.create({
        data: {
            code: 'ALL_ROOT',
            name: '超级权限根节点',
            type: client_1.PermissionType.MENU,
            sortOrder: 0,
        },
    });
    // 二级菜单：账号管理
    const permManageUsers = await prisma.permission.create({
        data: {
            code: 'MANAGE_USERS',
            name: '账号管理',
            type: client_1.PermissionType.MENU,
            sortOrder: 1,
            parentId: permAllRoot.id,
        },
    });
    // 二级菜单：公海产品池
    const permViewPublicPool = await prisma.permission.create({
        data: {
            code: 'VIEW_PUBLIC_POOL',
            name: '查看公海产品',
            type: client_1.PermissionType.MENU,
            sortOrder: 2,
            parentId: permAllRoot.id,
        },
    });
    // 操作级权限（挂载到"账号管理"下）
    const permBtnCreateUser = await prisma.permission.create({
        data: {
            code: 'BTN_CREATE_USER',
            name: '创建账号',
            type: client_1.PermissionType.BUTTON,
            sortOrder: 1,
            parentId: permManageUsers.id,
        },
    });
    const permBtnToggleUser = await prisma.permission.create({
        data: {
            code: 'BTN_TOGGLE_USER',
            name: '启用/禁用账号',
            type: client_1.PermissionType.BUTTON,
            sortOrder: 2,
            parentId: permManageUsers.id,
        },
    });
    // 操作级权限（挂载到"公海产品池"下）
    const permBtnSelectProduct = await prisma.permission.create({
        data: {
            code: 'BTN_SELECT_PRODUCT',
            name: '加入私有入选池',
            type: client_1.PermissionType.BUTTON,
            sortOrder: 1,
            parentId: permViewPublicPool.id,
        },
    });
    // 数据级权限：隐藏价格（全局）
    const permDataHidePrice = await prisma.permission.create({
        data: {
            code: 'DATA_HIDE_PRICE',
            name: '隐藏产品价格字段',
            type: client_1.PermissionType.DATA,
            sortOrder: 1,
            parentId: permViewPublicPool.id,
        },
    });
    const allPermissions = [
        permAllRoot,
        permManageUsers,
        permViewPublicPool,
        permBtnCreateUser,
        permBtnToggleUser,
        permBtnSelectProduct,
        permDataHidePrice,
    ];
    console.log(`   ✅ 已创建 ${allPermissions.length} 个权限节点\n`);
    // ============================================================
    // Step 3: 创建超级管理员角色，并绑定全部权限
    // ============================================================
    console.log('👑 [3/4] 创建角色并绑定权限...');
    const adminRole = await prisma.role.create({
        data: {
            name: '超级管理员',
            description: '系统预置角色，拥有全部权限，不可删除',
        },
    });
    await prisma.rolePermission.createMany({
        data: allPermissions.map((perm) => ({
            roleId: adminRole.id,
            permissionId: perm.id,
        })),
    });
    console.log(`   ✅ 角色「${adminRole.name}」已绑定 ${allPermissions.length} 个权限\n`);
    // ============================================================
    // Step 4: 创建管理员账号（密码使用 bcrypt 哈希）
    // ============================================================
    console.log('👤 [4/4] 创建管理员账号...');
    const passwordHash = await bcryptjs_1.default.hash('123456', 10);
    await prisma.user.create({
        data: {
            username: 'admin',
            passwordHash,
            name: '超级管理员',
            status: 'ACTIVE',
            roleId: adminRole.id,
        },
    });
    console.log('   ✅ 账号创建完成\n');
    // ============================================================
    // 输出初始化结果摘要
    // ============================================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 Seed 全部执行完毕！');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('   登录账号 : admin');
    console.log('   登录密码 : 123456');
    console.log(`   绑定角色 : ${adminRole.name}`);
    console.log(`   权限数量 : ${allPermissions.length} 个节点`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // ============================================================
    // Step 5: 插入示例公海产品
    // ============================================================
    console.log('\n📦 [5/5] 插入示例公海产品...');
    const sampleProducts = [
        { pnk: 'PNK-001', title: 'Sony WH-1000XM5 头戴式降噪耳机', brand: 'Sony', category: '消费电子', price: 2399, costPrice: 1580, stock: 120, rating: 4.8, reviewCount: 3842, tags: ['耳机', '降噪', '热销'] },
        { pnk: 'PNK-002', title: 'Bosch 18V 无线电动工具六件套装', brand: 'Bosch', category: '电动工具', price: 4680, costPrice: 3100, stock: 55, rating: 4.7, reviewCount: 1256, tags: ['工具', '套装'] },
        { pnk: 'PNK-003', title: 'Philips AC2958 空气净化器（欧标）', brand: 'Philips', category: '家用电器', price: 1299, costPrice: 820, stock: 88, rating: 4.5, reviewCount: 654, tags: ['净化器', '家电'] },
        { pnk: 'PNK-004', title: 'LEGO Technic 42130 宝马 M1000RR 摩托', brand: 'LEGO', category: '玩具', price: 899, costPrice: 540, stock: 200, rating: 4.9, reviewCount: 5621, tags: ['积木', '热销', '礼品'] },
        { pnk: 'PNK-005', title: 'Dyson V15 Detect 无线吸尘器', brand: 'Dyson', category: '家用电器', price: 5490, costPrice: 3800, stock: 42, rating: 4.8, reviewCount: 2103, tags: ['吸尘器', '热销'] },
        { pnk: 'PNK-006', title: 'De\'Longhi ECAM 22.110.B 全自动咖啡机', brand: "De'Longhi", category: '厨房电器', price: 3200, costPrice: 2050, stock: 67, rating: 4.6, reviewCount: 987, tags: ['咖啡机', '厨电'] },
        { pnk: 'PNK-007', title: 'Garmin Fenix 7 GPS 运动手表', brand: 'Garmin', category: '运动健康', price: 6800, costPrice: 4600, stock: 30, rating: 4.7, reviewCount: 1432, tags: ['手表', '运动', 'GPS'] },
    ];
    await prisma.product.createMany({
        data: sampleProducts.map((p) => ({
            pnk: p.pnk,
            title: p.title,
            brand: p.brand,
            category: p.category,
            price: p.price,
            costPrice: p.costPrice,
            stock: p.stock,
            rating: p.rating,
            reviewCount: p.reviewCount,
            tags: p.tags,
            status: 'PENDING',
        })),
        skipDuplicates: true,
    });
    console.log(`   ✅ 已插入 ${sampleProducts.length} 条示例产品\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}
main()
    .catch((e) => {
    console.error('\n❌ Seed 执行失败:', e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map