import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const router = Router();

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
          select: {
            id:   true,
            name: true,
            permissions: {
              select: {
                permission: { select: { code: true } },
              },
            },
          },
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

    // 提取该角色下所有权限 code（兼容 permission 可能为空）
    const permissions = (user.role.permissions ?? []).map((rp) => rp.permission?.code).filter(Boolean) as string[];

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

export default router;
