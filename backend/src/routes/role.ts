import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

router.use(authenticate);

// GET /api/roles — 获取所有角色（用于用户管理的角色下拉选择）
router.get('/', async (_req: Request, res: Response) => {
  try {
    const roles = await prisma.role.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, description: true },
    });
    res.json({ code: 200, data: roles, message: 'success' });
  } catch (err) {
    console.error('[GET /api/roles]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
