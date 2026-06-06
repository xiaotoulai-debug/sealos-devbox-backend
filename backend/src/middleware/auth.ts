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

export const DASHBOARD_PERMISSION = {
  MENU: 'MENU_DASHBOARD',
  DAILY: 'MENU_DASHBOARD_DAILY',
  TASK_CENTER: 'MENU_DASHBOARD_TASK_CENTER',
  COMPANY_MANAGEMENT: 'MENU_DASHBOARD_COMPANY_MANAGEMENT',
  REMINDER_TEMPLATE_MANAGE: 'ACTION_DASHBOARD_REMINDER_TEMPLATE_MANAGE',
  COMPANY_TASK_MANAGE: 'ACTION_DASHBOARD_COMPANY_TASK_MANAGE',
  COMPANY_WEEKLY_AI_GENERATE: 'ACTION_DASHBOARD_COMPANY_WEEKLY_AI_GENERATE',
} as const;

export function hasStrictPermission(user: JwtPayload | undefined, code: string): boolean {
  if (!user) return false;
  if (isStrictSuperAdmin(user)) return true;
  return (user.permissions ?? []).includes(code);
}

export function hasAnyStrictPermission(user: JwtPayload | undefined, codes: string[]): boolean {
  return codes.some((code) => hasStrictPermission(user, code));
}

export function requireStrictPermission(code: string, message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
      return;
    }
    if (!hasStrictPermission(req.user, code)) {
      res.status(403).json({ code: 403, data: null, message });
      return;
    }
    next();
  };
}

export function requireAnyStrictPermission(codes: string[], message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
      return;
    }
    if (!hasAnyStrictPermission(req.user, codes)) {
      res.status(403).json({ code: 403, data: null, message });
      return;
    }
    next();
  };
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

export function isStrictSuperAdmin(user: JwtPayload | Record<string, unknown>): boolean {
  const roleName = String(user.roleName ?? '').trim();
  const nestedRoleName = String((user as { role?: { name?: unknown } }).role?.name ?? '').trim();
  const isSuperAdminFlag = (user as { isSuperAdmin?: unknown }).isSuperAdmin === true;

  return roleName === '超级管理员' || nestedRoleName === '超级管理员' || isSuperAdminFlag;
}

export function isSuperAdmin(user: JwtPayload): boolean {
  const roleNameLower = (user.roleName ?? '').toLowerCase();
  const permissions = user.permissions ?? [];
  return (
    roleNameLower.includes('admin') ||
    roleNameLower.includes('超级管理员') ||
    permissions.includes('*') ||
    permissions.includes('ALL') ||
    permissions.includes('ADMIN_FULL')
  );
}

export function canManageEmployeeTasks(user: JwtPayload): boolean {
  if (isSuperAdmin(user)) return true;
  return (user.permissions ?? []).includes('MENU_ADMIN_EMPLOYEE_TASKS');
}

// 超管守卫：仅允许超级管理员通过
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  if (!isSuperAdmin(user)) {
    res.status(403).json({
      code: 403,
      data: null,
      message: '权限不足：该操作仅限超级管理员执行',
    });
    return;
  }
  next();
}

export function requireStrictSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  if (!isStrictSuperAdmin(user)) {
    res.status(403).json({
      code: 403,
      data: null,
      message: '无权限访问员工周报汇总，仅超级管理员可访问',
    });
    return;
  }
  next();
}

export function requireWeeklyAiGeneratePermission(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  if (
    hasStrictPermission(user, DASHBOARD_PERMISSION.COMPANY_WEEKLY_AI_GENERATE)
  ) {
    next();
    return;
  }

  res.status(403).json({
    code: 403,
    data: null,
    message: 'AI周报由管理员统一生成，员工不可自行生成',
  });
}

export function requireSuperAdminEmployeeTasks(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  if (!isStrictSuperAdmin(user)) {
    res.status(403).json({
      code: 403,
      data: null,
      message: '无权限访问管理员工任务，仅超级管理员可访问',
    });
    return;
  }
  next();
}

export function requireManageEmployeeTasks(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    res.status(401).json({ code: 401, data: null, message: '未登录，请先登录' });
    return;
  }

  if (!canManageEmployeeTasks(user)) {
    res.status(403).json({
      code: 403,
      data: null,
      message: '无权限访问管理员工任务',
    });
    return;
  }
  next();
}
