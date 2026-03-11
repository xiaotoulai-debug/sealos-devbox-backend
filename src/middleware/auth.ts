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
