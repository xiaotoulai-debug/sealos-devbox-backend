import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

/**
 * 从数据库实时查询某角色的全部权限 code 列表
 * 不依赖 JWT 快照，保证返回的是当前最新权限
 */
async function fetchPermissionCodes(roleId: number): Promise<string[]> {
  const rolePerms = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permission: { select: { code: true } } },
  });
  return rolePerms.map((rp) => rp.permission.code).filter(Boolean);
}

/**
 * POST /api/auth/login
 * 登录接口：校验账密 -> 签发 JWT -> 返回 token + 用户基础信息
 */
router.post('/login', async (req: Request, res: Response) => {
  if (!process.env.JWT_SECRET?.trim()) {
    console.error('[POST /api/auth/login] JWT_SECRET 未配置');
    res.status(500).json({ code: 500, data: null, message: '服务器配置错误，请联系管理员' });
    return;
  }

  // 兼容 body 未解析（如 Content-Type 错误）或非对象
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { username, password } = body as {
    username?: string;
    password?: string;
  };

  if (!username?.trim() || !password) {
    res.status(400).json({ code: 400, data: null, message: '账号和密码不能为空' });
    return;
  }

  try {
    // 查询用户：只 select 登录所需字段，减少传输量
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id:           true,
        username:     true,
        name:         true,
        avatar:       true,
        status:       true,
        passwordHash: true,
        role: {
          select: { id: true, name: true },
        },
      },
    });

    // 用户不存在 / 已禁用 / 无角色 / 密码错误 — 统一提示，防止账号枚举
    if (!user || user.status === 'INACTIVE' || !user.role) {
      res.status(401).json({ code: 401, data: null, message: '账号或密码错误' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      res.status(401).json({ code: 401, data: null, message: '账号或密码错误' });
      return;
    }

    // 实时查库获取最新权限 code（不依赖 Prisma 关联快照，确保 init-permissions 后立即生效）
    const permissions = await fetchPermissionCodes(user.role.id);
    if (permissions.length === 0) {
      console.warn(`[login] 用户 ${username} 的角色「${user.role.name}」当前无任何权限，请确认 RolePermission 表已初始化`);
    }

    // 签发 JWT，载荷包含身份、角色与权限信息
    const token = jwt.sign(
      {
        userId:      user.id,
        username:    user.username,
        roleId:      user.role.id,
        roleName:    user.role.name,
        permissions,
      },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN ?? '7d') as jwt.SignOptions['expiresIn'] },
    );

    res.json({
      code: 200,
      data: {
        token,
        user: {
          id:          user.id,
          username:    user.username,
          name:        user.name,
          avatar:      user.avatar,
          role: {
            id:   user.role.id,
            name: user.role.name,
          },
          permissions,
        },
      },
      message: '登录成功',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error('[POST /api/auth/login] 500 错误:', detail);
    if (stack) console.error(stack);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误，请稍后重试' });
  }
});

/**
 * GET /api/auth/me
 * 获取当前登录用户信息（实时查库），用于前端刷新页面后恢复权限状态
 * - 权限 code 从数据库实时读取，不受 JWT 签发时快照影响
 * - token 过期/无效时返回 401
 */
router.get('/me', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id:       true,
        username: true,
        name:     true,
        avatar:   true,
        status:   true,
        role: {
          select: { id: true, name: true },
        },
      },
    });

    if (!user || user.status === 'INACTIVE' || !user.role) {
      res.status(401).json({ code: 401, data: null, message: '账号已被禁用，请联系管理员' });
      return;
    }

    // 实时查库，确保权限变更后立即生效（无需重新登录）
    const permissions = await fetchPermissionCodes(user.role.id);

    res.json({
      code: 200,
      data: {
        id:       user.id,
        username: user.username,
        name:     user.name,
        avatar:   user.avatar,
        role: {
          id:   user.role.id,
          name: user.role.name,
        },
        permissions,
      },
      message: 'success',
    });
  } catch (err) {
    console.error('[GET /api/auth/me]', err instanceof Error ? err.message : err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
