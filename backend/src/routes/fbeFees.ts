import { Router, Request, Response } from 'express';
import { authenticate, requireStrictPermission } from '../middleware/auth';
import { STORE_PRODUCT_PRICE_PERMISSIONS } from './storeProducts';
import {
  executeFbeFeeBatch,
  getFbeFeeSummary,
  listFbeFeeRecords,
  previewFbeFeeBatch,
  type FbeFeeBatchInputRow,
  type FbeFeeRecordStatus,
} from '../services/fbeFeeManagement';

const router = Router();
router.use(authenticate);

router.get(
  '/summary',
  requireStrictPermission(STORE_PRODUCT_PRICE_PERMISSIONS.LOG_VIEW, '无权限查看 FBE 费用概览'),
  async (_req: Request, res: Response) => {
    try {
      const data = await getFbeFeeSummary();
      res.json({ code: 200, data, message: 'success' });
    } catch (err) {
      res.status(500).json({ code: 500, data: null, message: err instanceof Error ? err.message : '获取 FBE 概览失败' });
    }
  },
);

router.get(
  '/records',
  requireStrictPermission(STORE_PRODUCT_PRICE_PERMISSIONS.LOG_VIEW, '无权限查看 FBE 费用列表'),
  async (req: Request, res: Response) => {
    try {
      const page = req.query.page != null ? Number(req.query.page) : undefined;
      const pageSize = req.query.pageSize != null ? Number(req.query.pageSize) : undefined;
      const shopId = req.query.shopId != null ? Number(req.query.shopId) : undefined;
      const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
      const statusRaw = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
      const allowedStatuses = new Set(['ALL', 'ACTUAL', 'ESTIMATED', 'MISSING_MAPPING']);
      const status = (allowedStatuses.has(statusRaw) ? statusRaw : 'ALL') as FbeFeeRecordStatus;

      const data = await listFbeFeeRecords({ page, pageSize, shopId, keyword, status });
      res.json({ code: 200, data, message: 'success' });
    } catch (err) {
      res.status(500).json({ code: 500, data: null, message: err instanceof Error ? err.message : '获取 FBE 列表失败' });
    }
  },
);

router.post(
  '/batch/preview',
  requireStrictPermission(STORE_PRODUCT_PRICE_PERMISSIONS.PRICE_CHANGE, '无权限预览 FBE 费用批量更新'),
  async (req: Request, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows as FbeFeeBatchInputRow[] : [];
      const data = await previewFbeFeeBatch(rows);
      res.json({ code: 200, data, message: 'success' });
    } catch (err) {
      res.status(400).json({ code: 400, data: null, message: err instanceof Error ? err.message : 'FBE 批量预览失败' });
    }
  },
);

router.post(
  '/batch/execute',
  requireStrictPermission(STORE_PRODUCT_PRICE_PERMISSIONS.PRICE_CHANGE, '无权限执行 FBE 费用批量更新'),
  async (req: Request, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows as FbeFeeBatchInputRow[] : [];
      const data = await executeFbeFeeBatch(rows, req.user?.userId ?? null);
      res.json({ code: 200, data, message: 'success' });
    } catch (err) {
      res.status(400).json({ code: 400, data: null, message: err instanceof Error ? err.message : 'FBE 批量执行失败' });
    }
  },
);

export default router;
