/**
 * 采购管理 API（重构版 —— 建单与 1688 下单彻底解耦）
 *
 * POST /api/purchases/create-local       采购计划 → 内部建单（一品一单，纯本地）
 * GET  /api/purchases                    采购单列表（分页，含子单 + 产品 + 仓库）
 * GET  /api/purchases/:id                采购单详情
 * POST /api/purchases/:id/place-1688-order  采购管理 → 真实调 1688 下单
 */

import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { createAlibabaOrder, isAlibabaSpecInvalidError } from '../services/alibabaOrder';
import { applyStockChange } from './inventory';
import {
  syncOrderDetail,
  syncLogisticsInfos,
  getLogisticsTrace,
  getLogisticsTraceByOrder,
  isAliServiceError,
} from '../services/alibabaService';

const router = Router();
router.use(authenticate);

/**
 * 从「采购计划 → 建单」请求体行解析 Product 主键。
 * 兼容 productId / product_id / product.id；绝不把行项目自己的 id 当作产品 id。
 */
function resolveCreateLocalLineProductId(line: any): number | null {
  const candidates = [line?.productId, line?.product_id, line?.product?.id];
  for (const c of candidates) {
    const n = parseInt(String(c), 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return null;
}

/**
 * 为 PurchaseOrderItem 生成应持久化的 productIds JSON。
 * 优先保留已有合法 JSON；否则按子单 offerId 匹配 Product.externalProductId；一品一单则兜底唯一关联产品。
 */
function buildProductIdsJsonForItem(
  item: { offerId?: string | null; productIds?: string | null },
  products: Array<{ id: number; externalProductId?: string | null }>,
): string {
  try {
    const parsed: unknown = JSON.parse(item.productIds ?? '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      const nums = parsed.map((x) => parseInt(String(x), 10)).filter((n) => !Number.isNaN(n) && n > 0);
      if (nums.length > 0) return JSON.stringify(nums);
    }
  } catch { /* ignore */ }
  const offer = String(item.offerId ?? '').trim();
  if (offer) {
    const matched = products.filter((p) => String(p.externalProductId ?? '').trim() === offer);
    if (matched.length > 0) return JSON.stringify(matched.map((m) => m.id));
  }
  if (products.length === 1) return JSON.stringify([products[0].id]);
  return JSON.stringify(products.map((p) => p.id));
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/create-local
//
// 采购计划确认建单（纯本地 DB，绝不调 1688）
// ★ 一品一单：每个产品独立生成一条 PurchaseOrder + PurchaseOrderItem
//
// Body: {
//   items: [{ productId: number, quantity: number }],
//   warehouseId?: number,   // 目标入库仓（可选）
//   remark?: string
// }
// ─────────────────────────────────────────────────────────────────────
router.post('/create-local', async (req: Request, res: Response) => {
  try {
    const userId   = req.user!.userId;
    const username = req.user!.username ?? 'unknown';
    const { items, warehouseId, remark } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供至少一个产品' });
      return;
    }

    // 校验 warehouseId（必传）
    if (warehouseId === undefined || warehouseId === null) {
      res.status(400).json({ code: 400, data: null, message: '请选择目标入库仓库（warehouseId 必填）' });
      return;
    }
    const wid = parseInt(String(warehouseId), 10);
    if (isNaN(wid) || wid <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId 无效' });
      return;
    }
    const wh = await prisma.warehouse.findUnique({ where: { id: wid }, select: { id: true, name: true, status: true } });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用' });
      return;
    }
    const validWarehouseId = wid;

    // 校验产品存在（多字段解析 productId，避免前端只传 product.id 等变体导致整单跳过写入）
    const productIds = items
      .map((i: any) => resolveCreateLocalLineProductId(i))
      .filter((id: number | null): id is number => id != null);
    if (productIds.length === 0) {
      res.status(400).json({
        code: 400, data: null,
        message: 'productId 无效：请为每项传入 productId（或 product_id / product.id）',
      });
      return;
    }

    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isDeleted: false },
      select: {
        id: true, sku: true, chineseName: true, title: true,
        purchasePrice: true, externalProductId: true, externalSkuId: true,
      },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // 生成单号前缀
    const now     = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const prefix  = `PO-${dateStr}-`;

    // ★ 单号起始序号：查询当天最大 orderNo 的后缀 +1（取代 count() 防 P2002 撞号）
    //
    //   原逻辑 count() 在历史单被删除（rollback / DELETE）后会得到偏小的值，
    //   导致新生成的序号与仍然存在的单号冲突，触发 Prisma P2002 Unique constraint failed。
    //
    //   改用 findFirst + orderBy: 'desc' 精准获取当前最大序号，天然绕开删除留下的序号空洞。
    //   兜底：orderNo 后缀解析失败时退回 0，保证流程不断。
    const lastOrderToday = await prisma.purchaseOrder.findFirst({
      where:   { orderNo: { startsWith: prefix } },
      orderBy: { orderNo: 'desc' },
      select:  { orderNo: true },
    });
    const lastSeq = lastOrderToday
      ? parseInt(lastOrderToday.orderNo.slice(prefix.length), 10) || 0
      : 0;

    // ── 一品一单：为每个产品生成独立的采购单 ──────────────────────
    const createdOrders: any[] = [];
    let seq = lastSeq;

    for (const item of items) {
      const pid = resolveCreateLocalLineProductId(item);
      if (pid == null) continue;
      const qty = Math.max(1, parseInt(String(item.quantity), 10) || 1);
      const prod = productMap.get(pid);
      if (!prod) continue;

      seq++;
      const orderNo     = `${prefix}${String(seq).padStart(3, '0')}`;
      const unitPrice   = Number(prod.purchasePrice ?? 0);
      const totalAmount = parseFloat((qty * unitPrice).toFixed(2));

      const order = await prisma.$transaction(async (tx) => {
        const po = await tx.purchaseOrder.create({
          data: {
            orderNo,
            operator:    username,
            totalAmount,
            itemCount:   1,
            status:      'PENDING',
            warehouseId: validWarehouseId,
            remark:      remark ?? null,
            items: {
              create: {
                offerId:    prod.externalProductId ?? null,
                productIds: JSON.stringify([pid]),
                quantity:   qty,
              },
            },
          },
          include: {
            items: true,
            warehouse: { select: { id: true, name: true } },
          },
        });

        // 将产品关联到采购单，状态从 PURCHASING → ORDERED（进入采购管理，脱离采购计划列表）
        await tx.product.update({
          where: { id: pid },
          data:  { purchaseOrderId: po.id, status: 'ORDERED', purchaseQuantity: qty },
        });

        // ★ 增加在途库存：产品已进入正式采购流程，货物尚未到仓
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: pid, warehouseId: validWarehouseId } },
          create: { productId: pid, warehouseId: validWarehouseId, inTransitQuantity: qty },
          update: { inTransitQuantity: { increment: qty } },
        });

        return po;
      });

      createdOrders.push({
        id:          order.id,
        orderNo:     order.orderNo,
        totalAmount: Number(order.totalAmount),
        quantity:    qty,
        sku:         prod.sku,
        chineseName: prod.chineseName,
        warehouse:   order.warehouse,
        has1688:     !!(prod.externalProductId && prod.externalSkuId),
      });
    }

    if (createdOrders.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '所有产品均无效，未创建采购单' });
      return;
    }

    console.log(
      `[Purchase] ${username} 创建 ${createdOrders.length} 张采购单（一品一单），` +
      `单号: ${createdOrders.map((o) => o.orderNo).join(', ')}`,
    );

    res.json({
      code: 200,
      data: { orders: createdOrders, count: createdOrders.length },
      message: `成功创建 ${createdOrders.length} 张采购单`,
    });
  } catch (err: any) {
    // ★ 结构化日志：完整记录错误码、目标字段、meta、堆栈，便于链路排查
    console.error('[POST /api/purchases/create-local]', {
      code:    err?.code,
      message: err?.message,
      meta:    err?.meta,
      stack:   err?.stack,
    });

    // ── Prisma 已知错误：提取真实原因透传前端（遵守 .cursorrules 第 4 条）─
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        const target = Array.isArray(err.meta?.target)
          ? (err.meta!.target as string[]).join(',')
          : String(err.meta?.target ?? 'unknown');
        res.status(409).json({
          code: 409, data: null,
          message: `唯一键冲突（${target}），请稍后重试；若反复出现请联系管理员`,
        });
        return;
      }
      if (err.code === 'P2003') {
        res.status(400).json({
          code: 400, data: null,
          message: `外键约束冲突：${err.meta?.field_name ?? '未知字段'}（关联数据可能已被删除）`,
        });
        return;
      }
      if (err.code === 'P2025') {
        res.status(404).json({
          code: 404, data: null,
          message: '关联记录不存在，可能产品/仓库已被删除，请刷新页面',
        });
        return;
      }
    }

    // 兜底：透出真实 message（而非写死的"创建采购单失败"）
    res.status(500).json({
      code: 500, data: null,
      message: `创建采购单失败：${err?.message ?? '未知错误'}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/fix-in-transit
//
// 【对账式历史修复 + 幂等巡检】精准重算所有活跃采购单的在途库存，
// 并在单个事务内覆写 WarehouseStock.inTransitQuantity，消灭孤儿脏行。
//
// 核心算法（"重算即正确值，单次提交无窗口"）：
//   Phase A（事务外，只读）：
//     1. 拉取所有活跃采购单（PENDING/PLACED/IN_TRANSIT/PARTIAL），
//        以 PurchaseOrderItem.quantity（子单实际下单量）为权威 qty 来源，
//        按 (productId × warehouseId) 分组求和 → correctMap（期望状态）
//     2. 拉取当前 DB 中所有 in_transit_quantity > 0 的行 → orphanRows
//        凡不在 correctMap 中的即为孤儿脏行，需归零
//   Phase B（单 $transaction 内，写）：
//     1. 将 correctMap 内每条 (pid, wid) 直接 upsert 为正确值（无中间清零步骤）
//     2. 将孤儿脏行 in_transit_quantity 归零
//     所有写操作在同一事务提交，利用 PostgreSQL MVCC：并发读始终见旧快照，
//     提交瞬间原子切换为新数据，绝无脏读窗口。
//
// 幂等性：可重复调用，结果收敛，不会叠加。
// ─────────────────────────────────────────────────────────────────────
router.post('/fix-in-transit', async (req: Request, res: Response) => {
  try {
    // ── Phase A-1：读活跃采购单（以 items.quantity 为权威 qty 来源）────────
    const activeOrders = await prisma.purchaseOrder.findMany({
      where: {
        status:      { in: ['PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL'] },
        warehouseId: { not: null },
      },
      select: {
        id:          true,
        orderNo:     true,
        warehouseId: true,
        // ★ 关键变更：qty 来源改为子单实际下单量，而非 Product.purchaseQuantity
        items: {
          select: { quantity: true, productIds: true },
        },
        // 保留 products 仅用于 FK 正常路径兜底（productIds 为空时降级使用）
        products: {
          select: { id: true, purchaseQuantity: true },
        },
      },
    });

    // 按 (productId × warehouseId) 分组累加，构建期望状态 correctMap
    type TransitEntry = { productId: number; warehouseId: number; qty: number };
    const correctMap = new Map<string, TransitEntry>();

    for (const order of activeOrders) {
      const wid = order.warehouseId!;

      // ★ 主路径：从 PurchaseOrderItem.productIds JSON + quantity 计算（精确）
      let coveredByItems = false;
      for (const item of order.items) {
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          if (pids.length === 0) continue;
          for (const pid of pids) {
            const key = `${pid}_${wid}`;
            const existing = correctMap.get(key);
            if (existing) {
              existing.qty += item.quantity;
            } else {
              correctMap.set(key, { productId: pid, warehouseId: wid, qty: item.quantity });
            }
          }
          coveredByItems = true;
        } catch { /* 跳过格式损坏的 productIds */ }
      }

      // ★ 降级路径：items.productIds 完全为空时，回退到 Product.purchaseQuantity（FK 正常路径）
      if (!coveredByItems) {
        for (const prod of order.products) {
          const qty = Math.max(1, prod.purchaseQuantity ?? 1);
          const key = `${prod.id}_${wid}`;
          const existing = correctMap.get(key);
          if (existing) {
            existing.qty += qty;
          } else {
            correctMap.set(key, { productId: prod.id, warehouseId: wid, qty });
          }
        }
      }
    }

    // ── Phase A-2：拉取孤儿脏行（有在途但不在任何活跃采购单中的行）─────────
    const orphanRows = await prisma.warehouseStock.findMany({
      where: { inTransitQuantity: { gt: 0 } },
      select: { id: true, productId: true, warehouseId: true, inTransitQuantity: true },
    });
    const orphans = orphanRows.filter(
      (r) => !correctMap.has(`${r.productId}_${r.warehouseId}`),
    );

    // ── Phase B：单事务内精准覆写（无清零-写入两步，MVCC 保证无脏读窗口）────
    const entries = Array.from(correctMap.values());
    let upsertCount  = 0;
    let orphanZeroed = 0;

    await prisma.$transaction(
      async (tx) => {
        // B-1：将每个活跃 (pid × wid) 直接 upsert 为正确值（单步到位）
        for (const e of entries) {
          await tx.warehouseStock.upsert({
            where:  { productId_warehouseId: { productId: e.productId, warehouseId: e.warehouseId } },
            create: { productId: e.productId, warehouseId: e.warehouseId, inTransitQuantity: e.qty },
            update: { inTransitQuantity: e.qty },  // 精确覆盖，非增量，幂等
          });
          upsertCount++;
        }

        // B-2：孤儿脏行归零（有在途但已无对应活跃采购单的 SKU）
        for (const orphan of orphans) {
          await tx.warehouseStock.update({
            where: { id: orphan.id },
            data:  { inTransitQuantity: 0 },
          });
          orphanZeroed++;
        }
      },
      {
        // 超时保护：条数庞大时给足余量（默认 5s 太短）
        timeout: 30_000,
      },
    );

    const diffLines = orphans.map((o) => ({
      productId:    o.productId,
      warehouseId:  o.warehouseId,
      before:       Number(o.inTransitQuantity),
      after:        0,
      reason:       '无活跃采购单，孤儿脏行归零',
    }));

    console.log(
      `[fix-in-transit] 修复完成：扫描 ${activeOrders.length} 张活跃采购单，` +
      `upsert ${upsertCount} 条正确值，归零孤儿 ${orphanZeroed} 条`,
    );

    res.json({
      code: 200,
      data: {
        scannedOrders:  activeOrders.length,
        upsertedRecords: upsertCount,
        orphanZeroed,
        correctDetail:  entries.map((e) => ({
          productId:    e.productId,
          warehouseId:  e.warehouseId,
          inTransitQty: e.qty,
        })),
        orphanDetail: diffLines,
      },
      message:
        `在途库存修复完成：${activeOrders.length} 张活跃采购单，` +
        `${upsertCount} 条已精准覆写，${orphanZeroed} 条孤儿脏行已归零`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/fix-in-transit]', err?.message ?? err);
    res.status(500).json({
      code: 500, data: null,
      message: `在途库存修复失败：${err?.message ?? '未知错误'}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases
// 采购单列表（分页，含子单 + 关联产品 + 仓库）
//
// Query:
//   page, pageSize  分页
//   tabStatus       看板状态栏（优先）：ALL | PENDING | PURCHASING | COMPLETED
//   status          精确状态（tabStatus 未传时兜底）：PENDING/PLACED/IN_TRANSIT/RECEIVED
//   keyword         深度穿透搜索：匹配主单号 OR 1688 订单号 OR 关联产品 SKU
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? '20'), 10)));
    const skip     = (page - 1) * pageSize;

    // ── ① 状态过滤 ────────────────────────────────────────────────
    // 同时兼容 query 和 body（防止前端通过 POST body 传参）
    // 兼容多种命名：tabStatus / tab_status / tab / status
    const rawTab = (
      req.query.tabStatus  ?? req.body?.tabStatus  ??
      req.query.tab_status ?? req.body?.tab_status ??
      req.query.tab        ?? req.body?.tab        ??
      req.query.status     ?? req.body?.status     ?? ''
    );
    const tabRaw = String(rawTab).toUpperCase().trim();

    // ── 状态映射：PURCHASING 绝不包含 PENDING/RECEIVED ──────────────
    // PENDING    → 未下单（本地建单，尚未提交 1688）
    // PURCHASING → 采购中（PLACED=已下单 / IN_TRANSIT=运输中 / PARTIAL=部分入库待补）
    // COMPLETED  → 已完成（RECEIVED=已全部入库）
    let statusFilter: string | { in: string[] } | undefined;
    switch (tabRaw) {
      case 'PENDING':
        statusFilter = 'PENDING';
        break;
      case 'PURCHASING':
        statusFilter = { in: ['PLACED', 'IN_TRANSIT', 'PARTIAL'] };
        break;
      case 'COMPLETED':
        statusFilter = { in: ['RECEIVED'] };
        break;
      case 'PLACED':      statusFilter = 'PLACED';      break;
      case 'IN_TRANSIT':  statusFilter = 'IN_TRANSIT';  break;
      case 'PARTIAL':     statusFilter = 'PARTIAL';     break;
      case 'RECEIVED':    statusFilter = 'RECEIVED';    break;
      case 'CANCELLED':   statusFilter = 'CANCELLED';   break;
      // ALL / 空值 / 未知值 → statusFilter = undefined（返回全部）
    }

    console.log(
      `[GET /api/purchases] tabRaw="${tabRaw}" → statusFilter=${JSON.stringify(statusFilter)}`,
      '| query:', JSON.stringify(req.query),
    );

    // ── ② 深度穿透搜索 ────────────────────────────────────────────
    const kw = String(
      req.query.keyword ?? req.body?.keyword ??
      req.query.search  ?? req.body?.search  ?? '',
    ).trim();

    // ── ② 预查：关键词可能是 SKU，先找到所有匹配的产品 ID ──────────
    //
    // ★ 背景：Product.purchaseOrderId 是单 FK，若同一产品被多次建单，
    //   后建的订单会覆盖 FK，导致先建订单的 products 关联断裂。
    //   直接用 { products: { some: { sku: ... } } } 会漏掉 FK 断裂的订单。
    //
    // ★ 修复策略：先查出 SKU 匹配的产品 ID 列表，再通过
    //   PurchaseOrderItem.productIds JSON 字段进行二次匹配，彻底绕过 FK 断裂问题。
    let skuMatchProductIds: string[] = [];
    if (kw) {
      const skuMatches = await prisma.product.findMany({
        where: { sku: { contains: kw, mode: 'insensitive' } },
        select: { id: true },
      });
      skuMatchProductIds = skuMatches.map((p) => String(p.id));
    }

    // ── ③ 用显式 AND 构建 where，彻底隔离状态过滤与关键词 OR 条件 ──
    //
    // 产生结构：{ AND: [{ status: X }, { OR: [cond1, cond2, ...] }] }
    // 等价 SQL：WHERE status=X AND (cond1 OR cond2 OR ...)
    const andClauses: any[] = [];

    if (statusFilter !== undefined) {
      andClauses.push({ status: statusFilter });
    }

    if (kw) {
      const kwOrClauses: any[] = [
        // 主单号
        { orderNo:        { contains: kw, mode: 'insensitive' as const } },
        // 主单 1688 订单号
        { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } },
        // ★ 主单物流运单号（仓库人员扫码反查采购单的核心入口）
        { trackingNumber: { contains: kw, mode: 'insensitive' as const } },
        // 子单 1688 订单号
        { items: { some: { alibabaOrderId: { contains: kw, mode: 'insensitive' as const } } } },
        // ★ 子单物流单号（PurchaseOrderItem.logisticsNo）
        { items: { some: { logisticsNo:    { contains: kw, mode: 'insensitive' as const } } } },
        // SKU 路径①：Product.purchaseOrderId FK 正常时，通过 products 关联搜索
        { products: { some: { sku: { contains: kw, mode: 'insensitive' as const } } } },
      ];

      // SKU 路径②（兜底）：FK 断裂时，通过 PurchaseOrderItem.productIds JSON 字段搜索
      // productIds 存储格式为 "[93678]"，contains 子字符串匹配精确 ID 数字
      for (const pid of skuMatchProductIds) {
        kwOrClauses.push({
          items: { some: { productIds: { contains: pid } } },
        });
      }

      andClauses.push({ OR: kwOrClauses });
    }

    // 无条件时 where = {} → 返回全部（ALL Tab 行为）
    const where: any = andClauses.length > 0 ? { AND: andClauses } : {};

    const [total, rawList] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            select: {
              id: true, offerId: true, quantity: true,
              receivedQuantity: true,                    // ← 已入库累计量（前端"已入库量"显示的来源）
              productIds: true,                          // ← 用于精准关联 product
              alibabaOrderId: true, alibabaOrderStatus: true,
              alibabaTotalAmount: true, shippingFee: true,
              logisticsCompany: true, logisticsNo: true,
            },
          },
          products: {
            select: {
              id: true, sku: true, chineseName: true, imageUrl: true,
              purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
              // ★ 1688 映射核心字段
              externalProductId: true,   // 1688 offerId（商品维度唯一标识）
              externalSkuId:     true,   // 1688 specId（32位 MD5，下单必填）
              externalSkuIdNum:  true,   // 1688 skuId（纯数字，兜底用）
              externalSynced:    true,   // 是否已确认 1688 映射
              externalOrderId:   true,   // 已下单时的 1688 订单号
            },
          },
          warehouse: { select: { id: true, name: true, type: true } },
        },
        // 新增字段直接从主单查（无需额外 join）
        // Prisma 默认已包含主表所有字段，此处仅记录用于文档自解释
      }),
    ]);

    // ── 各 Tab 计数（一次性返回，前端可直接渲染徽标）──────────────
    const [cntPending, cntPurchasing, cntCompleted, cntCancelled] = await prisma.$transaction([
      prisma.purchaseOrder.count({ where: { status: 'PENDING' } }),
      prisma.purchaseOrder.count({ where: { status: { in: ['PLACED', 'IN_TRANSIT', 'PARTIAL'] } } }),
      prisma.purchaseOrder.count({ where: { status: 'RECEIVED' } }),
      prisma.purchaseOrder.count({ where: { status: 'CANCELLED' } }),
    ]);

    // ── 兜底补查：收集 items.productIds 中引用但 products 关联缺失的产品 ──
    //
    // 场景：Product.purchaseOrderId 是单 FK，若同一产品被多次建单，
    // 后建的订单会覆盖 FK，导致先建订单的 products 关联断裂。
    // 这里通过 productIds JSON 做二次查找，确保前端始终能拿到明细。
    const missingPidSet = new Set<number>();
    for (const o of rawList) {
      const relatedIds = new Set(((o as any).products as any[] ?? []).map((p: any) => p.id));
      for (const item of ((o as any).items as any[] ?? [])) {
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          for (const pid of pids) {
            if (!relatedIds.has(pid)) missingPidSet.add(pid);
          }
        } catch { /* ignore */ }
      }
    }
    let fallbackProdMap = new Map<number, any>();
    if (missingPidSet.size > 0) {
      const fallbackProds = await prisma.product.findMany({
        where: { id: { in: Array.from(missingPidSet) } },
        select: {
          id: true, sku: true, chineseName: true, imageUrl: true,
          purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
          externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
          externalSynced: true, externalOrderId: true,
        },
      });
      fallbackProdMap = new Map(fallbackProds.map((p) => [p.id, p]));
    }

    // ── 合并 products 信息进 items，前端子表直接读 items[i].* ─────
    const list = await Promise.all(rawList.map(async (o) => {
      const rawItems    = (o as any).items    as any[] ?? [];
      const rawProducts = (o as any).products as any[] ?? [];
      const prodById    = new Map<number, any>(rawProducts.map((p: any) => [p.id, p]));
      // 将兜底查到的产品也合入此 map
      for (const [pid, prod] of fallbackProdMap) {
        if (!prodById.has(pid)) prodById.set(pid, prod);
      }

      const mergedItems = rawItems.map((item: any, idx: number) => {
        let prod: any = null;
        let productId: number | null = null;
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          if (pids.length > 0) {
            productId = pids[0];
            prod = prodById.get(pids[0]) ?? null;
          }
        } catch { /* ignore */ }
        if (!prod) prod = rawProducts[idx] ?? null;
        // 兜底：若 JSON 解析失败但 prod 已通过 rawProducts 兜底拿到，确保 productId 同步
        if (productId == null && prod?.id != null) productId = prod.id;
        // 坏账兜底①：productIds 空/脏时，用子单 offerId 对齐 Product.externalProductId（含 fallbackProdMap 补查到的产品）
        if (productId == null) {
          const offerTrim = String(item.offerId ?? '').trim();
          if (offerTrim) {
            const p = Array.from(prodById.values()).find(
              (rp: any) => String(rp.externalProductId ?? '').trim() === offerTrim,
            );
            if (p) {
              productId = p.id;
              prod = prod ?? p;
            }
          }
        }
        // 坏账兜底②：一品一单：当前单关联产品唯一时直接对齐
        if (productId == null) {
          const allProds = Array.from(prodById.values());
          if (allProds.length === 1) {
            const only = allProds[0];
            productId = only.id;
            prod = prod ?? only;
          }
        }

        return {
          id:                 item.id,
          offerId:            item.offerId            ?? null,
          quantity:           item.quantity,
          receivedQuantity:   item.receivedQuantity   ?? 0,  // ← 已入库累计量，缺失时兜底 0
          alibabaOrderId:     item.alibabaOrderId     ?? null,
          alibabaOrderStatus: item.alibabaOrderStatus ?? null,
          alibabaTotalAmount: item.alibabaTotalAmount != null ? Number(item.alibabaTotalAmount) : null,
          shippingFee:        item.shippingFee        != null ? Number(item.shippingFee)        : null,
          logisticsCompany:   item.logisticsCompany   ?? null,
          logisticsNo:        item.logisticsNo        ?? null,
          // ★ 合并进来的产品字段，前端直接读
          productId,                                           // ★ 产品真实主键（解析自 productIds JSON，前端绑定接口必须用此值）
          sku:                prod?.sku               ?? null,
          chineseName:        prod?.chineseName       ?? null,
          imageUrl:           prod?.imageUrl          ?? null,
          purchasePrice:      prod?.purchasePrice != null ? Number(prod.purchasePrice) : null,
          purchaseQuantity:   item.quantity,            // ★ 绑定子单计划量，不依赖可断裂的 Product FK
          purchaseUrl:        prod?.purchaseUrl       ?? null,
          // ★ 1688 映射字段：前端下单弹窗必需
          externalProductId:  prod?.externalProductId ?? null,  // 1688 offerId
          externalSkuId:      prod?.externalSkuId     ?? null,  // 1688 specId（32位MD5）
          externalSkuIdNum:   prod?.externalSkuIdNum  ?? null,  // 1688 skuId（纯数字兜底）
          externalSynced:     prod?.externalSynced    ?? false, // 是否已映射 1688
          externalOrderId:    prod?.externalOrderId   ?? null,  // 已下单的 1688 订单号
        };
      });

      // 坏账兜底③：仍缺 productId 时，按 purchaseOrderId 反查产品（重下单释放 FK 后 include.products 常为空）
      if (mergedItems.some((mi) => mi.productId == null)) {
        const extra = await prisma.product.findMany({
          where: { purchaseOrderId: o.id },
          select: {
            id: true, sku: true, chineseName: true, imageUrl: true,
            purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
            externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
            externalSynced: true, externalOrderId: true,
          },
        });
        const patchMi = (mi: any, p: any) => {
          mi.productId = p.id;
          mi.sku = mi.sku ?? p.sku ?? null;
          mi.chineseName = mi.chineseName ?? p.chineseName ?? null;
          mi.imageUrl = mi.imageUrl ?? p.imageUrl ?? null;
          if (mi.purchasePrice == null && p.purchasePrice != null) mi.purchasePrice = Number(p.purchasePrice);
          mi.purchaseUrl = mi.purchaseUrl ?? p.purchaseUrl ?? null;
          mi.externalProductId = mi.externalProductId ?? p.externalProductId ?? null;
          mi.externalSkuId = mi.externalSkuId ?? p.externalSkuId ?? null;
          mi.externalSkuIdNum = mi.externalSkuIdNum ?? p.externalSkuIdNum ?? null;
          mi.externalSynced = Boolean(mi.externalSynced) || Boolean(p.externalSynced);
          mi.externalOrderId = mi.externalOrderId ?? p.externalOrderId ?? null;
        };
        for (const mi of mergedItems) {
          if (mi.productId != null) continue;
          if (extra.length === 1) {
            patchMi(mi, extra[0]);
          } else if (extra.length > 1 && mi.offerId) {
            const ot = String(mi.offerId).trim();
            const hit = extra.find((x) => String(x.externalProductId ?? '').trim() === ot);
            if (hit) patchMi(mi, hit);
          }
        }
        // 最后手段：本单已无 purchaseOrderId 挂载（如 CANCELLED 释放后），按子单 offerId 全局唯一定位产品
        for (const mi of mergedItems) {
          if (mi.productId != null) continue;
          const ot = String(mi.offerId ?? '').trim();
          if (!ot) continue;
          const one = await prisma.product.findFirst({
            where: { externalProductId: ot, isDeleted: false },
            select: {
              id: true, sku: true, chineseName: true, imageUrl: true,
              purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
              externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
              externalSynced: true, externalOrderId: true,
            },
          });
          if (one) patchMi(mi, one);
        }
      }

      // ★ 聚合 1688 实际金额到父级（一品一单：直取 items[0] 的值）
      //   mergedItems 为空（历史脏数据）或字段未回填（PENDING 状态）时安全兜底 null。
      const firstItem = mergedItems[0] ?? null;
      const alibabaTotalAmount = firstItem?.alibabaTotalAmount != null
        ? firstItem.alibabaTotalAmount
        : null;
      const shippingFee = firstItem?.shippingFee != null
        ? firstItem.shippingFee
        : null;

      return {
        id:              o.id,
        orderNo:         o.orderNo,
        operator:        o.operator,
        totalAmount:        Number(o.totalAmount),  // 本地参考总金额（建单时快照：采购价 × 数量）
        alibabaTotalAmount,                          // 1688 实际下单总金额（含运费，1688 接口回填）
        shippingFee,                                 // 1688 实际运费
        itemCount:       o.itemCount,
        status:          o.status,
        remark:          (o as any).remark           ?? null,
        // ★ 新字段：1688 订单号、供应商、物流
        alibabaOrderId:  (o as any).alibabaOrderId   ?? null,
        supplierName:    (o as any).supplierName      ?? null,
        logisticsCompany:(o as any).logisticsCompany  ?? null,
        trackingNumber:  (o as any).trackingNumber    ?? null,
        logisticsStatus: (o as any).logisticsStatus   ?? null,
        createdAt:       o.createdAt,
        items:           mergedItems,    // ← 已合并产品信息，前端子表直接用
        products:        Array.from(prodById.values()),  // ← 含兜底补查，向后兼容
        warehouse:       (o as any).warehouse ?? null,
      };
    }));

    res.json({
      code: 200,
      data: {
        total, page, pageSize, list,
        tabCounts: {
          ALL:        cntPending + cntPurchasing + cntCompleted + cntCancelled,
          PENDING:    cntPending,
          PURCHASING: cntPurchasing,
          COMPLETED:  cntCompleted,
          CANCELLED:  cntCancelled,
        },
      },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/purchases]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单列表失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id/products
//
// 采购单子表明细（前端展开行时调用）
//
// 返回该采购单下所有关联产品，并融合 PurchaseOrderItem 的 1688 字段。
// 注意：PurchaseOrderItem 无直接 FK 到 Product，通过两条查询 + 内存合并实现：
//   ① prisma.product.findMany({ where: { purchaseOrderId: id } })
//   ② prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } })
//   ③ 以 productIds JSON 为桥，将 item 字段合并进每个 product 行
//
// ★ 必须注册在 /:id 之前，否则 Express 会把 "products" 当作 id 参数。
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/products', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // ① 查关联产品（通过 Product.purchaseOrderId 反向关联）
    let products = await prisma.product.findMany({
      where:   { purchaseOrderId: id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, pnk: true, sku: true, chineseName: true,
        imageUrl: true, purchaseUrl: true,
        purchasePrice: true, purchaseQuantity: true,
        // ★ 1688 映射核心字段
        externalProductId: true,   // 1688 offerId
        externalSkuId:     true,   // 1688 specId（32位MD5，下单必填）
        externalSkuIdNum:  true,   // 1688 skuId（纯数字，兜底）
        externalSynced:    true,   // 是否已映射确认
        externalOrderId:   true,   // 已下单时的 1688 订单号
        status: true,
      },
    });

    // ② 查子单明细（PurchaseOrderItem）
    const orderItems = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: id },
      select: {
        id: true, offerId: true, productIds: true, quantity: true,
        receivedQuantity: true,                                      // ← 已入库累计量（前端"已入库量"显示的来源）
        alibabaOrderId: true, alibabaOrderStatus: true,
        alibabaTotalAmount: true, shippingFee: true,
        logisticsCompany: true, logisticsNo: true,
      },
    });

    // ③ 建立 productId → item 的映射（通过 productIds JSON 解析）
    const itemByProductId = new Map<number, typeof orderItems[0]>();
    for (const item of orderItems) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          if (!itemByProductId.has(pid)) itemByProductId.set(pid, item);
        }
      } catch { /* ignore malformed JSON */ }
    }

    // ③.5 兜底补查：当 Product.purchaseOrderId FK 被后建订单覆盖导致 products 为空时，
    //       通过 items.productIds JSON 直接按 ID 查补，确保展开行永不空白。
    if (products.length === 0 && itemByProductId.size > 0) {
      const fallbackIds = Array.from(itemByProductId.keys());
      const fallbackProds = await prisma.product.findMany({
        where: { id: { in: fallbackIds } },
        select: {
          id: true, pnk: true, sku: true, chineseName: true,
          imageUrl: true, purchaseUrl: true,
          purchasePrice: true, purchaseQuantity: true,
          externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
          externalSynced: true, externalOrderId: true,
          status: true,
        },
      });
      products = fallbackProds as typeof products;
      console.log(
        `[GET /purchases/${id}/products] ⚠️ FK断裂兜底：products原为空，` +
        `通过 itemByProductId 补查到 ${products.length} 个产品 → ids: ${fallbackIds.join(',')}`,
      );
    }

    // ④ debug：打印关键采购单的数据结构，供验证
    console.log(
      `[GET /purchases/${id}/products] products=${products.length} items=${orderItems.length}` +
      (products.length > 0 ? ` | skus: ${products.map((p) => p.sku).join(',')}` : ' | ⚠️ products仍为空！'),
    );

    // ⑤ 合并：每个 product 行追加对应的 1688 item 字段
    const list = products.map((p) => {
      const item = itemByProductId.get(p.id);
      return {
        // 产品基础字段
        id:               p.id,
        pnk:              p.pnk,
        sku:              p.sku              ?? null,
        chineseName:      p.chineseName      ?? null,
        imageUrl:         p.imageUrl         ?? null,
        purchaseUrl:      p.purchaseUrl      ?? null,
        purchasePrice:    p.purchasePrice    != null ? Number(p.purchasePrice) : null,
        purchaseQuantity: p.purchaseQuantity ?? null,
        status:           p.status,
        // ★ 1688 映射字段
        externalProductId: p.externalProductId ?? null,  // 1688 offerId
        externalSkuId:     p.externalSkuId     ?? null,  // 1688 specId
        externalSkuIdNum:  p.externalSkuIdNum  ?? null,  // 1688 skuId 纯数字
        externalSynced:    p.externalSynced    ?? false,
        externalOrderId:   p.externalOrderId   ?? null,
        // 1688 子单字段（无子单时为 null）
        purchaseOrderItemId: item?.id                                          ?? null,
        offerId:             item?.offerId                                     ?? null,
        quantity:            item?.quantity                                    ?? p.purchaseQuantity ?? null,
        receivedQuantity:    item?.receivedQuantity                            ?? 0,  // ← 已入库累计量，缺失时兜底 0
        alibabaOrderId:      item?.alibabaOrderId                              ?? null,
        alibabaOrderStatus:  item?.alibabaOrderStatus                          ?? null,
        alibabaTotalAmount:  item?.alibabaTotalAmount != null
                               ? Number(item.alibabaTotalAmount)               : null,
        shippingFee:         item?.shippingFee        != null
                               ? Number(item.shippingFee)                      : null,
        logisticsCompany:    item?.logisticsCompany                            ?? null,
        logisticsNo:         item?.logisticsNo                                 ?? null,
      };
    });

    // ★ 验证日志：打印每个 item 的 receivedQuantity，确认已正确透传给前端
    console.log(
      `[GET /purchases/${id}/products] ✅ 最终返回 list.length=${list.length}`,
      list.map((item) => `sku=${item.sku ?? item.id} quantity=${item.quantity} receivedQuantity=${item.receivedQuantity}`).join(' | '),
    );
    res.json({ code: 200, data: list, message: 'success' });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id/products]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单明细失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/sync-1688
//
// 原子同步：订单状态 + 专项物流信息 一次请求全部落库。
//
// 内部串行调用两个 1688 接口：
//   ① alibaba.trade.get.buyerView          → 订单状态 / 供应商 / 基础物流
//   ② alibaba.trade.getLogisticsInfos.buyerView → 精确物流单号 / 公司 / logisticsId
//
// 合并规则（物流字段优先级）：
//   logisticsCompany : getLogisticsInfos 优先，buyerView 兜底
//   trackingNumber   : getLogisticsInfos.logisticsBillNo 优先，buyerView.logisticsId 兜底
//
// 前提：主单必须已有 alibabaOrderId。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/sync-1688', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 取主单
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true,
        items: { select: { id: true } },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该订单未关联 1688 单号，无法同步。请先通过 bind-1688-order 或 place-1688-order 绑定 1688 订单号',
      });
      return;
    }

    const aliOrderId = order.alibabaOrderId;

    // ── ① alibaba.trade.get.buyerView（订单状态 + 供应商 + 基础物流） ──
    const detail = await syncOrderDetail(aliOrderId);
    if (isAliServiceError(detail)) {
      res.status(502).json({
        code: 502, data: null,
        message: detail.message,
        errorCode: detail.errorCode,
      });
      return;
    }

    // ── buyerView 返回的物流数据（取第一条，多包裹取最新包裹） ───
    // 注意：alibaba.trade.getLogisticsInfos.buyerView 需要独立权限套餐，
    //       若应用未开通则返回 gw.APIUnsupported。
    //       buyerView 已在 logisticsOrders 中包含完整物流信息，直接使用，无需额外调用。
    const firstLogistics = detail.logisticsOrders[0] ?? null;

    // ── 状态映射：1688 状态文本 → 人类可读中文 ───────────────────
    const STATUS_MAP: Record<string, string> = {
      waitbuyerpay:     '等待买家付款',
      waitallpay:       '等待拼单付款',
      waitsellersend:   '等待卖家发货',
      waitbuyerreceive: '等待买家收货',
      success:          '交易成功',
      closed:           '交易关闭',
      cancelled:        '已取消',
    };
    const humanStatus = STATUS_MAP[detail.alibabaStatus] ?? detail.alibabaStatus;

    // ── 构建一次性落库数据对象 ───────────────────────────────────
    const updateData: Record<string, unknown> = {
      supplierName:    detail.supplierName ?? detail.sellerLoginId ?? undefined,
      logisticsStatus: firstLogistics
        ? `[${firstLogistics.logisticsCompanyName}] ${firstLogistics.logisticsStatus || humanStatus}`
        : humanStatus,
    };
    if (firstLogistics?.logisticsCompanyName) updateData.logisticsCompany = firstLogistics.logisticsCompanyName;
    if (firstLogistics?.logisticsId)          updateData.trackingNumber   = firstLogistics.logisticsId;

    // ── 同步子单状态与金额（PurchaseOrderItem） ──────────────────
    if (order.items.length > 0) {
      await prisma.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderStatus: detail.alibabaStatus,
          alibabaTotalAmount: detail.totalAmount > 0 ? detail.totalAmount : undefined,
          shippingFee:        detail.shippingFee  > 0 ? detail.shippingFee  : undefined,
        },
      });
    }

    // ── 原子落库至 PurchaseOrder 主单 ────────────────────────────
    const updated = await prisma.purchaseOrder.update({
      where:  { id },
      data:   updateData,
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true, supplierName: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
        warehouse: { select: { id: true, name: true } },
      },
    });

    console.log(
      `[sync-1688] 采购单 #${id}(${order.orderNo}) 同步完成：` +
      `aliStatus=${detail.alibabaStatus} | ` +
      `company=${firstLogistics?.logisticsCompanyName ?? 'none'} | ` +
      `trackingNo=${firstLogistics?.logisticsId ?? 'none'}`,
    );

    res.json({
      code: 200,
      data: {
        order: updated,
        alibabaStatus:    detail.alibabaStatus,
        alibabaStatusCN:  humanStatus,
        totalAmount:      detail.totalAmount,
        shippingFee:      detail.shippingFee,
        sellerLoginId:    detail.sellerLoginId,
        logisticsOrders:  detail.logisticsOrders,
      },
      message: `1688 订单状态与物流信息已同步：${humanStatus}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/sync-1688]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '同步失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/sync-logistics
//
// 专项物流信息同步：调用 alibaba.trade.getLogisticsInfos.buyerView，
// 提取物流公司名 + 运单号 + logisticsId，落库至 PurchaseOrder 主单。
//
// 前提：主单必须已有 alibabaOrderId。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/sync-logistics', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, alibabaOrderId: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该采购单未关联 1688 单号，请先绑定后再同步物流',
      });
      return;
    }

    // 调用 alibaba.trade.getLogisticsInfos.buyerView
    const infosResult = await syncLogisticsInfos(order.alibabaOrderId);
    if (isAliServiceError(infosResult)) {
      res.status(502).json({ code: 502, data: null, message: infosResult.message, errorCode: infosResult.errorCode });
      return;
    }

    if (infosResult.logisticsInfos.length === 0) {
      res.json({
        code: 200,
        data: { synced: false, reason: '1688 暂无物流记录（可能尚未发货）' },
        message: '暂无物流信息，可能尚未发货',
      });
      return;
    }

    // 取第一条物流单写入主单（多包裹场景下首包为主）
    const first = infosResult.logisticsInfos[0];

    const updateData: Record<string, string> = {};
    if (first.logisticsCompanyName) updateData.logisticsCompany = first.logisticsCompanyName;
    if (first.logisticsBillNo)      updateData.trackingNumber   = first.logisticsBillNo;
    // logisticsId 暂无专属字段，复用 trackingNumber 为主（若二者不同则以 logisticsBillNo 为准）

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, orderNo: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
      },
    });

    console.log(
      `[sync-logistics] 采购单 #${id}(${order.orderNo}) 物流落库 → ` +
      `公司=${first.logisticsCompanyName} 运单号=${first.logisticsBillNo} logisticsId=${first.logisticsId}`,
    );

    res.json({
      code: 200,
      data: {
        order: updated,
        logisticsInfos: infosResult.logisticsInfos,
      },
      message: `物流信息已同步：${first.logisticsCompanyName} ${first.logisticsBillNo}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/sync-logistics]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '物流信息同步失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id/logistics-trace
//
// 查询物流轨迹流转节点。
//
// 优先级策略（三级降级）：
//   ① alibaba.trade.getLogisticsTraceInfo.buyerView（按订单号直查，首选）
//   ② 已落库的 trackingNumber → alibaba.logistics.trace.info.get（兜底）
//   ③ 先调 buyerView 拿运单号 → 再查轨迹（兜底的兜底）
// ─────────────────────────────────────────────────────────────────────
router.get('/:id/logistics-trace', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: {
        id: true, orderNo: true,
        alibabaOrderId: true,
        trackingNumber: true,
        logisticsCompany: true,
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (!order.alibabaOrderId) {
      res.status(400).json({
        code: 400, data: null,
        message: '该订单未关联 1688 单号，无法查询物流轨迹',
      });
      return;
    }

    // ── 统一节点格式转换（内部 eventTime/description → 前端 Timeline 所需 time/content） ──
    const toTimelineNodes = (nodes: Array<{ eventTime: string; description: string; location: string | null }>) =>
      nodes.map((n) => ({
        time:        n.eventTime,
        content:     n.description,
        location:    n.location ?? null,
        // 保留原始字段，向后兼容
        eventTime:   n.eventTime,
        description: n.description,
      })).sort((a, b) => {
        const ta = new Date(a.time).getTime();
        const tb = new Date(b.time).getTime();
        return isNaN(ta) || isNaN(tb) ? 0 : tb - ta;
      });

    // ── ① 优先：alibaba.trade.getLogisticsTraceInfo.buyerView ────────
    //   namespace 必须为 com.alibaba.logistics（已修正，旧写法 com.alibaba.trade → gw.APIUnsupported）
    const traceByOrder = await getLogisticsTraceByOrder(order.alibabaOrderId);
    if (!isAliServiceError(traceByOrder) && traceByOrder.nodes.length > 0) {
      // 顺手把运单号落库（防止下次再请求）
      if (traceByOrder.logisticsBillNo || traceByOrder.logisticsId) {
        const trackingNum = traceByOrder.logisticsBillNo || traceByOrder.logisticsId;
        await prisma.purchaseOrder.update({
          where: { id },
          data: {
            trackingNumber:   trackingNum || undefined,
            logisticsCompany: traceByOrder.logisticsCompanyName || undefined,
          },
        }).catch(() => { /* 落库失败不影响主流程 */ });
      }

      res.json({
        code: 200,
        data: {
          logisticsId:          traceByOrder.logisticsId || traceByOrder.logisticsBillNo,
          logisticsBillNo:      traceByOrder.logisticsBillNo,
          logisticsCompanyName: traceByOrder.logisticsCompanyName,
          nodes:                toTimelineNodes(traceByOrder.nodes),
          source:               'buyerView',
        },
        message: 'success',
      });
      return;
    }

    // ── ① 降级处理：getLogisticsTraceInfo 返回 gw.APIUnsupported 表示账号未开通此权限 ──
    //   不再抛 502，转走 ② 兜底链路
    if (isAliServiceError(traceByOrder)) {
      console.warn(
        `[logistics-trace] getLogisticsTraceInfo.buyerView 失败（${traceByOrder.errorCode}）` +
        `，降级走 alibaba.logistics.trace.info.get 或 sync-1688 链路`,
      );
    }

    // ── ② 兜底：按已落库运单号 → alibaba.logistics.trace.info.get ───
    let logisticsId = order.trackingNumber;
    let companyName = order.logisticsCompany ?? '';

    // ── ③ 兜底的兜底：先调 buyerView 拿运单号 ──────────────────────
    if (!logisticsId) {
      const detail = await syncOrderDetail(order.alibabaOrderId);
      if (isAliServiceError(detail)) {
        // 三级均失败；若 gw.APIUnsupported 则友好提示，否则 502
        const errMsg = isAliServiceError(traceByOrder) ? traceByOrder.message : detail.message;
        const isUnsupported = (traceByOrder as any)?.errorCode === 'gw.APIUnsupported'
          || detail.errorCode === 'gw.APIUnsupported';
        if (isUnsupported) {
          res.json({
            code: 200,
            data: { nodes: [], logisticsCompanyName: '', logisticsBillNo: '', unsupported: true },
            message: '当前 1688 应用未开通物流轨迹查询权限，请在 1688 开放平台申请开通',
          });
        } else {
          res.status(502).json({ code: 502, data: null, message: errMsg });
        }
        return;
      }
      const first = detail.logisticsOrders[0] ?? null;
      if (!first?.logisticsId) {
        res.json({
          code: 200,
          data: { nodes: [], logisticsCompanyName: companyName, logisticsBillNo: '', noShipment: true },
          message: '该 1688 订单暂无物流运单号（可能尚未发货）',
        });
        return;
      }
      logisticsId = first.logisticsId;
      companyName = first.logisticsCompanyName;
      await prisma.purchaseOrder.update({
        where: { id },
        data: { trackingNumber: logisticsId, logisticsCompany: companyName || undefined },
      }).catch(() => {});
    }

    const trace = await getLogisticsTrace(logisticsId);
    if (isAliServiceError(trace)) {
      // gw.APIUnsupported → 降级为友好提示
      if ((trace as any).errorCode === 'gw.APIUnsupported') {
        res.json({
          code: 200,
          data: {
            nodes: [], logisticsCompanyName: companyName,
            logisticsBillNo: logisticsId, unsupported: true,
          },
          message: '当前 1688 应用未开通物流轨迹查询权限，请在 1688 开放平台申请开通',
        });
      } else {
        res.status(502).json({ code: 502, data: null, message: trace.message });
      }
      return;
    }

    res.json({
      code: 200,
      data: {
        logisticsId,
        logisticsBillNo:      logisticsId,
        logisticsCompanyName: trace.logisticsCompanyName || companyName,
        nodes:                toTimelineNodes(trace.nodes),
        source:               'logisticsTrace',
      },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id/logistics-trace]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '查询物流轨迹失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/purchases/:id/logistics
//
// 手动回填 / 更新物流信息（支持线下采购场景）
//
// Body（均可选，至少传一个）:
//   logisticsCompany  String  物流公司（如：极兔、顺丰、中通）
//   trackingNumber    String  运单号
//   logisticsStatus   String  最新物流状态文本（可选）
//   supplierName      String  供应商名称（可选）
//   alibabaOrderId    String  1688 订单号（可选，补录）
// ─────────────────────────────────────────────────────────────────────
router.patch('/:id/logistics', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const {
      logisticsCompany,
      trackingNumber,
      logisticsStatus,
      supplierName,
      alibabaOrderId: aliId,
    } = req.body ?? {};

    // 至少需要提供一个有效字段
    const updateData: Record<string, string> = {};
    if (logisticsCompany && String(logisticsCompany).trim())
      updateData.logisticsCompany = String(logisticsCompany).trim();
    if (trackingNumber && String(trackingNumber).trim())
      updateData.trackingNumber   = String(trackingNumber).trim();
    if (logisticsStatus && String(logisticsStatus).trim())
      updateData.logisticsStatus  = String(logisticsStatus).trim();
    if (supplierName && String(supplierName).trim())
      updateData.supplierName     = String(supplierName).trim();
    if (aliId && String(aliId).trim())
      updateData.alibabaOrderId   = String(aliId).trim();

    if (Object.keys(updateData).length === 0) {
      res.status(400).json({
        code: 400, data: null,
        message: '请至少提供一个字段（logisticsCompany / trackingNumber / logisticsStatus / supplierName / alibabaOrderId）',
      });
      return;
    }

    // 校验采购单存在
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, status: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  updateData,
      select: {
        id: true, orderNo: true, status: true,
        alibabaOrderId: true, supplierName: true,
        logisticsCompany: true, trackingNumber: true, logisticsStatus: true,
        warehouse: { select: { id: true, name: true } },
      },
    });

    console.log(
      `[logistics] 采购单 #${id}(${order.orderNo}) 物流信息更新：`,
      JSON.stringify(updateData),
    );

    res.json({
      code: 200,
      data: updated,
      message: '物流信息已更新',
    });
  } catch (err: any) {
    console.error('[PATCH /api/purchases/:id/logistics]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新物流信息失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/purchases/:id/warehouse
//
// 前置绑定目标入库仓库（任意状态均可更新，RECEIVED 除外）
// Body: { warehouseId: number }
// ─────────────────────────────────────────────────────────────────────
router.patch('/:id/warehouse', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId } = req.body ?? {};
    const whId = parseInt(String(warehouseId), 10);
    if (isNaN(whId) || whId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId 为必填项且必须是有效数字' });
      return;
    }

    // 校验仓库存在且启用
    const wh = await prisma.warehouse.findUnique({
      where:  { id: whId },
      select: { id: true, name: true, status: true },
    });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用，请重新选择' });
      return;
    }

    // 校验采购单存在
    const order = await prisma.purchaseOrder.findUnique({
      where:  { id },
      select: { id: true, orderNo: true, status: true },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'RECEIVED') {
      res.status(400).json({ code: 400, data: null, message: '已入库的采购单不允许修改目标仓库' });
      return;
    }

    const updated = await prisma.purchaseOrder.update({
      where: { id },
      data:  { warehouseId: whId },
      select: {
        id: true, orderNo: true, status: true,
        warehouseId: true,
        warehouse: { select: { id: true, name: true, type: true } },
      },
    });

    console.log(`[warehouse] 采购单 #${id}(${order.orderNo}) 绑定仓库 → ${wh.name}(id=${whId})`);
    res.json({
      code: 200,
      data: updated,
      message: `目标仓库已更新为【${wh.name}】`,
    });
  } catch (err: any) {
    console.error('[PATCH /api/purchases/:id/warehouse]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新仓库失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/purchases/:id
// 采购单详情
// ─────────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: true,
        products: {
          select: {
            id: true, sku: true, chineseName: true, title: true, imageUrl: true,
            purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
            externalProductId: true,
            externalSkuId:     true,
            externalSkuIdNum:  true,   // 1688 skuId 纯数字兜底
            externalSynced:    true,   // 换链失效标识（false = 需重新绑规格）
            externalOrderId:   true,
          },
        },
        warehouse: { select: { id: true, name: true, type: true, status: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 将 products 建 Map，为 items 补充干净的 productId 整数字段 ──────────
    // 背景：PurchaseOrderItem 通过 productIds JSON 字符串（如 "[12345]"）关联产品，
    //   没有直接的 productId 外键字段。前端下单弹窗需要产品真实 ID 调用绑定接口，
    //   必须在此处解析并输出，否则前端只能读到 item.id（子单主键）而误用。
    let prodById = new Map<number, any>(
      ((order as any).products as any[] ?? []).map((p: any) => [p.id, p]),
    );

    const itemsRaw = ((order as any).items as any[] ?? []);

    const mergeDetailItems = (prodMap: Map<number, any>) =>
      itemsRaw.map((item: any) => {
        let prod: any = null;
        let productId: number | null = null;
        try {
          const pids: number[] = JSON.parse(item.productIds ?? '[]');
          if (pids.length > 0) {
            productId = pids[0];
            prod = prodMap.get(pids[0]) ?? null;
          }
        } catch { /* ignore */ }
        if (productId == null && prod?.id != null) productId = prod.id;
        const vals = Array.from(prodMap.values());
        if (productId == null) {
          const offerTrim = String(item.offerId ?? '').trim();
          if (offerTrim) {
            const p = vals.find((rp: any) => String(rp.externalProductId ?? '').trim() === offerTrim);
            if (p) {
              productId = p.id;
              prod = prod ?? p;
            }
          }
        }
        if (productId == null && vals.length === 1) {
          const only = vals[0];
          productId = only.id;
          prod = prod ?? only;
        }
        return {
          ...item,
          productId,
          sku:               prod?.sku               ?? null,
          chineseName:       prod?.chineseName       ?? null,
          imageUrl:          prod?.imageUrl          ?? null,
          purchasePrice:     prod?.purchasePrice != null ? Number(prod.purchasePrice) : null,
          purchaseUrl:       prod?.purchaseUrl       ?? null,
          externalProductId: prod?.externalProductId ?? null,
          externalSkuId:     prod?.externalSkuId     ?? null,
          externalSkuIdNum:  prod?.externalSkuIdNum  ?? null,
          externalSynced:    prod?.externalSynced    ?? false,
          externalOrderId:   prod?.externalOrderId   ?? null,
        };
      });

    let itemsWithProductId = mergeDetailItems(prodById);
    if (itemsWithProductId.some((r) => r.productId == null)) {
      const extra = await prisma.product.findMany({
        where: { purchaseOrderId: id },
        select: {
          id: true, sku: true, chineseName: true, title: true, imageUrl: true,
          purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
          externalProductId: true,
          externalSkuId:     true,
          externalSkuIdNum:  true,
          externalSynced:    true,
          externalOrderId:   true,
        },
      });
      for (const p of extra) {
        if (!prodById.has(p.id)) prodById.set(p.id, p);
      }
      itemsWithProductId = mergeDetailItems(prodById);
    }

    if (itemsWithProductId.some((r) => r.productId == null)) {
      for (const row of itemsWithProductId) {
        if (row.productId != null) continue;
        const ot = String((row as any).offerId ?? '').trim();
        if (!ot) continue;
        const one = await prisma.product.findFirst({
          where: { externalProductId: ot, isDeleted: false },
          select: {
            id: true, sku: true, chineseName: true, title: true, imageUrl: true,
            purchasePrice: true, purchaseQuantity: true, purchaseUrl: true,
            externalProductId: true,
            externalSkuId:     true,
            externalSkuIdNum:  true,
            externalSynced:    true,
            externalOrderId:   true,
          },
        });
        if (!one) continue;
        (row as any).productId = one.id;
        (row as any).sku = (row as any).sku ?? one.sku ?? null;
        (row as any).chineseName = (row as any).chineseName ?? one.chineseName ?? null;
        (row as any).imageUrl = (row as any).imageUrl ?? one.imageUrl ?? null;
        if ((row as any).purchasePrice == null && one.purchasePrice != null) {
          (row as any).purchasePrice = Number(one.purchasePrice);
        }
        (row as any).purchaseUrl = (row as any).purchaseUrl ?? one.purchaseUrl ?? null;
        (row as any).externalProductId = (row as any).externalProductId ?? one.externalProductId ?? null;
        (row as any).externalSkuId = (row as any).externalSkuId ?? one.externalSkuId ?? null;
        (row as any).externalSkuIdNum = (row as any).externalSkuIdNum ?? one.externalSkuIdNum ?? null;
        (row as any).externalSynced = Boolean((row as any).externalSynced) || Boolean(one.externalSynced);
        (row as any).externalOrderId = (row as any).externalOrderId ?? one.externalOrderId ?? null;
      }
    }

    res.json({
      code: 200,
      data: { ...order, items: itemsWithProductId },
      message: 'success',
    });
  } catch (err: any) {
    console.error('[GET /api/purchases/:id]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '获取采购单详情失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/place-1688-order
//
// 在采购管理页手动触发真实 1688 下单（解耦后的第二步）
//
// 前置条件：采购单 status 必须是 PENDING；关联产品必须已绑定 1688 offerId + specId
// Body: { addressId?: string }（可选收货地址，不传则用环境变量默认地址）
//
// 流程：
//   ① 查本地采购单 + 关联产品
//   ② 组装 cargo → 调用 alibaba.trade.fastCreateOrder
//   ③ 回填 PurchaseOrderItem.alibabaOrderId + Product.externalOrderId
//   ④ PurchaseOrder.status → PLACED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/place-1688-order', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { addressId } = req.body ?? {};

    // ── 查采购单 + 关联产品 ────────────────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: {
            id: true, offerId: true, productIds: true, quantity: true, alibabaOrderId: true,
          },
        },
        products: {
          select: {
            id: true, sku: true, chineseName: true,
            externalProductId: true, externalSkuId: true, externalSynced: true,
            purchaseQuantity: true, purchaseUrl: true,
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ★ 防呆：下单前必须已绑定目标仓库
    if (!order.warehouseId) {
      res.status(400).json({
        code: 400, data: null,
        message: '请先指定入库目标仓库后再进行下单操作！（PATCH /api/purchases/:id/warehouse）',
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({
        code: 400, data: null,
        message: `当前状态为 ${order.status}，仅 PENDING（待下单）状态可以执行 1688 下单`,
      });
      return;
    }

    // 已经有 1688 订单号的子单不允许重复下单
    const alreadyPlaced = order.items.find((i) => !!i.alibabaOrderId);
    if (alreadyPlaced) {
      res.status(400).json({
        code: 400, data: null,
        message: `该采购单已有 1688 订单号 ${alreadyPlaced.alibabaOrderId}，请勿重复下单`,
      });
      return;
    }

    // ★ Layer 2 — 换链联动拦截：检测 purchaseUrl 中的 offerId 与 externalProductId 是否一致
    //
    // 场景：业务员更换了 purchaseUrl 但未重新选择 1688 规格，
    //       externalSynced 已被 buildPurchaseUrlUpdate 置为 false。
    // 此时 externalSkuId 属于旧商品，与新 offerId 不匹配，下单必然失败。
    // 直接在此拦截并给出明确提示，避免消耗 1688 API 配额。
    const staleProducts = order.products.filter((p) => p.externalSynced === false);
    if (staleProducts.length > 0) {
      const skuList = staleProducts.map((p) => p.sku ?? `id=${p.id}`).join(', ');
      console.warn(
        `[place-1688-order] ⛔ 拦截：采购单 #${id}(${order.orderNo}) 中 ${staleProducts.length} 个产品` +
        ` externalSynced=false，换链后规格未重新绑定。SKUs: ${skuList}`,
      );
      res.status(400).json({
        code: 400,
        data: {
          staleSkus: staleProducts.map((p) => ({
            sku:               p.sku,
            purchaseUrl:       p.purchaseUrl,
            externalProductId: p.externalProductId,
            externalSkuId:     p.externalSkuId,
          })),
        },
        message: `以下产品的采购链接已更换，但 1688 规格尚未重新绑定，请先在采购计划页选择新规格再下单：${skuList}`,
      });
      return;
    }

    // ── 组装 1688 下单参数 ─────────────────────────────────────────
    const SPEC_ID_REGEX = /^[a-fA-F0-9]{32}$/;
    const validProducts = order.products.filter(
      (p) => p.externalProductId && p.externalSkuId && SPEC_ID_REGEX.test(p.externalSkuId),
    );

    if (validProducts.length === 0) {
      res.status(400).json({
        code: 400, data: null,
        message: '该采购单关联的产品未绑定有效的 1688 规格（需 offerId + 32位 MD5 specId），请先在采购计划页绑定 1688 规格',
      });
      return;
    }

    const cargoItems = validProducts.map((p) => ({
      offerId:  String(p.externalProductId!).trim(),
      specId:   String(p.externalSkuId!).trim(),
      quantity: Math.max(1, Number(p.purchaseQuantity) || order.items[0]?.quantity || 1),
    }));

    // ── 调用 1688 阿里巴巴开放平台 API ────────────────────────────
    const addressIdStr = addressId ? String(addressId) : undefined;
    const result = await createAlibabaOrder(cargoItems, addressIdStr);

    if (!result.success) {
      console.error(`[place-1688-order] 1688 下单失败 PO#${id}:`, result.errorMessage);

      // ★ 精准 SPEC_INVALID 防御：
      // 只有 1688 明确返回 offer/spec/sku 不存在、不匹配、商品已下架等“绑定失效”语义时，
      // 才允许自动清空本地规格绑定。余额不足、地址错误、专供品声明、起批量等业务错误
      // 必须原样返回前端，绝对禁止篡改本地 SKU 绑定状态。
      const isSpecError = isAlibabaSpecInvalidError(result);

      if (isSpecError) {
        const affectedIds = validProducts.map((p) => p.id);
        await prisma.product.updateMany({
          where: { id: { in: affectedIds } },
          data:  { externalSkuId: null, externalSkuIdNum: null, externalSynced: false },
        });
        console.warn(
          `[place-1688-order] ⚠️ SPEC_NOT_FOUND 触发自动重置：已清空 ${affectedIds.length} 个产品的 externalSkuId` +
          `，externalSynced=false。SKUs: ${validProducts.map((p) => p.sku).join(', ')}`,
        );
        res.json({
          code: 400,
          data: {
            success: false,
            errorCode:    result.errorCode,
            errorMessage: result.errorMessage,
            autoReset:    true,
            resetSkus:    validProducts.map((p) => p.sku),
          },
          message: `1688 规格已失效，系统已自动重置规格绑定，请重新在采购计划页选择规格后再下单。（原始错误: ${result.errorMessage}）`,
        });
        return;
      }

      res.json({
        code: 200,
        data: {
          success: false,
          errorCode:    result.errorCode,
          errorMessage: result.errorMessage,
          raw:          result.raw,
          autoReset:    false,
        },
        message: `1688 下单失败: ${result.errorMessage}`,
      });
      return;
    }

    const aliOrderId     = result.data!.orderId;
    const aliTotalAmount = result.data!.totalAmount;

    // 尝试从 1688 返回数据中提取供应商名称（字段因接口版本而异，做容错读取）
    const supplierName: string | null =
      (result.data as any)?.supplierLoginId ??
      (result.data as any)?.sellerLoginId   ??
      (result.data as any)?.supplierName    ?? null;

    // ── 回填数据库 ────────────────────────────────────────────────
    await prisma.$transaction(async (tx) => {
      // 更新子单（★ 同步补全 productIds JSON，避免历史/异常路径下子单缺关联导致前端 productId 恒为 null）
      for (const item of order.items) {
        const productIdsJson = buildProductIdsJsonForItem(item, order.products);
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: {
            alibabaOrderId:     aliOrderId,
            alibabaOrderStatus: 'waitbuyerpay',
            alibabaTotalAmount: aliTotalAmount > 0 ? aliTotalAmount : undefined,
            productIds:         productIdsJson,
          },
        });
      }

      // 更新主单：状态 + ★ 1688 订单号 + 供应商名称上移至主单
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:          'PLACED',
          totalAmount:     aliTotalAmount > 0 ? aliTotalAmount : order.totalAmount,
          alibabaOrderId:  aliOrderId,
          supplierName:    supplierName ?? undefined,
        },
      });

      // 更新关联产品
      await tx.product.updateMany({
        where: { id: { in: validProducts.map((p) => p.id) } },
        data:  { externalOrderId: aliOrderId, externalSynced: true, status: 'ORDERED' },
      });
    });

    console.log(
      `[place-1688-order] 采购单 PO#${id}(${order.orderNo}) → 1688 下单成功！` +
      `aliOrderId=${aliOrderId} amount=${aliTotalAmount}`,
    );

    res.json({
      code: 200,
      data: {
        success:     true,
        orderId:     id,
        orderNo:     order.orderNo,
        aliOrderId,
        aliTotalAmount,
      },
      message: `1688 下单成功！订单号: ${aliOrderId}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/place-1688-order]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '1688 下单接口异常' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/bind-1688-order
//
// 手动回填绑定：业务员线下已在 1688 下单，将订单号手动关联到内部采购单
//
// Body: { alibabaOrderId: string }
//
// 逻辑：
//   ① 校验采购单存在且状态为 PENDING（防止重复绑定）
//   ② 事务内：更新所有子单 PurchaseOrderItem.alibabaOrderId + 主单 status → PLACED
//   ③ 同步更新关联产品 externalOrderId、状态 → ORDERED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/bind-1688-order', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { alibabaOrderId, supplierName } = req.body ?? {};

    // 参数校验
    if (!alibabaOrderId || typeof alibabaOrderId !== 'string' || !alibabaOrderId.trim()) {
      res.status(400).json({ code: 400, data: null, message: 'alibabaOrderId（1688 官方订单号）为必填项' });
      return;
    }
    const cleanAliOrderId  = alibabaOrderId.trim();
    const cleanSupplierName = supplierName ? String(supplierName).trim() : null;

    // 查采购单（含子单 + 关联产品）
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: { id: true, alibabaOrderId: true, offerId: true, productIds: true },
        },
        products: { select: { id: true, externalProductId: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // 防止重复绑定：已有 1688 订单号则拒绝
    const alreadyBound = order.items.find((i) => !!i.alibabaOrderId);
    if (alreadyBound) {
      res.status(400).json({
        code: 400, data: null,
        message: `该采购单已绑定 1688 订单号 ${alreadyBound.alibabaOrderId}，如需修改请联系管理员`,
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({
        code: 400, data: null,
        message: `当前状态为 ${order.status}，仅 PENDING（待下单）状态允许手动绑定 1688 订单号`,
      });
      return;
    }

    // ── 事务：回填订单号 + 更新状态 ──────────────────────────────
    await prisma.$transaction(async (tx) => {
      // 1. 所有子单回填 alibabaOrderId + 状态标记
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderId:     cleanAliOrderId,
          alibabaOrderStatus: 'waitbuyerpay',   // 线下下单默认为待付款
        },
      });

      // 1b. 逐子单补全 productIds（与 place-1688-order 一致，修复坏账）
      for (const item of order.items) {
        const productIdsJson = buildProductIdsJsonForItem(item, order.products);
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data:  { productIds: productIdsJson },
        });
      }

      // 2. 主单状态 → PLACED，同步回填 1688 订单号 + 供应商至主单
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:         'PLACED',
          alibabaOrderId: cleanAliOrderId,
          supplierName:   cleanSupplierName ?? undefined,
        },
      });

      // 3. 关联产品：回填 externalOrderId、标记已同步
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            externalOrderId: cleanAliOrderId,
            externalSynced:  true,
            status:          'ORDERED',
          },
        });
      }
    });

    console.log(
      `[bind-1688-order] 采购单 #${id}(${order.orderNo}) 手动绑定 1688 订单号 ${cleanAliOrderId}，` +
      `状态 PENDING → PLACED`,
    );

    res.json({
      code: 200,
      data: {
        orderId:       id,
        orderNo:       order.orderNo,
        alibabaOrderId: cleanAliOrderId,
        status:        'PLACED',
      },
      message: `1688 订单号 ${cleanAliOrderId} 已成功绑定到采购单 ${order.orderNo}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/bind-1688-order]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '绑定失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/mark-purchasing
//
// 线下采购标记：不走 1688 API，直接将本地采购单状态更新为"采购中"
// 适用场景：业务员线下打款 / 微信下单 / 非 1688 渠道采购
//
// 可选 Body: { alibabaOrderId?: string }（如有线下单号可一并回填）
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/mark-purchasing', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: { select: { id: true } }, products: { select: { id: true } } },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ★ 防呆：线下采购标记前也必须先绑定目标仓库
    if (!order.warehouseId) {
      res.status(400).json({
        code: 400, data: null,
        message: '请先指定入库目标仓库后再进行下单操作！（PATCH /api/purchases/:id/warehouse）',
      });
      return;
    }

    if (order.status !== 'PENDING') {
      res.status(400).json({ code: 400, data: null, message: `当前状态 ${order.status}，仅 PENDING 可标记为采购中` });
      return;
    }

    const { alibabaOrderId } = req.body ?? {};
    const cleanAliId = alibabaOrderId ? String(alibabaOrderId).trim() : null;

    await prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: 'PLACED' },
      });

      if (cleanAliId) {
        await tx.purchaseOrderItem.updateMany({
          where: { purchaseOrderId: id },
          data: { alibabaOrderId: cleanAliId, alibabaOrderStatus: 'waitbuyerpay' },
        });
      }

      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data:  { status: 'ORDERED', ...(cleanAliId ? { externalOrderId: cleanAliId, externalSynced: true } : {}) },
        });
      }
    });

    console.log(`[mark-purchasing] 采购单 #${id}(${order.orderNo}) PENDING → PLACED（线下采购）`);
    res.json({
      code: 200,
      data: { orderId: id, orderNo: order.orderNo, status: 'PLACED' },
      message: '已标记为采购中',
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/mark-purchasing]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '操作失败' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/stock-in
//
// 精准入库（支持分批到货）：仓库人员清点实物后，按实盘量累加入库。
//
// Body:
//   warehouseId  number    目标入库仓（必填）
//   items        Array?    实盘明细（可选）
//     └ productId       number  产品 ID
//     └ receivedQuantity number  本次实际到货数量（必须 > 0）
//
// 若不传 items，则兜底使用 purchaseQuantity（向后兼容旧版一键入库）。
//
// 状态流转：
//   (PLACED | IN_TRANSIT | PARTIAL) + 本次入库后：
//     → 累计已收 >= 计划数量：status = RECEIVED（全部到货，闭环）
//     → 累计已收 <  计划数量：status = PARTIAL（部分到货，等待剩余）
//
// 事务逻辑：
//   ① 累加 PurchaseOrderItem.receivedQuantity（按 productIds JSON 映射）
//   ② WarehouseStock upsert（stockQuantity += 本次实盘量）
//   ③ 扣减在途库存（GREATEST 防负数）
//   ④ 重聚合 Product.stockActual（汇总全仓库存）
//   ⑤ 写 PURCHASE_IN 库存流水（含计划/实收差异备注）
//   ⑥ 全部到货时：产品 status → SELECTED（回归正常在售态）
//   ⑦ 主单 status → PARTIAL 或 RECEIVED
//
// ★ FK 断裂兜底：通过 PurchaseOrderItem.productIds JSON 补查产品，确保不漏 SKU。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/stock-in', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    const { warehouseId, items: receivedItems } = req.body ?? {};

    // ── 校验 warehouseId ──────────────────────────────────────────
    const whId = parseInt(String(warehouseId), 10);
    if (isNaN(whId) || whId <= 0) {
      res.status(400).json({ code: 400, data: null, message: 'warehouseId（目标仓库）为必填项' });
      return;
    }
    const wh = await prisma.warehouse.findUnique({ where: { id: whId }, select: { id: true, name: true, status: true } });
    if (!wh || wh.status !== 'ACTIVE') {
      res.status(400).json({ code: 400, data: null, message: '仓库不存在或已停用' });
      return;
    }

    // ── 校验 items 实盘数据（若传入） ────────────────────────────
    let receivedMap = new Map<number, number>(); // productId → receivedQuantity
    if (Array.isArray(receivedItems) && receivedItems.length > 0) {
      for (const item of receivedItems) {
        const pid = parseInt(String(item.productId), 10);
        const qty = Number(item.receivedQuantity);
        if (isNaN(pid) || pid <= 0) {
          res.status(400).json({ code: 400, data: null, message: `items 中存在无效的 productId: ${item.productId}` });
          return;
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          res.status(400).json({ code: 400, data: null, message: `productId=${pid} 的 receivedQuantity 必须大于 0` });
          return;
        }
        receivedMap.set(pid, Math.floor(qty)); // 取整，防止小数库存
      }
    }

    // ── 查采购单 + 关联产品 + 子单 ───────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        products: {
          select: { id: true, sku: true, purchaseQuantity: true, purchasePrice: true },
        },
        items: {
          select: { id: true, productIds: true, quantity: true, receivedQuantity: true },
        },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 状态拦截：只允许 PLACED / IN_TRANSIT / PARTIAL 执行入库 ──
    const STOCKIN_ALLOWED = ['PLACED', 'IN_TRANSIT', 'PARTIAL'];
    if (!STOCKIN_ALLOWED.includes(order.status)) {
      const hint = order.status === 'RECEIVED'
        ? '该采购单已全部入库，请勿重复操作'
        : `当前状态 ${order.status} 不支持入库，请先完成下单`;
      res.status(400).json({ code: 400, data: null, message: hint });
      return;
    }

    // ── 构建产品全集（FK 正常路径 + FK 断裂兜底路径） ────────────
    const productIdSet = new Set<number>(order.products.map((p) => p.id));
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) productIdSet.add(pid);
      } catch { /* ignore */ }
    }

    if (productIdSet.size === 0) {
      res.status(400).json({ code: 400, data: null, message: '该采购单无关联产品，无法入库' });
      return;
    }

    // 补查 FK 断裂产品
    const knownProdMap = new Map(order.products.map((p) => [p.id, p]));
    const missingIds   = Array.from(productIdSet).filter((pid) => !knownProdMap.has(pid));
    if (missingIds.length > 0) {
      const fallback = await prisma.product.findMany({
        where:  { id: { in: missingIds } },
        select: { id: true, sku: true, purchaseQuantity: true, purchasePrice: true },
      });
      for (const p of fallback) knownProdMap.set(p.id, p);
    }
    const allProducts = Array.from(knownProdMap.values());

    // ── 若前端未传实盘量，兜底使用 purchaseQuantity ──────────────
    if (receivedMap.size === 0) {
      for (const prod of allProducts) {
        receivedMap.set(prod.id, Math.max(1, prod.purchaseQuantity ?? 1));
      }
    }

    // ── 建立 productId → PurchaseOrderItem 映射（含计划量和已收量） ──
    const productToItemMap  = new Map<number, number>();
    const productToItemData = new Map<number, { quantity: number; receivedQuantity: number }>();
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          if (!productToItemMap.has(pid)) {
            productToItemMap.set(pid, item.id);
            productToItemData.set(pid, { quantity: item.quantity, receivedQuantity: item.receivedQuantity });
          }
        }
      } catch { /* ignore */ }
    }

    // ★★★ 防超收硬拦截 ★★★
    const overReceiveErrors: string[] = [];
    for (const [productId, thisQty] of receivedMap.entries()) {
      const itemData = productToItemData.get(productId);
      if (!itemData) continue;
      const alreadyReceived = itemData.receivedQuantity;
      const planQty         = itemData.quantity;
      if (alreadyReceived + thisQty > planQty) {
        const prod = allProducts.find((p) => p.id === productId);
        overReceiveErrors.push(
          `SKU [${prod?.sku ?? productId}]：本次入库 ${thisQty} + 已入库 ${alreadyReceived} = ${alreadyReceived + thisQty}，超出计划采购量 ${planQty}`,
        );
      }
    }
    if (overReceiveErrors.length > 0) {
      res.status(400).json({
        code:    400,
        data:    null,
        message: `入库总数不可超过采购总数，拒绝超收！\n${overReceiveErrors.join('\n')}`,
      });
      return;
    }

    const userId = req.user!.userId;
    const stockDetails: Array<{ productId: number; sku: string; receivedQty: number; newStockActual: number }> = [];

    await prisma.$transaction(async (tx) => {
      for (const prod of allProducts) {
        const receivedQty = receivedMap.get(prod.id) ?? 0;
        if (receivedQty <= 0) continue;

        // ① 累加 PurchaseOrderItem.receivedQuantity（追踪历次到货总量）
        const itemId = productToItemMap.get(prod.id);
        if (itemId) {
          await tx.purchaseOrderItem.update({
            where: { id: itemId },
            data:  { receivedQuantity: { increment: receivedQty } },
          });
        }

        // ② WarehouseStock upsert：按实盘量累加物理库存
        await tx.warehouseStock.upsert({
          where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
          create: { productId: prod.id, warehouseId: whId, stockQuantity: receivedQty, inTransitQuantity: 0 },
          update: { stockQuantity: { increment: receivedQty } },
        });

        // ③ 扣减在途量（GREATEST 防负数）
        await tx.$executeRaw`
          UPDATE warehouse_stocks
          SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${receivedQty})
          WHERE  product_id = ${prod.id}
          AND    warehouse_id = ${whId}
        `;

        // ④ 重聚合 Product.stockActual
        const allWs = await tx.warehouseStock.findMany({
          where:  { productId: prod.id },
          select: { stockQuantity: true },
        });
        const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
        await tx.product.update({
          where: { id: prod.id },
          data:  { stockActual: newStockActual },
        });

        // ⑤ 写 PURCHASE_IN 流水（含计划/实收备注）
        const planQty  = prod.purchaseQuantity ?? 1;
        const diffNote = receivedQty !== planQty
          ? `（计划 ${planQty} 件，本次实收 ${receivedQty} 件）`
          : '';
        await applyStockChange(tx, {
          productId:      prod.id,
          warehouseId:    whId,
          changeQuantity: receivedQty,
          type:           'PURCHASE_IN',
          referenceId:    String(order.id),
          remark:         `采购单 ${order.orderNo} 精准入库${diffNote}（仓库: ${wh.name}）`,
          createdBy:      userId,
        });

        stockDetails.push({ productId: prod.id, sku: prod.sku ?? `#${prod.id}`, receivedQty, newStockActual });
      }

      // ⑥ 读取所有子单最新累计量，判断状态
      const updatedItems = await tx.purchaseOrderItem.findMany({
        where:  { purchaseOrderId: id },
        select: { quantity: true, receivedQuantity: true },
      });
      const totalPlan     = updatedItems.reduce((s, i) => s + i.quantity,         0);
      const totalReceived = updatedItems.reduce((s, i) => s + i.receivedQuantity, 0);
      const newStatus     = totalReceived >= totalPlan ? 'RECEIVED' : 'PARTIAL';

      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: newStatus as any, warehouseId: whId },
      });

      // ⑦ 全部到货时，产品回归正常在售态
      if (newStatus === 'RECEIVED') {
        await tx.product.updateMany({
          where: { id: { in: allProducts.map((p) => p.id) } },
          data:  { status: 'SELECTED' },
        });
      }
    });

    // 重新读取状态（事务内修改后 order 对象未刷新）
    const finalOrder  = await prisma.purchaseOrder.findUnique({ where: { id }, select: { status: true } });
    const finalStatus = finalOrder?.status ?? 'PARTIAL';
    const totalReceivedQty = stockDetails.reduce((s, d) => s + d.receivedQty, 0);

    // ★ 强制验证日志：事务提交后重新从 DB 读取 receivedQuantity，证明数据已落库
    const verifyItems = await prisma.purchaseOrderItem.findMany({
      where:  { purchaseOrderId: id },
      select: { id: true, quantity: true, receivedQuantity: true },
    });
    console.log(
      `[stock-in][DB验证] 采购单 #${id}(${order.orderNo}) 事务提交后从DB重新读取子单 receivedQuantity：`,
      verifyItems.map((i) => `ItemId=${i.id} 计划=${i.quantity} 已收=${i.receivedQuantity}`).join(' | '),
    );

    console.log(
      `[stock-in] 采购单 #${id}(${order.orderNo}) 入库 → ${wh.name}，` +
      `${stockDetails.length} SKU 合计实收 ${totalReceivedQty} 件，状态 → ${finalStatus}`,
    );

    res.json({
      code: 200,
      data: {
        orderId:         id,
        orderNo:         order.orderNo,
        status:          finalStatus,
        warehouse:       { id: wh.id, name: wh.name },
        stockedSkuCount: stockDetails.length,
        totalQuantity:   totalReceivedQty,
        details:         stockDetails,
        isPartial:       finalStatus === 'PARTIAL',
      },
      message: finalStatus === 'RECEIVED'
        ? `${stockDetails.length} 个 SKU 共 ${totalReceivedQty} 件已全部入库至【${wh.name}】`
        : `本次入库 ${totalReceivedQty} 件，采购单部分到货（PARTIAL），可继续入库或强制结单`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/stock-in]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '入库失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/force-complete
//
// 强制结单：针对 PARTIAL / PLACED / IN_TRANSIT 状态的采购单，
// 人工宣告放弃等待剩余货物，强制将订单状态更新为 RECEIVED（已结单）。
//
// ★ 核心库存清理：遍历所有子单，计算"永远不会到货"的欠量：
//   undeliveredQty = item.quantity - item.receivedQuantity
// 从 WarehouseStock.inTransitQuantity 中扣除欠量（GREATEST 防负数），
// 防止在途库存长期虚高影响补货决策。
//
// 事务逻辑：
//   ① 主单 status → RECEIVED
//   ② 遍历产品：计算欠量，扣减 inTransitQuantity（永不到货部分归零）
//   ③ 重聚合 Product.stockActual
//   ④ 产品 status → SELECTED
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/force-complete', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 查主单 + 子单 + 关联产品
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: { id: true, productIds: true, quantity: true, receivedQuantity: true },
        },
        products: {
          select: { id: true, sku: true, purchaseQuantity: true },
        },
        warehouse: { select: { id: true, name: true } },
      },
    });
    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ── 状态拦截：只允许未完结的单强制结单 ──────────────────────
    const FORCE_ALLOWED = ['PLACED', 'IN_TRANSIT', 'PARTIAL'];
    if (!FORCE_ALLOWED.includes(order.status)) {
      const hint = order.status === 'RECEIVED'
        ? '该采购单已完成入库，无需强制结单'
        : `当前状态 ${order.status} 不支持强制结单`;
      res.status(400).json({ code: 400, data: null, message: hint });
      return;
    }

    // ── 构建产品全集（FK 正常 + FK 断裂兜底） ────────────────────
    const productIdSet = new Set<number>(order.products.map((p) => p.id));
    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) productIdSet.add(pid);
      } catch { /* ignore */ }
    }

    const knownProdMap = new Map(order.products.map((p) => [p.id, p]));
    const missingIds   = Array.from(productIdSet).filter((pid) => !knownProdMap.has(pid));
    if (missingIds.length > 0) {
      const fallback = await prisma.product.findMany({
        where:  { id: { in: missingIds } },
        select: { id: true, sku: true, purchaseQuantity: true },
      });
      for (const p of fallback) knownProdMap.set(p.id, p);
    }
    const allProducts = Array.from(knownProdMap.values());

    // ── 建立 productId → 欠量 映射 ───────────────────────────────
    // 欠量 = item.quantity(计划) - item.receivedQuantity(已收)
    const productToUndelivered = new Map<number, number>(); // productId → undeliveredQty
    for (const item of order.items) {
      const undelivered = Math.max(0, item.quantity - item.receivedQuantity);
      if (undelivered <= 0) continue;
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        for (const pid of pids) {
          productToUndelivered.set(pid, (productToUndelivered.get(pid) ?? 0) + undelivered);
        }
      } catch { /* ignore */ }
    }

    const whId = order.warehouseId;
    const cleanupSummary: Array<{ productId: number; sku: string; undeliveredQty: number }> = [];

    await prisma.$transaction(async (tx) => {
      // ① 主单 → RECEIVED（强制结单）
      await tx.purchaseOrder.update({
        where: { id },
        data:  { status: 'RECEIVED' as any },
      });

      // ② 清理残留在途库存（永不到货的欠量）
      for (const prod of allProducts) {
        const undeliveredQty = productToUndelivered.get(prod.id) ?? 0;

        if (undeliveredQty > 0 && whId) {
          // ★ 核心：从 inTransitQuantity 中扣除欠量，防止在途库存长期虚高
          await tx.$executeRaw`
            UPDATE warehouse_stocks
            SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${undeliveredQty})
            WHERE  product_id = ${prod.id}
            AND    warehouse_id = ${whId}
          `;
          cleanupSummary.push({ productId: prod.id, sku: prod.sku ?? `#${prod.id}`, undeliveredQty });
        }

        // ③ 重聚合 Product.stockActual（在途减少后重算）
        const allWs = await tx.warehouseStock.findMany({
          where:  { productId: prod.id },
          select: { stockQuantity: true },
        });
        const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
        await tx.product.update({
          where: { id: prod.id },
          data:  { stockActual: newStockActual },
        });
      }

      // ④ 产品 status → SELECTED（正式回归库存在售态）
      if (allProducts.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: allProducts.map((p) => p.id) } },
          data:  { status: 'SELECTED' },
        });
      }
    });

    const totalCleanedQty = cleanupSummary.reduce((s, c) => s + c.undeliveredQty, 0);
    console.log(
      `[force-complete] 采购单 #${id}(${order.orderNo}) 强制结单：` +
      `清理 ${cleanupSummary.length} 个产品共 ${totalCleanedQty} 件在途残量`,
    );

    res.json({
      code: 200,
      data: {
        orderId:            id,
        orderNo:            order.orderNo,
        prevStatus:         order.status,
        currentStatus:      'RECEIVED',
        cleanedProductCount: cleanupSummary.length,
        totalCleanedQty,
        cleanupSummary,     // 各 SKU 清理详情（前端可展示）
      },
      message: cleanupSummary.length > 0
        ? `强制结单成功，已清理 ${cleanupSummary.length} 个 SKU 共 ${totalCleanedQty} 件在途残量`
        : '强制结单成功（所有货物已全部到货，无需清理在途库存）',
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/force-complete]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '强制结单失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/rollback
//
// 高危撤销：将采购单从任意状态强制回退至 PENDING（未下单）
//
// 核心逆向逻辑（事务内串行执行）：
//   ① 查主单 + 关联 items + products + warehouseId
//   ② 若状态为 RECEIVED（已入库）→ 逐 SKU 扣减 WarehouseStock.stockQuantity
//      + 重聚合 Product.stockActual + 写 MANUAL_ADJUST 流水（负数变动）
//   ③ 抹除 PurchaseOrderItem 的 1688 关联信息（alibabaOrderId / status）
//   ④ 主单重置：status → PENDING，warehouseId → null
//   ⑤ 关联产品重置：status → PURCHASING，externalOrderId → null，
//      purchaseOrderId 保留（产品仍绑在此采购单）
//
// 注意：已是 PENDING 的单直接返回 400，防止幂等误操作。
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/rollback', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // ── 查主单及所有关联数据 ─────────────────────────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items: {
          select: {
            id: true,
            alibabaOrderId: true,
            alibabaOrderStatus: true,
            quantity: true,
          },
        },
        products: {
          select: {
            id: true,
            sku: true,
            purchaseQuantity: true,
            stockActual: true,
          },
        },
        warehouse: { select: { id: true, name: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }
    if (order.status === 'PENDING') {
      res.status(400).json({ code: 400, data: null, message: '该采购单已是"未下单"状态，无需回退' });
      return;
    }

    const userId     = req.user!.userId;
    const wasReceived = order.status === 'RECEIVED';
    const whId        = order.warehouseId ?? null;

    // ── 事务：逆向操作全部在一个原子操作内完成 ─────────────────
    const rollbackSummary = await prisma.$transaction(async (tx) => {
      const stockChanges: Array<{ sku: string; before: number; after: number; delta: number }> = [];

      // ── Step ②：已入库 → 扣减多仓库存 ───────────────────────
      if (wasReceived && whId) {
        for (const prod of order.products) {
          const qty = Math.max(1, prod.purchaseQuantity ?? 1);

          // 扣减 WarehouseStock（防止负数：最多扣到 0）
          const ws = await tx.warehouseStock.findUnique({
            where: { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
            select: { stockQuantity: true },
          });
          const currentWsQty = ws?.stockQuantity ?? 0;
          const newWsQty     = Math.max(0, currentWsQty - qty);

          if (ws) {
            await tx.warehouseStock.update({
              where: { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
              data:  { stockQuantity: newWsQty },
            });
          }

          // 重聚合 Product.stockActual（所有仓库汇总）
          const allWs = await tx.warehouseStock.findMany({
            where:  { productId: prod.id },
            select: { stockQuantity: true },
          });
          const newStockActual = allWs.reduce((s, w) => s + w.stockQuantity, 0);
          await tx.product.update({
            where: { id: prod.id },
            data:  { stockActual: newStockActual },
          });

          // 写 MANUAL_ADJUST 流水（changeQuantity 为负数，记录为回退扣减）
          await applyStockChange(tx, {
            productId:      prod.id,
            warehouseId:    whId,
            changeQuantity: -(qty),
            type:           'MANUAL_ADJUST',
            referenceId:    String(order.id),
            remark:         `采购单回退 ${order.orderNo}：撤销入库，扣减库存`,
            createdBy:      userId,
          });

          stockChanges.push({
            sku:    prod.sku ?? String(prod.id),
            before: currentWsQty,
            after:  newWsQty,
            delta:  -(qty),
          });

          // ★ 重建在途库存：入库被撤销，货物逻辑上重回"在途"状态
          await tx.warehouseStock.upsert({
            where:  { productId_warehouseId: { productId: prod.id, warehouseId: whId } },
            create: { productId: prod.id, warehouseId: whId, inTransitQuantity: qty },
            update: { inTransitQuantity: { increment: qty } },
          });
        }
      }

      // ── Step ③：抹除 PurchaseOrderItem 的 1688 关联信息 ──────
      await tx.purchaseOrderItem.updateMany({
        where: { purchaseOrderId: id },
        data: {
          alibabaOrderId:     null,
          alibabaOrderStatus: null,
        },
      });

      // ── Step ④：主单重置 PENDING，清空 warehouseId ───────────
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          status:      'PENDING',
          warehouseId: null,
        },
      });

      // ── Step ⑤：关联产品状态回退 ─────────────────────────────
      // ORDERED → PURCHASING（回到采购计划待建单状态）
      // ★ 必须清空 purchaseOrderId：让产品重新出现在 GET /api/products/purchasing 列表
      // ★ 同时清空 externalOrderId / externalSynced（1688 订单信息作废）
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            status:          'PURCHASING',
            purchaseOrderId: null,    // 解除与采购单的绑定，让产品重回采购计划
            externalOrderId: null,
            externalSynced:  false,
          },
        });
      }

      return stockChanges;
    });

    const totalRolledBackQty = rollbackSummary.reduce((s, c) => s + Math.abs(c.delta), 0);

    console.log(
      `[rollback] 采购单 #${id}(${order.orderNo}) ${order.status} → PENDING，` +
      `库存回滚: ${wasReceived ? `${rollbackSummary.length} SKU 共 ${totalRolledBackQty} 件` : '无（非已入库状态）'}`,
    );

    res.json({
      code: 200,
      data: {
        orderId:      id,
        orderNo:      order.orderNo,
        prevStatus:   order.status,
        currentStatus: 'PENDING',
        stockRolledBack: wasReceived,
        warehouse:    order.warehouse ?? null,
        stockChanges: rollbackSummary,
      },
      message: wasReceived
        ? `采购单已回退至未下单，并已从【${order.warehouse?.name ?? '入库仓'}】扣减 ${totalRolledBackQty} 件库存`
        : `采购单已回退至未下单（原状态 ${order.status}，无库存变动）`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/rollback]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '回退失败，请稍后重试' });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/purchases/:id/cancel-and-release
//
// 1688 交易取消后：冻结旧采购单 + 释放产品需求回采购计划
//
// 业务背景：1688 订单被取消（alibabaOrderStatus = 'cancelled'/'closed'）后，
//   不能复用旧 PO ID 去绑定新的 1688 订单（财务对账需要旧凭据完整保留）。
//   本接口将旧 PO 冻结为 CANCELLED 状态（保留全部 1688 订单信息作为历史凭据），
//   同时释放关联产品需求，使其重新出现在采购计划列表，由业务员重新建单下单。
//
// 前置条件：
//   ① PO 必须存在
//   ② PO 状态必须为 PLACED（已下单过 1688）
//   ③ 至少一个 PurchaseOrderItem 的 alibabaOrderStatus 为 'cancelled' 或 'closed'
//
// 事务逻辑：
//   ① 主单：status → CANCELLED（旧单完整冻结，alibabaOrderId 等信息绝不清空）
//   ② 关联产品：purchaseOrderId → null，status → PURCHASING，externalOrderId → null
//      ★ 绝对不清空 externalSynced / externalSkuId（保留用户规格绑定成果）
//   ③ PurchaseOrderItem：保持不变（历史凭据，一字不改）
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/cancel-and-release', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // ── 查主单 + items（取消校验 + 在途扣减用）+ products（释放用）────────────────
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        items:    { select: { id: true, alibabaOrderStatus: true, quantity: true } },
        products: { select: { id: true, sku: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ① 状态校验：只允许 PLACED 状态执行取消释放
    if (order.status !== 'PLACED') {
      const statusLabel: Record<string, string> = {
        PENDING:    '待下单',
        IN_TRANSIT: '运输中',
        PARTIAL:    '部分入库',
        RECEIVED:   '已全部入库',
        CANCELLED:  '已取消',
      };
      const label = statusLabel[order.status] ?? order.status;
      res.status(400).json({
        code: 400,
        data: null,
        message: `该采购单当前状态为「${label}」，仅"已下单（PLACED）"状态的采购单支持取消释放操作`,
      });
      return;
    }

    // ② 子单取消状态校验：至少一条 item 的 1688 状态为 cancelled 或 closed
    const CANCEL_STATUSES = new Set(['cancelled', 'closed']);
    const hasCancelledItem = order.items.some(
      (item) => item.alibabaOrderStatus && CANCEL_STATUSES.has(item.alibabaOrderStatus),
    );
    if (!hasCancelledItem) {
      res.status(400).json({
        code: 400,
        data: null,
        message: '该采购单的 1688 订单尚未取消（alibabaOrderStatus 不是 cancelled/closed），请先在 1688 平台确认取消后再操作',
      });
      return;
    }

    const username = req.user!.username ?? 'unknown';
    const warehouseId = order.warehouseId ?? null;

    // 统计各产品应扣减的在途数量（按 item.quantity 汇总，一品一单通常只有一条）
    const totalQtyByProductId = new Map<number, number>();
    for (const item of order.items) {
      // productIds JSON → 解析出关联产品 ID，与 items.quantity 对应
      // 一品一单场景：每个 item 对应唯一产品，直接按 order.products 映射（若 productIds 为空）
      // 此处保守策略：将 totalQty 均摊给本单所有产品（一品一单下 products.length === 1，安全）
    }
    // 一品一单铁律：item 数量 = 产品采购数量；多 item 场景按各自 quantity 汇总给对应产品
    const totalItemQty = order.items.reduce((s, item) => s + (item.quantity ?? 0), 0);

    await prisma.$transaction(async (tx) => {
      // ① 冻结主单：status → CANCELLED，历史 1688 信息原封不动保留
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });

      // ② 扣减在途库存（★ 核心修复：PLACED 状态建单时 create-local 已 increment inTransitQuantity，
      //    取消时必须 decrement，否则产品重建新采购单后会被再次 increment，造成双倍在途）
      if (warehouseId && order.products.length > 0) {
        for (const prod of order.products) {
          // 一品一单：单产品 qty = 该产品对应 item 的 quantity；取全部 items 之和作为安全上界
          const qty = totalItemQty > 0 ? totalItemQty : 1;
          await tx.warehouseStock.updateMany({
            where: { productId: prod.id, warehouseId },
            data:  { inTransitQuantity: { decrement: qty } },
          });
          // 同步 Product.inTransitQuantity（Product 表冗余字段，与 WarehouseStock 保持一致）
          await tx.product.update({
            where: { id: prod.id },
            data:  { inTransitQuantity: { decrement: qty } },
          });
        }
      }

      // ③ 释放关联产品需求：解除绑定，退回采购计划
      //    ★ externalSynced / externalSkuId / externalProductId 绝不清空（规格绑定成果保留）
      if (order.products.length > 0) {
        await tx.product.updateMany({
          where: { id: { in: order.products.map((p) => p.id) } },
          data: {
            purchaseOrderId: null,       // 解除与旧采购单的绑定，产品重回采购计划列表
            status:          'PURCHASING', // 退回采购中状态，出现在 GET /api/products/purchasing
            externalOrderId: null,         // 清空已取消的 1688 订单号引用
            // externalSynced / externalSkuId / externalProductId ← 保留，不动
          },
        });
      }

      // ④ PurchaseOrderItem：不做任何修改，作为完整的历史凭据冻结
    });

    console.log(
      `[cancel-and-release] ${username} 取消采购单 #${id}(${order.orderNo})，` +
      `释放 ${order.products.length} 个产品回采购计划，PO 历史凭据完整保留`,
    );

    res.json({
      code: 200,
      data: {
        orderId:           id,
        orderNo:           order.orderNo,
        prevStatus:        'PLACED',
        currentStatus:     'CANCELLED',
        releasedCount:     order.products.length,
        releasedSkus:      order.products.map((p) => p.sku ?? `#${p.id}`),
        inTransitDeducted: warehouseId ? totalItemQty * order.products.length : 0,
      },
      message: `采购单 ${order.orderNo} 已取消冻结，${order.products.length} 个产品已退回采购计划，规格映射保留${warehouseId ? `，已扣减在途库存 ${totalItemQty} 件` : ''}`,
    });
  } catch (err: any) {
    console.error('[POST /api/purchases/:id/cancel-and-release]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: `取消采购单失败：${err?.message ?? '未知错误'}` });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/purchases/:id
//
// 作废并物理删除采购单（仅允许 PENDING 状态）
//
// 事务逻辑：
//   ① 状态拦截：非 PENDING 拒绝操作
//   ② 释放关联产品：purchaseOrderId → null，status → PURCHASING（回到采购计划）
//   ③ 删除 PurchaseOrderItem 子记录（FK 约束，必须先删）
//   ④ 物理删除 PurchaseOrder 主单
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id) || id <= 0) {
      res.status(400).json({ code: 400, data: null, message: '采购单 ID 无效' });
      return;
    }

    // 查主单（含关联产品 + 子单，productIds 用于 FK 断裂兜底路径重建产品集合）
    const order = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        products: { select: { id: true, sku: true, purchaseQuantity: true } },
        items:    { select: { id: true, productIds: true, quantity: true } },
      },
    });

    if (!order) {
      res.status(404).json({ code: 404, data: null, message: '采购单不存在' });
      return;
    }

    // ① 状态拦截：只允许删除 PENDING（未下单）状态的采购单
    if (order.status !== 'PENDING') {
      const statusLabel: Record<string, string> = {
        PLACED:     '已下单',
        IN_TRANSIT: '运输中',
        RECEIVED:   '已入库',
      };
      const label = statusLabel[order.status] ?? order.status;
      res.status(400).json({
        code: 400,
        data: null,
        message: `该采购单当前状态为「${label}」，仅"待下单（PENDING）"状态的采购单可作废删除`,
      });
      return;
    }

    const username = req.user!.username ?? 'unknown';

    // ── 构建 productId → qty 映射（事务外预计算，qty 权威来源：items.quantity）───
    //
    // 主路径：解析 PurchaseOrderItem.productIds JSON + item.quantity（精确下单量）
    // 降级路径：item.productIds 为空/损坏时，从 products FK 路径兜底（purchaseQuantity）
    // 两路合并 → allPidQtyMap：完整、精确、无遗漏的"需扣减在途量"映射
    const allPidQtyMap = new Map<number, number>();

    for (const item of order.items) {
      try {
        const pids: number[] = JSON.parse(item.productIds ?? '[]');
        if (pids.length > 0) {
          for (const pid of pids) {
            allPidQtyMap.set(pid, (allPidQtyMap.get(pid) ?? 0) + item.quantity);
          }
          continue;  // 主路径成功，跳过降级
        }
      } catch { /* productIds 格式损坏，降级 */ }
    }
    // 降级：FK 路径中存在但主路径未覆盖的产品
    for (const prod of order.products) {
      if (!allPidQtyMap.has(prod.id)) {
        allPidQtyMap.set(prod.id, Math.max(1, prod.purchaseQuantity ?? 1));
      }
    }

    // 用于 product.updateMany 的完整产品 ID 集合（主路径 + FK 路径的并集）
    const allPidList = [...new Set([
      ...allPidQtyMap.keys(),
      ...order.products.map((p) => p.id),
    ])];

    await prisma.$transaction(
      async (tx) => {
        // ① 释放关联产品：purchaseOrderId → null，status → PURCHASING
        //    覆盖完整 allPidList（含 FK 断裂兜底到的产品），确保无遗漏
        if (allPidList.length > 0) {
          await tx.product.updateMany({
            where: { id: { in: allPidList } },
            data: {
              purchaseOrderId: null,
              status:          'PURCHASING',
            },
          });
        }

        // ② 扣减在途库存（权威 qty 来自 items.quantity，精确扣减，GREATEST 防负数）
        //    精准路径：order.warehouseId 非空 → 只操作目标仓（行级锁防并发双扣）
        //    兜底路径：warehouseId 为 null（历史脏数据）→ 扫全仓所有在途 > 0 的行
        for (const [pid, qty] of allPidQtyMap) {
          if (order.warehouseId) {
            await tx.$executeRaw`
              UPDATE warehouse_stocks
              SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${qty})
              WHERE  product_id   = ${pid}
              AND    warehouse_id = ${order.warehouseId}
            `;
          } else {
            await tx.$executeRaw`
              UPDATE warehouse_stocks
              SET    in_transit_quantity = GREATEST(0, in_transit_quantity - ${qty})
              WHERE  product_id        = ${pid}
              AND    in_transit_quantity > 0
            `;
          }
        }

        // ③ 删除子单（FK Cascade 约束：必须先于主单执行）
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } });

        // ④ 物理删除主单
        await tx.purchaseOrder.delete({ where: { id } });

        // 四步均在同一 PostgreSQL 事务内：任一步抛错立即 ROLLBACK，绝无半程脏数据
      },
      { timeout: 15_000 },
    );

    console.log(
      `[DELETE /api/purchases/${id}] ${username} 作废采购单 ${order.orderNo}，` +
      `释放 ${allPidList.length} 个产品回采购计划，扣减在途 ${[...allPidQtyMap.values()].reduce((s, q) => s + q, 0)} 件`,
    );

    res.json({
      code: 200,
      data: {
        deletedId:      id,
        orderNo:        order.orderNo,
        releasedCount:  allPidList.length,
        releasedSkus:   order.products.map((p) => p.sku ?? `#${p.id}`),
      },
      message: `采购单 ${order.orderNo} 已作废，${allPidList.length} 个产品已退回采购计划`,
    });
  } catch (err: any) {
    console.error('[DELETE /api/purchases/:id]', err?.message ?? err);
    res.status(500).json({
      code: 500, data: null,
      message: `作废采购单失败：${err?.message ?? '未知错误'}`,
    });
  }
});

export default router;
