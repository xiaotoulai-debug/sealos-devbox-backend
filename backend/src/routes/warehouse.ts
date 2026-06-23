/**
 * 仓库管理 API
 *
 * GET    /api/warehouses        — 仓库列表（含各仓库库存汇总条数）
 * POST   /api/warehouses        — 创建仓库
 * PUT    /api/warehouses/:id    — 编辑仓库（名称/类型/备注/状态）
 */

import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { WarehouseType, WarehouseStatus } from '@prisma/client';

const router = Router();
router.use(authenticate);

// ── GET /api/warehouses ──────────────────────────────────────────────
//
// 口径 B（全局覆盖）：以全局未删除 SKU 为基准，CROSS JOIN 每个仓库，
// LEFT JOIN warehouse_stocks 取实际库存（无记录则 COALESCE 为 0）。
//
// 优于旧版"include.stocks.filter"的原因：
//   旧版：warehouse_stocks 按需写入（稀疏表），仅有操作记录的 SKU 才有行，
//         导致 EMAG备货仓 只统计出 3 个 SKU（而非全局 648 个）。
//   新版：全局 SKU × 仓库 在 PG 层完成聚合，Node 层零内存计算。
//
// 性能：CROSS JOIN（SKU 数 × 仓库数）行在 PG hash aggregate 内完成，
//       当前 648 SKU × ~5 仓 ≈ 3240 行，<5ms。
router.get('/', async (_req: Request, res: Response) => {
  try {
    type WarehouseStatRow = {
      id:            bigint;
      name:          string;
      type:          string;
      status:        string;
      remark:        string | null;
      created_at:    Date;
      updated_at:    Date;
      sku_count:     bigint;
      total_quantity: number | string;
      total_value:    number | string;
      in_transit_total_value: number | string;
    };

    // 一次原生 SQL 完成全部仓库的汇总，无 N+1
    const rows = await prisma.$queryRaw<WarehouseStatRow[]>`
      SELECT
        w.id,
        w.name,
        w.type,
        w.status,
        w.remark,
        w.created_at,
        w.updated_at,
        COUNT(p.id)                                                              AS sku_count,
        COALESCE(SUM(COALESCE(ws.stock_quantity, 0)), 0)                        AS total_quantity,
        COALESCE(
          SUM(COALESCE(ws.stock_quantity, 0) * COALESCE(p.purchase_price::float, 0)),
          0
        )                                                                        AS total_value,
        COALESCE(
          SUM(
            COALESCE(ws.in_transit_quantity, 0)
              * COALESCE(NULLIF(ws.unit_cost, 0), p.purchase_price::float, 0)
          ),
          0
        )                                                                        AS in_transit_total_value
      FROM warehouses w
      CROSS JOIN products p
      LEFT JOIN warehouse_stocks ws
        ON  ws.product_id   = p.id
        AND ws.warehouse_id = w.id
      WHERE p.is_deleted = false
        AND p.sku IS NOT NULL          -- 口径 B 铁律：只统计私海/库存 SKU（已分配 SKU 即进入私有池）
      GROUP BY w.id, w.name, w.type, w.status, w.remark, w.created_at, w.updated_at
      ORDER BY w.id ASC
    `;

    const list = rows.map((r) => ({
      id:            Number(r.id),
      name:          r.name,
      type:          r.type,
      status:        r.status,
      remark:        r.remark ?? null,
      skuCount:      Number(r.sku_count),
      totalQuantity: Number(Number(r.total_quantity).toFixed(2)),
      totalValue:    Number(Number(r.total_value).toFixed(2)),
      inTransitTotalValue: Number(Number(r.in_transit_total_value).toFixed(2)),
      createdAt:     r.created_at,
      updatedAt:     r.updated_at,
    }));

    res.json({ code: 200, data: list, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/warehouses]', err);
    res.status(500).json({ code: 500, data: null, message: `获取仓库列表失败：${err?.message ?? '未知错误'}` });
  }
});

// ── GET /api/warehouses/:id/inventory ────────────────────────────────
//
// 仓库库存明细（口径 B：全局 SKU 为基准，无记录则返回 0）
//
// Query:
//   page        Int     default=1      页码
//   pageSize    Int     default=20     每页条数（max=200）
//   sortBy      String  default="stockQuantity"
//               可选: stockQuantity | inTransitQuantity | unitCost |
//                     totalValue | sku | sales7 | sales30 | purchasePrice
//   sortOrder   String  default="desc"  asc | desc
//   keyword     String  optional        SKU / 中文名称模糊搜索
//   onlyActive  Boolean default=false   true=只返回 stockQuantity > 0 的行
//
// 架构铁律：
//   - 排序/分页全部下推到 PostgreSQL，Node 层零内存排序
//   - 分页总数与当页数据用 Promise.all 并发执行（两条独立查询），
//     禁止 COUNT(*) OVER() 窗口函数（大表带 OFFSET 会触发全表 Sort）
//   - SORT_WHITELIST 防 SQL 注入（动态 ORDER BY 列名白名单校验）
//   - BigInt / Decimal → Number 全部在 DTO 映射层转换
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/inventory', async (req: Request, res: Response) => {
  try {
    const warehouseId = parseInt(String(req.params.id), 10);
    if (isNaN(warehouseId) || warehouseId <= 0) {
      res.status(400).json({ code: 400, data: null, message: '仓库 ID 无效' });
      return;
    }

    // ── 分页参数 ──────────────────────────────────────────────────────
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const offset   = (page - 1) * pageSize;

    // ── 排序参数（白名单校验，防 SQL 注入）────────────────────────────
    //   Key  = 前端传入的字段名
    //   Value = SQL 中对应的列别名（必须与 SELECT 的 AS 对齐）
    const SORT_WHITELIST: Record<string, string> = {
      stockQuantity:      'stock_quantity',
      inTransitQuantity:  'in_transit_quantity',
      lockedQuantity:     'locked_quantity',
      unitCost:           'unit_cost',
      totalValue:         'total_value',
      inTransitTotalValue:'in_transit_total_value',
      sku:                'sku',
      sales7:             'sales_7',
      sales30:            'sales_30',
      purchasePrice:      'purchase_price_num',
    };
    const rawSortBy    = String(req.query.sortBy    ?? 'stockQuantity');
    const rawSortOrder = String(req.query.sortOrder ?? 'desc').toLowerCase();
    const orderByCol   = SORT_WHITELIST[rawSortBy] ?? 'stock_quantity';  // 未知字段降级为库存量
    const orderByDir   = rawSortOrder === 'asc' ? 'ASC' : 'DESC';

    // ── 过滤参数 ──────────────────────────────────────────────────────
    const keyword    = String(req.query.keyword    ?? '').trim();
    const onlyActive = req.query.onlyActive === 'true';

    // ── 仓库存在性校验 ────────────────────────────────────────────────
    const warehouse = await prisma.warehouse.findUnique({
      where:  { id: warehouseId },
      select: { id: true, name: true, status: true },
    });
    if (!warehouse) {
      res.status(404).json({ code: 404, data: null, message: '仓库不存在' });
      return;
    }

    // ── 构建可复用的 WHERE 条件片段 ───────────────────────────────────
    //   Prisma.sql 可安全组合，参数化绑定防注入
    const keywordCond = keyword
      ? Prisma.sql`AND (p.sku ILIKE ${`%${keyword}%`} OR p.chinese_name ILIKE ${`%${keyword}%`})`
      : Prisma.sql``;
    const activeCond = onlyActive
      ? Prisma.sql`AND (
          COALESCE(ws.stock_quantity,      0) > 0
          OR COALESCE(ws.in_transit_quantity, 0) > 0
          OR COALESCE(ws.locked_quantity,     0) > 0
          OR COALESCE(ws.stock_quantity, 0) * COALESCE(ws.unit_cost, 0) > 0
        )`
      : Prisma.sql``;

    // ── Promise.all：总数查询 + 当页数据查询 并发执行 ─────────────────
    //   count 查询：无 ORDER BY / LIMIT，走 hash aggregate，最快路径
    //   data  查询：有 ORDER BY + LIMIT，索引扫描后截断，不做全表排序
    type CountRow = { total: bigint };
    type StockRow = {
      product_id:          bigint;
      sku:                 string | null;
      chinese_name:        string | null;
      image_url:           string | null;
      purchase_price_num:  number | string | null;
      stock_quantity:      number | string;
      in_transit_quantity: number | string;
      locked_quantity:     number | string;
      physical_quantity:   number | string;
      unit_cost:           number | string;
      total_value:         number | string;
      in_transit_total_value: number | string;
      sales_7:             bigint | number;
      sales_30:            bigint | number;
      has_record:          boolean;
    };

    const [countRows, dataRows] = await Promise.all([
      // ── 总数查询（仅 COUNT，无排序，无分页）────────────────────────
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(p.id) AS total
        FROM   products p
        LEFT JOIN warehouse_stocks ws
          ON  ws.product_id   = p.id
          AND ws.warehouse_id = ${warehouseId}
        WHERE  p.is_deleted = false
          AND  p.sku IS NOT NULL
        ${keywordCond}
        ${activeCond}
      `,

      // ── 当页数据查询（排序 + 分页，全部在 PG 执行）─────────────────
      //   ORDER BY 列名来自 SORT_WHITELIST，已完成白名单过滤，Prisma.raw 安全
      prisma.$queryRaw<StockRow[]>`
        SELECT
          p.id                                                       AS product_id,
          p.sku,
          p.chinese_name,
          p.image_url,
          p.purchase_price::float                                    AS purchase_price_num,
          COALESCE(ws.stock_quantity,      0)                        AS stock_quantity,
          COALESCE(ws.in_transit_quantity, 0)                        AS in_transit_quantity,
          COALESCE(ws.locked_quantity,     0)                        AS locked_quantity,
          COALESCE(ws.stock_quantity, 0) + COALESCE(ws.locked_quantity, 0) AS physical_quantity,
          COALESCE(NULLIF(ws.unit_cost, 0), p.purchase_price::float, 0) AS unit_cost,
          (COALESCE(ws.stock_quantity, 0) + COALESCE(ws.locked_quantity, 0))
            * COALESCE(NULLIF(ws.unit_cost, 0), p.purchase_price::float, 0) AS total_value,
          COALESCE(ws.in_transit_quantity, 0)
            * COALESCE(NULLIF(ws.unit_cost, 0), p.purchase_price::float, 0) AS in_transit_total_value,
          COALESCE(ws.sales_7,             0)                        AS sales_7,
          COALESCE(ws.sales_30,            0)                        AS sales_30,
          (ws.id IS NOT NULL)                                        AS has_record
        FROM   products p
        LEFT JOIN warehouse_stocks ws
          ON  ws.product_id   = p.id
          AND ws.warehouse_id = ${warehouseId}
        WHERE  p.is_deleted = false
          AND  p.sku IS NOT NULL
        ${keywordCond}
        ${activeCond}
        ORDER BY ${Prisma.raw(orderByCol + ' ' + orderByDir + ' NULLS LAST')}, p.id ASC
        LIMIT  ${pageSize}
        OFFSET ${offset}
      `,
    ]);

    const total = Number(countRows[0]?.total ?? 0);

    // ── DTO 映射：BigInt / Decimal → Number，统一数值类型 ────────────
    const list = dataRows.map((r) => ({
      productId:          Number(r.product_id),
      sku:                r.sku                ?? null,
      chineseName:        r.chinese_name       ?? null,
      imageUrl:           r.image_url          ?? null,
      purchasePrice:      r.purchase_price_num != null ? Number(r.purchase_price_num) : null,
      stockQuantity:      Number(r.stock_quantity),
      inTransitQuantity:  Number(r.in_transit_quantity),
      lockedQuantity:     Number(r.locked_quantity),
      physicalQuantity:   Number(r.physical_quantity),
      unitCost:           Number(r.unit_cost),
      totalValue:         Number(Number(r.total_value).toFixed(2)),
      inTransitTotalValue: Number(Number(r.in_transit_total_value).toFixed(2)),
      sales7:             Number(r.sales_7),
      sales30:            Number(r.sales_30),
      hasRecord:          Boolean(r.has_record),
    }));

    console.log(
      `[GET /api/warehouses/${warehouseId}/inventory] ` +
      `page=${page} pageSize=${pageSize} sortBy=${orderByCol} ${orderByDir} ` +
      `keyword="${keyword}" onlyActive=${onlyActive} → total=${total}`,
    );

    res.json({
      code: 200,
      data: {
        warehouseId:   warehouse.id,
        warehouseName: warehouse.name,
        total,
        page,
        pageSize,
        list,
      },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/warehouses/:id/inventory]', err?.message ?? err);
    res.status(500).json({
      code: 500, data: null,
      message: `获取仓库库存明细失败：${err?.message ?? '未知错误'}`,
    });
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
