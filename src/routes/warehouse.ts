/**
 * 仓库管理 API
 *
 * GET    /api/warehouses        — 仓库列表（含各仓库库存汇总条数）
 * POST   /api/warehouses        — 创建仓库
 * PUT    /api/warehouses/:id    — 编辑仓库（名称/类型/备注/状态）
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { WarehouseType, WarehouseStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

// ── GET /api/warehouses ──────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      orderBy: { id: 'asc' },
      include: {
        stocks: {
          select: {
            stockQuantity: true,
            product: { select: { purchasePrice: true } },
          },
        },
      },
    });

    const list = warehouses.map((w) => {
      // 只统计有库存的明细行
      const activeStocks = w.stocks.filter((s) => s.stockQuantity > 0);

      const skuCount      = activeStocks.length;
      const totalQuantity = activeStocks.reduce((sum, s) => sum + s.stockQuantity, 0);
      const totalValue    = activeStocks.reduce((sum, s) => {
        const price = Number(s.product?.purchasePrice ?? 0);
        return sum + s.stockQuantity * price;
      }, 0);

      return {
        id:            w.id,
        name:          w.name,
        type:          w.type,
        status:        w.status,
        remark:        w.remark,
        skuCount,
        totalQuantity: Number(totalQuantity.toFixed(2)),
        totalValue:    Number(totalValue.toFixed(2)),
        createdAt:     w.createdAt,
        updatedAt:     w.updatedAt,
      };
    });

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/warehouses]', err);
    res.status(500).json({ code: 500, data: null, message: '获取仓库列表失败' });
  }
});

// ── 工具：将任意输入标准化为大写字符串，空值返回 undefined ──────────
function normalizeEnum(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  const s = String(val).trim().toUpperCase();
  return s === '' ? undefined : s;
}

// ── POST /api/warehouses ─────────────────────────────────────────────
router.post('/', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const name   = typeof body.name === 'string' ? body.name.trim() : '';
  const remark = body.remark != null ? String(body.remark) : null;

  // name 必填
  if (!name) {
    res.status(400).json({ code: 400, data: null, message: '仓库名称不能为空' });
    return;
  }

  const validTypes: string[]    = ['LOCAL', 'THIRD_PARTY'];
  const validStatuses: string[] = ['ACTIVE', 'DISABLED'];

  // 标准化：空字符串 / 小写 / undefined 全部安全处理
  const rawType   = normalizeEnum(body.type);
  const rawStatus = normalizeEnum(body.status);

  // 传了值但不合法 → 明确报错，指出收到的是什么
  if (rawType !== undefined && !validTypes.includes(rawType)) {
    res.status(400).json({
      code: 400, data: null,
      message: `type 字段值「${rawType}」无效，可选值：LOCAL / THIRD_PARTY`,
    });
    return;
  }
  if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
    res.status(400).json({
      code: 400, data: null,
      message: `status 字段值「${rawStatus}」无效，可选值：ACTIVE / DISABLED`,
    });
    return;
  }

  // 未传或空字符串时使用合理默认值
  const finalType   = (rawType   ?? 'LOCAL')  as WarehouseType;
  const finalStatus = (rawStatus ?? 'ACTIVE') as WarehouseStatus;

  try {
    const warehouse = await prisma.warehouse.create({
      data: { name, type: finalType, status: finalStatus, remark },
    });

    res.status(201).json({ code: 200, data: warehouse, message: '仓库创建成功' });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ code: 409, data: null, message: `仓库名称「${name}」已存在` });
      return;
    }
    console.error('[POST /api/warehouses]', err);
    res.status(500).json({ code: 500, data: null, message: '创建仓库失败' });
  }
});

// ── PUT /api/warehouses/:id ──────────────────────────────────────────
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ code: 400, data: null, message: '仓库 ID 无效' });
    return;
  }

  const body = req.body ?? {};
  const validTypes: string[]    = ['LOCAL', 'THIRD_PARTY'];
  const validStatuses: string[] = ['ACTIVE', 'DISABLED'];

  // 仅在字段存在于请求体时才校验（允许选传）
  const rawType   = 'type'   in body ? normalizeEnum(body.type)   : undefined;
  const rawStatus = 'status' in body ? normalizeEnum(body.status) : undefined;

  if (rawType !== undefined && !validTypes.includes(rawType)) {
    res.status(400).json({
      code: 400, data: null,
      message: `type 字段值「${rawType}」无效，可选值：LOCAL / THIRD_PARTY`,
    });
    return;
  }
  if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
    res.status(400).json({
      code: 400, data: null,
      message: `status 字段值「${rawStatus}」无效，可选值：ACTIVE / DISABLED`,
    });
    return;
  }

  try {
    const existing = await prisma.warehouse.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ code: 404, data: null, message: '仓库不存在' });
      return;
    }

    const updateData: {
      name?: string;
      type?: WarehouseType;
      status?: WarehouseStatus;
      remark?: string | null;
    } = {};

    if (body.name !== undefined) {
      const trimmed = String(body.name).trim();
      if (trimmed) updateData.name = trimmed;
    }
    if (rawType   !== undefined) updateData.type   = rawType   as WarehouseType;
    if (rawStatus !== undefined) updateData.status = rawStatus as WarehouseStatus;
    if (body.remark !== undefined) updateData.remark = body.remark != null ? String(body.remark) : null;

    const updated = await prisma.warehouse.update({
      where: { id },
      data:  updateData,
    });

    res.json({ code: 200, data: updated, message: '仓库信息已更新' });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ code: 409, data: null, message: `仓库名称「${String(body.name ?? '').trim()}」已被其他仓库占用` });
      return;
    }
    console.error('[PUT /api/warehouses/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '更新仓库失败' });
  }
});

export default router;
