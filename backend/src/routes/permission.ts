import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

// ── 权限节点原始类型（Prisma 查询返回）────────────────────────────
type RawPermission = {
  id:        number;
  code:      string;
  name:      string;
  type:      string;
  sortOrder: number;
  parentId:  number | null;
};

// ── 权限树节点类型（含 children）────────────────────────────────
type PermissionTreeNode = RawPermission & {
  children: PermissionTreeNode[];
};

/**
 * 将平铺的权限列表转换为树状结构
 * parentId === null 的节点为根节点
 */
function buildTree(flat: RawPermission[]): PermissionTreeNode[] {
  const nodeMap = new Map<number, PermissionTreeNode>();

  // 初始化所有节点（带空 children）
  for (const item of flat) {
    nodeMap.set(item.id, { ...item, children: [] });
  }

  const roots: PermissionTreeNode[] = [];

  for (const node of nodeMap.values()) {
    if (node.parentId === null) {
      roots.push(node);
    } else {
      const parent = nodeMap.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  // 按 sortOrder 排序（递归）
  const sortNodes = (nodes: PermissionTreeNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children);
    }
  };
  sortNodes(roots);

  return roots;
}

// ── GET /api/permissions/tree ─────────────────────────────────────
// 返回所有权限节点的树状结构，供前端角色配置打勾使用
router.get('/tree', async (_req: Request, res: Response) => {
  try {
    const permissions = await prisma.permission.findMany({
      select: {
        id:        true,
        code:      true,
        name:      true,
        type:      true,
        sortOrder: true,
        parentId:  true,
      },
      orderBy: { sortOrder: 'asc' },
    });

    const tree = buildTree(permissions);

    res.json({ code: 200, data: tree, message: 'success' });
  } catch (err) {
    console.error('[GET /api/permissions/tree]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/permissions ──────────────────────────────────────────
// 返回所有权限节点（平铺列表），供角色管理回显已选权限
router.get('/', async (_req: Request, res: Response) => {
  try {
    const permissions = await prisma.permission.findMany({
      select: {
        id:        true,
        code:      true,
        name:      true,
        type:      true,
        sortOrder: true,
        parentId:  true,
      },
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }],
    });
    res.json({ code: 200, data: permissions, message: 'success' });
  } catch (err) {
    console.error('[GET /api/permissions]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
