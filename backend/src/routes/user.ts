import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { authenticate, requirePermission } from '../middleware/auth';

const router = Router();

// 所有用户接口必须登录，且需要 MANAGE_USERS 权限
router.use(authenticate);
router.use(requirePermission('MANAGE_USERS'));

// ── GET /api/users  ─────────────────────────────────────────
// 分页获取用户列表（含角色信息）
router.get('/', async (req: Request, res: Response) => {
  const page     = Math.max(1, parseInt(String(req.query.page     ?? 1), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 15), 10) || 15));
  const skip     = (page - 1) * pageSize;

  try {
    const [total, users] = await prisma.$transaction([
      prisma.user.count(),
      prisma.user.findMany({
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { role: { select: { id: true, name: true } } },
      }),
    ]);

    const list = users.map((u) => ({
      id:        u.id,
      username:  u.username,
      name:      u.name,
      avatar:    u.avatar,
      status:    u.status,
      role:      u.role,
      createdAt: u.createdAt,
    }));

    res.json({ code: 200, data: { list, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/users]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/users  ────────────────────────────────────────
// 创建新用户
router.post('/', async (req: Request, res: Response) => {
  const { username, name, password, roleId } = req.body as {
    username: string;
    name:     string;
    password: string;
    roleId:   number;
  };

  if (!username?.trim() || !name?.trim() || !password || !roleId) {
    res.status(400).json({ code: 400, data: null, message: '用户名、姓名、密码和角色均为必填项' });
    return;
  }

  try {
    const exists = await prisma.user.findUnique({ where: { username: username.trim() } });
    if (exists) {
      res.status(409).json({ code: 409, data: null, message: `账号 "${username}" 已存在` });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        username: username.trim(),
        name:     name.trim(),
        passwordHash,
        roleId:   Number(roleId),
        status:   'ACTIVE',
      },
      include: { role: { select: { id: true, name: true } } },
    });

    res.json({
      code: 200,
      data: {
        id:        user.id,
        username:  user.username,
        name:      user.name,
        status:    user.status,
        role:      user.role,
        createdAt: user.createdAt,
      },
      message: '用户创建成功',
    });
  } catch (err) {
    console.error('[POST /api/users]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PATCH /api/users/:id  ───────────────────────────────────
// 更新用户信息（姓名、角色、状态；密码选填）
router.patch('/:id', async (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  if (Number.isNaN(userId)) {
    res.status(400).json({ code: 400, data: null, message: '用户 ID 无效' });
    return;
  }

  // 不允许修改自己的账号状态（防止把自己禁用）
  if (userId === req.user!.userId && req.body.status !== undefined) {
    res.status(403).json({ code: 403, data: null, message: '不能修改自己的账号状态' });
    return;
  }

  const { name, roleId, status, password } = req.body as {
    name?:     string;
    roleId?:   number;
    status?:   'ACTIVE' | 'INACTIVE';
    password?: string;
  };

  try {
    const updateData: Record<string, unknown> = {};
    if (name?.trim())  updateData.name   = name.trim();
    if (roleId)        updateData.roleId = Number(roleId);
    if (status)        updateData.status = status;
    if (password)      updateData.passwordHash = await bcrypt.hash(password, 10);

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({ code: 400, data: null, message: '没有提供任何要修改的字段' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data:  updateData,
      include: { role: { select: { id: true, name: true } } },
    });

    res.json({
      code: 200,
      data: {
        id:       user.id,
        username: user.username,
        name:     user.name,
        status:   user.status,
        role:     user.role,
      },
      message: '更新成功',
    });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      res.status(404).json({ code: 404, data: null, message: '用户不存在' });
      return;
    }
    console.error('[PATCH /api/users/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── DELETE /api/users/:id  ──────────────────────────────────
// 删除用户（不能删除自己）
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  if (Number.isNaN(userId)) {
    res.status(400).json({ code: 400, data: null, message: '用户 ID 无效' });
    return;
  }

  if (userId === req.user!.userId) {
    res.status(403).json({ code: 403, data: null, message: '不能删除当前登录账号' });
    return;
  }

  try {
    await prisma.user.delete({ where: { id: userId } });
    res.json({ code: 200, data: null, message: '用户已删除' });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      res.status(404).json({ code: 404, data: null, message: '用户不存在' });
      return;
    }
    console.error('[DELETE /api/users/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
