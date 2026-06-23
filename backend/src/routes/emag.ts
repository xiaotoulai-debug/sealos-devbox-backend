import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { getEmagCredentials } from '../services/emagClient';
import { readOrders, syncNewOrders, countOrders, acknowledgeOrders, updateOrder } from '../services/emagOrder';
import { saveFullProductOffer, saveDraftOffer, readProductOffers, readCategories, countCategories } from '../services/emagProduct';
import { batchUpdateStock, batchUpdatePrice, setOfferStatus, createOrderAwb, readAwb } from '../services/emagLogistics';

const router = Router();
router.use(authenticate);

// ─── 辅助: 从请求体/查询中取 shopId ──────────────────────────────

function shopId(req: Request): number {
  const id = Number(req.body?.shopId ?? req.query?.shopId);
  if (!id || isNaN(id)) throw new Error('缺少 shopId 参数');
  return id;
}

// ─── 订单 ─────────────────────────────────────────────────────────

// POST /api/emag/orders/sync — 拉取新订单并自动 acknowledge
router.post('/orders/sync', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await syncNewOrders(creds, {
      currentPage: req.body.currentPage,
      itemsPerPage: req.body.itemsPerPage,
    });
    res.json({
      code: 200,
      data: result,
      message: result.orders.length > 0
        ? `拉取到 ${result.orders.length} 个新订单, 已确认 ${result.acknowledged.length} 个`
        : '暂无新订单',
    });
  } catch (err: any) {
    console.error('[POST /api/emag/orders/sync]', err.message);
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/orders/read — 按条件查询订单
router.post('/orders/read', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await readOrders(creds, {
      status: req.body.status,
      createdAfter: req.body.createdAfter,
      createdBefore: req.body.createdBefore,
      currentPage: req.body.currentPage,
      itemsPerPage: req.body.itemsPerPage,
    });
    if (result.isError) {
      res.json({ code: 500, data: null, message: result.messages?.join('; ') ?? 'eMAG API 返回错误' });
    } else {
      res.json({ code: 200, data: result.results ?? [], message: 'success' });
    }
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/orders/acknowledge
router.post('/orders/acknowledge', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供 orderIds 数组' });
      return;
    }
    const result = await acknowledgeOrders(creds, orderIds);
    res.json({ code: result.isError ? 500 : 200, data: result, message: result.isError ? '确认失败' : '确认成功' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/orders/count
router.post('/orders/count', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const count = await countOrders(creds, req.body.status);
    res.json({ code: 200, data: { count }, message: 'success' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// ─── 产品 ─────────────────────────────────────────────────────────

// POST /api/emag/products/save-draft
router.post('/products/save-draft', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { partNumber, name, categoryId, salePrice, stock, warehouseId } = req.body;
    if (!partNumber || !name || !categoryId || salePrice === undefined) {
      res.status(400).json({ code: 400, data: null, message: '缺少必填字段 (partNumber, name, categoryId, salePrice)' });
      return;
    }
    const result = await saveDraftOffer(creds, { partNumber, name, categoryId, salePrice, stock, warehouseId });
    res.json({
      code: result.isError ? 500 : 200,
      data: result,
      message: result.isError ? (result.messages?.join('; ') ?? '发布失败') : '草稿产品发布成功',
    });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/products/save-full
router.post('/products/save-full', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await saveFullProductOffer(creds, req.body);
    res.json({
      code: result.isError ? 500 : 200,
      data: result,
      message: result.isError ? (result.messages?.join('; ') ?? '发布失败') : '产品发布成功',
    });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/products/read
router.post('/products/read', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await readProductOffers(creds, req.body.filters ?? {});
    res.json({ code: result.isError ? 500 : 200, data: result.results ?? [], message: result.isError ? '查询失败' : 'success' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/categories/read
router.post('/categories/read', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await readCategories(creds, req.body.filters ?? {});
    res.json({ code: result.isError ? 500 : 200, data: result.results ?? [], message: 'success' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// ─── 库存 ─────────────────────────────────────────────────────────

// POST /api/emag/stock/update
router.post('/stock/update', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供 items 数组 [{partNumber, stock}]' });
      return;
    }
    const result = await batchUpdateStock(creds, items);
    res.json({ code: result.isError ? 500 : 200, data: result, message: result.isError ? '更新失败' : `已更新 ${items.length} 个 SKU 库存` });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/stock/update-price
router.post('/stock/update-price', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供 items 数组 [{partNumber, salePrice}]' });
      return;
    }
    const result = await batchUpdatePrice(creds, items);
    res.json({ code: result.isError ? 500 : 200, data: result, message: result.isError ? '更新失败' : `已更新 ${items.length} 个 SKU 价格` });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/stock/toggle-status
router.post('/stock/toggle-status', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { partNumber, active } = req.body;
    if (!partNumber) { res.status(400).json({ code: 400, data: null, message: '缺少 partNumber' }); return; }
    const result = await setOfferStatus(creds, partNumber, !!active);
    res.json({ code: result.isError ? 500 : 200, data: result, message: active ? '已上架' : '已下架' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// ─── 物流 AWB ────────────────────────────────────────────────────

// POST /api/emag/awb/save
router.post('/awb/save', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const { orderId, weight, parcels, envelopeNumber, courierAccountId, observation } = req.body;
    if (!orderId || !weight) {
      res.status(400).json({ code: 400, data: null, message: '缺少 orderId 和 weight' });
      return;
    }
    const result = await createOrderAwb(creds, { orderId, weight, parcels, envelopeNumber, courierAccountId, observation });
    res.json({
      code: result.isError ? 500 : 200,
      data: result,
      message: result.isError ? (result.messages?.join('; ') ?? 'AWB 创建失败') : 'AWB 运单创建成功, 订单将转为 Finalized',
    });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/emag/awb/read
router.post('/awb/read', async (req: Request, res: Response) => {
  try {
    const creds = await getEmagCredentials(shopId(req));
    const result = await readAwb(creds, req.body.filters ?? {});
    res.json({ code: result.isError ? 500 : 200, data: result.results ?? [], message: 'success' });
  } catch (err: any) {
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

export default router;
