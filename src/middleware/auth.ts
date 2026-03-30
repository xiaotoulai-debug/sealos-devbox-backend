import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId:      number;
  username:    string;
  roleId:      number;
  roleName:    string;
  permissions: string[];
}

// 将解析后的用户信息挂载到 req.user，供下游路由直接使用
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ code: 401, data: null, message: 'Token 已过期，请重新登录' });
  }
}

// 权限守卫：检查 req.user.permissions 是否包含指定权限码
export function requirePermission(code: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user?.permissions.includes(code)) {
      res.status(403).json({ code: 403, data: null, message: `无操作权限（需要 ${code}）` });
      return;
    }
    next();
  };
}

// 超管守卫：仅允许超级管理员通过
// 判断依据（与前端 isSuperAdmin 逻辑保持一致）：
//   roleName 含 "admin" / "超级管理员"，或 permissions 包含 "*" / "ALL" / "ADMIN_FULL"
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }
  const roleNameLower = (user.roleName ?? '').toLowerCase();
  const isSuperAdmin =
    roleNameLower.includes('admin') ||
    roleNameLower.includes('超级管理员') ||
    user.permissions.includes('*') ||
    user.permissions.includes('ALL') ||
    user.permissions.includes('ADMIN_FULL');

  if (!isSuperAdmin) {
    res.status(403).json({
      code: 403,
      data: null,
      message: '权限不足：该操作仅限超级管理员执行',
    });
    return;
  }
  next();
}
