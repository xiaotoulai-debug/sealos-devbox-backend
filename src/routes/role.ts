import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

/** 系统预置超管角色名，禁止删除 */
const PROTECTED_ROLE_NAME = '超级管理员';

// ── GET /api/roles ────────────────────────────────────────────
// 获取所有角色列表，附带每个角色绑定的权限数量和用户数量
router.get('/', async (_req: Request, res: Response) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { id: 'asc' },
      select: {
        id:          true,
        name:        true,
        description: true,
        createdAt:   true,
        _count: {
          select: { permissions: true, users: true },
        },
      },
    });
    res.json({ code: 200, data: roles, message: 'success' });
  } catch (err) {
    console.error('[GET /api/roles]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/roles ───────────────────────────────────────────
// 新增角色，接收 name（必填）和 description（可选）
router.post('/', async (req: Request, res: Response) => {
  try {
    const name        = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : null;

    if (!name) {
      res.status(400).json({ code: 400, data: null, message: '角色名称不能为空' });
      return;
    }

    const role = await prisma.role.create({
      data: { name, description: description || null },
      select: { id: true, name: true, description: true, createdAt: true },
    });

    res.json({ code: 200, data: role, message: `角色「${role.name}」已创建` });
  } catch (err: unknown) {
    const pe = err as { code?: string };
    if (pe.code === 'P2002') {
      res.status(409).json({ code: 409, data: null, message: '角色名称已存在，请换一个' });
      return;
    }
    console.error('[POST /api/roles]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/roles/:id ───────────────────────────────────────
// 查询单个角色详情，含已绑定的权限 ID 列表（供前端权限回显打勾）
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ code: 400, data: null, message: '角色 ID 无效' });
    return;
  }

  try {
    const role = await prisma.role.findUnique({
      where: { id },
      select: {
        id:          true,
        name:        true,
        description: true,
        createdAt:   true,
        permissions: {
          select: {
            permissionId: true,
            permission: {
              select: { code: true, name: true, type: true },
            },
          },
        },
        _count: { select: { users: true } },
      },
    });

    if (!role) {
      res.status(404).json({ code: 404, data: null, message: '角色不存在' });
      return;
    }

    // 将中间表展平：同时输出 permissionIds 数组与 permissions 详情数组，方便前端双用途
    const permissionIds   = role.permissions.map((rp) => rp.permissionId);
    const permissionCodes = role.permissions.map((rp) => rp.permission.code);

    res.json({
      code: 200,
      data: {
        id:             role.id,
        name:           role.name,
        description:    role.description,
        createdAt:      role.createdAt,
        userCount:      role._count.users,
        permissionIds,           // [1, 2, 3, ...]  — 供 CheckboxTree 回显
        permissionCodes,         // ['MENU_DASHBOARD', ...]  — 供按 code 判断的场景
        permissions:    role.permissions.map((rp) => ({
          id:   rp.permissionId,
          code: rp.permission.code,
          name: rp.permission.name,
          type: rp.permission.type,
        })),
      },
      message: 'success',
    });
  } catch (err) {
    console.error('[GET /api/roles/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/roles/:id ────────────────────────────────────────
// 编辑角色名称或描述
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ code: 400, data: null, message: '角色 ID 无效' });
    return;
  }

  try {
    const existing = await prisma.role.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ code: 404, data: null, message: '角色不存在' });
      return;
    }

    const name        = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const description = req.body?.description !== undefined
      ? (typeof req.body.description === 'string' ? req.body.description.trim() || null : null)
      : undefined;

    if (name !== undefined && !name) {
      res.status(400).json({ code: 400, data: null, message: '角色名称不能为空' });
      return;
    }

    const data: { name?: string; description?: string | null } = {};
    if (name !== undefined)        data.name        = name;
    if (description !== undefined) data.description = description;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ code: 400, data: null, message: '没有需要更新的字段' });
      return;
    }

    const updated = await prisma.role.update({
      where: { id },
      data,
      select: { id: true, name: true, description: true, createdAt: true },
    });

    res.json({ code: 200, data: updated, message: `角色「${updated.name}」已更新` });
  } catch (err: unknown) {
    const pe = err as { code?: string };
    if (pe.code === 'P2002') {
      res.status(409).json({ code: 409, data: null, message: '角色名称已存在，请换一个' });
      return;
    }
    console.error('[PUT /api/roles/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── DELETE /api/roles/:id ─────────────────────────────────────
// 删除角色；超管角色（name === '超级管理员'）受保护，禁止删除
// 若角色下还有关联用户，同样拒绝删除（要求先迁移用户角色）
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ code: 400, data: null, message: '角色 ID 无效' });
    return;
  }

  try {
    const existing = await prisma.role.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });

    if (!existing) {
      res.status(404).json({ code: 404, data: null, message: '角色不存在' });
      return;
    }

    if (existing.name === PROTECTED_ROLE_NAME) {
      res.status(403).json({ code: 403, data: null, message: `「${PROTECTED_ROLE_NAME}」是系统预置角色，禁止删除` });
      return;
    }

    if (existing._count.users > 0) {
      res.status(409).json({
        code: 409,
        data: { userCount: existing._count.users },
        message: `该角色下还有 ${existing._count.users} 名用户，请先将他们迁移到其他角色再删除`,
      });
      return;
    }

    await prisma.role.delete({ where: { id } });

    res.json({ code: 200, data: null, message: `角色「${existing.name}」已删除` });
  } catch (err) {
    console.error('[DELETE /api/roles/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/roles/:id/permissions ───────────────────────────
// 覆盖式更新角色权限（先清后写，事务保证原子性）
// Body: { permissionIds: number[] }
// 安全：超级管理员角色的权限禁止通过此接口修改
router.put('/:id/permissions', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ code: 400, data: null, message: '角色 ID 无效' });
    return;
  }

  const raw = req.body?.permissionIds;
  if (!Array.isArray(raw)) {
    res.status(400).json({ code: 400, data: null, message: 'permissionIds 必须是数组' });
    return;
  }

  const permissionIds: number[] = raw
    .map((v: unknown) => Number(v))
    .filter((v: number) => Number.isInteger(v) && v > 0);

  try {
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) {
      res.status(404).json({ code: 404, data: null, message: '角色不存在' });
      return;
    }

    if (role.name === PROTECTED_ROLE_NAME) {
      res.status(403).json({
        code: 403,
        data: null,
        message: `「${PROTECTED_ROLE_NAME}」是系统预置角色，其权限不允许修改`,
      });
      return;
    }

    // 事务：先清空该角色所有权限关联，再批量写入新的
    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });

      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
          skipDuplicates: true,
        });
      }
    });

    res.json({
      code: 200,
      data: { roleId: id, permissionCount: permissionIds.length },
      message: `角色「${role.name}」权限已更新，共绑定 ${permissionIds.length} 个权限`,
    });
  } catch (err) {
    console.error('[PUT /api/roles/:id/permissions]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
