/**
 * 店铺在售产品 API — StoreProduct + Inventory SKU 碰头
 *
 * 数据源: StoreProduct（eMAG 同步），通过 sku 关联 Inventory 获取本地资料
 * 图片优先级: Inventory.local_image > 平台 main_image > 占位图
 * 毛利预估: sale_price - (purchase_cost + 预估物流费)
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { resolveRegion } from '../services/emagClient';
import { getSalesStatsByShop, getSalesForProduct, logZeroSalesDiagnostic } from '../services/salesStats';

const router = Router();
router.use(authenticate);

/**
 * POST /api/store-products/map
 * 手动绑定平台产品与库存 SKU
 * Body: { storeProductId: number, inventorySku: string }
 */
router.post('/map', async (req: Request, res: Response) => {
  try {
    const storeProductId = Number(req.body?.storeProductId ?? req.query?.storeProductId);
    const inventorySku = String(req.body?.inventorySku ?? req.query?.inventorySku ?? '').trim();
    if (!storeProductId || isNaN(storeProductId)) {
      res.status(400).json({ code: 400, data: null, message: '请提供 storeProductId' });
      return;
    }
    if (!inventorySku) {
      res.status(400).json({ code: 400, data: null, message: '请提供 inventorySku' });
      return;
    }

    const inv = await prisma.inventory.findUnique({
      where: { sku: inventorySku },
      select: { sku: true },
    });
    if (!inv) {
      res.status(400).json({ code: 400, data: null, message: `库存 SKU "${inventorySku}" 不存在，请先在 Inventory 表中创建` });
      return;
    }

    const sp = await prisma.storeProduct.findUnique({
      where: { id: storeProductId },
      select: { id: true, shopId: true },
    });
    if (!sp) {
      res.status(404).json({ code: 404, data: null, message: '平台产品不存在' });
      return;
    }

    await prisma.storeProduct.update({
      where: { id: storeProductId },
      data: { mappedInventorySku: inventorySku },
    });

    res.json({
      code: 200,
      data: { storeProductId, inventorySku },
      message: '绑定成功',
    });
  } catch (err) {
    console.error('[POST /api/store-products/map]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

/** 预估物流费：无重量时默认 5，有重量时按 2/kg 粗略估算 (单位与 sale_price 一致) */
const DEFAULT_SHIPPING = 5;
const SHIPPING_PER_KG = 2;

/**
 * GET /api/store-products
 * 查询店铺在售产品，通过 sku 与 Inventory 碰头反哺本地资料
 *
 * Query: shopId (必填), search (可选搜索), page, limit (可选分页)
 * 搜索: search 对 sku / ean / pnk 做模糊匹配 (OR, 大小写不敏感)
 * 返回: pnk, sku, ean, image, main_image, name, purchase_cost, estimated_profit, ...
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const shopId = Number(req.query.shopId);
    if (!shopId || isNaN(shopId)) {
      res.status(400).json({ code: 400, data: null, message: '缺少 shopId 参数' });
      return;
    }

    const search = String(req.query.search ?? req.query.query ?? '').trim();
    const page = Math.max(1, parseInt(String(req.query.page ?? 1), 10) || 1);
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? req.query.pageSize ?? 500), 10) || 500));
    const skip = (page - 1) * limit;

    const where: { shopId: number; OR?: Array<{ sku?: { contains: string; mode: 'insensitive' }; ean?: { contains: string; mode: 'insensitive' }; pnk?: { contains: string; mode: 'insensitive' } }> } = { shopId };
    if (search) {
      const q = { contains: search, mode: 'insensitive' as const };
      where.OR = [
        { sku: q },
        { ean: q },
        { pnk: q },
      ];
    }

    const [total, list] = await Promise.all([
      prisma.storeProduct.count({ where }),
      prisma.storeProduct.findMany({
        where,
        orderBy: { syncedAt: 'desc' },
        skip,
        take: limit,
        include: { shop: { select: { shopName: true } } },
      }),
    ]);

    console.log(`[StoreProducts] DB actual count: ${total}`);

    if (search) {
      console.log(`[Search Debug] Keyword: ${search}, Found Records: ${total}`);
    }

    const forceRefresh = String(req.query.refreshSales ?? '').toLowerCase() === '1' || String(req.query.refreshSales ?? '').toLowerCase() === 'true';
    if (forceRefresh) {
      const rawTest = await prisma.$queryRawUnsafe<Array<{ sku: string; total: string | number }>>(
        `SELECT LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\\\r', ''), E'\\\\n', ''))) as sku, SUM(COALESCE((elem->>'quantity')::int, 0)) as total FROM platform_orders, jsonb_array_elements(products_json::jsonb) as elem WHERE shop_id = ${shopId} AND status IN (1,2,3,4) AND order_time >= NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY total DESC LIMIT 5`
      );
      console.log('[Sales Raw SQL] SELECT sku, SUM(quantity) FROM platform_orders (parsed):', rawTest.map((r) => `${r.sku}=${r.total}`).join(', '));
    }
    const { map: salesMap, skusWithSales } = await getSalesStatsByShop(shopId, forceRefresh);

    const skusToFetch = new Set<string>();
    for (const p of list) {
      const mapped = (p.mappedInventorySku ?? '').trim();
      if (mapped) {
        skusToFetch.add(mapped);
      } else {
        const fallback = (p.sku ?? p.vendorSku ?? '').trim();
        if (fallback) skusToFetch.add(fallback);
      }
    }
    const inventoryMap = new Map<string, { localImage: string | null; purchaseCost: number; weight: number | null }>();
    if (skusToFetch.size > 0) {
      const invList = await prisma.inventory.findMany({
        where: { sku: { in: [...skusToFetch] } },
        select: { sku: true, localImage: true, purchaseCost: true, weight: true },
      });
      for (const inv of invList) {
        inventoryMap.set(inv.sku, {
          localImage: inv.localImage ?? null,
          purchaseCost: Number(inv.purchaseCost ?? 0),
          weight: inv.weight != null ? Number(inv.weight) : null,
        });
      }
    }

    const shopName = list[0]?.shop?.shopName ?? '';
    const region = resolveRegion(shopName);
    const defaultCurrency = region === 'RO' ? 'RON' : region === 'BG' ? 'BGN' : 'HUF';

    let zeroSalesDiagnosticCount = 0;
    const data = list.map((p) => {
      const v = p.validationStatus ?? (p.status === 1 ? 'active' : 'rejected');
      const validationStatusDisplay = v === 'rejected' || v === 'inactive' ? '已驳回' : '已通过';
      const displayName = p.name || (validationStatusDisplay === '已驳回' ? '待更新' : '待完善');
      const salePriceNum = Number(p.salePrice);
      const stockNum = p.stock;
      const isRejected = validationStatusDisplay === '已驳回';

      const skuKey = (p.mappedInventorySku ?? '').trim() || (p.sku ?? p.vendorSku ?? '').trim();
      const inv = skuKey ? inventoryMap.get(skuKey) : undefined;

      const platformImage = p.mainImage ?? p.imageUrl ?? null;
      const localImage = inv?.localImage ?? null;
      const finalImage = localImage || platformImage || null;

      const purchaseCost = inv?.purchaseCost ?? 0;
      const estShipping = inv?.weight != null && inv.weight > 0
        ? inv.weight * SHIPPING_PER_KG
        : DEFAULT_SHIPPING;
      const estimatedProfit = salePriceNum - (purchaseCost + estShipping);

      const currency = p.currency ?? defaultCurrency;

      const sales_stats = getSalesForProduct(salesMap, p.sku, p.vendorSku);
      if (sales_stats.d30 === 0 && skusWithSales.length > 0 && zeroSalesDiagnosticCount < 3) {
        logZeroSalesDiagnostic(p.sku, p.vendorSku, salesMap, skusWithSales);
        zeroSalesDiagnosticCount++;
      }

      const salesStatsObj = { d7: sales_stats.d7, d14: sales_stats.d14, d30: sales_stats.d30 };
      return {
        id: p.id,
        pnk: p.pnk,
        sku: p.sku ?? null,
        ean: p.ean ?? null,
        mapped_inventory_sku: p.mappedInventorySku ?? null,
        image: finalImage,
        main_image: finalImage,
        local_image: localImage,
        name: displayName,
        vendor_sku: p.vendorSku ?? null,
        emagOfferId: p.emagOfferId,
        sale_price: salePriceNum,
        sale_price_display: isRejected && salePriceNum === 0 ? '待更新' : salePriceNum,
        currency,
        stock: stockNum,
        stock_display: isRejected && stockNum === 0 ? '待更新' : stockNum,
        purchase_cost: purchaseCost || null,
        estimated_profit: Number(estimatedProfit.toFixed(2)),
        sales_stats: salesStatsObj,
        salesStats: salesStatsObj,
        validation_status: validationStatusDisplay,
        doc_errors: p.docErrors ?? null,
        rejection_reason: p.rejectionReason ?? null,
      };
    });

    const sampleWithSales = data.find((d) => (d.sales_stats?.d30 ?? 0) > 0);
    if (sampleWithSales) {
      console.log(`[StoreProducts] Sample product with sales: ${sampleWithSales.name} -> d7=${sampleWithSales.sales_stats?.d7}, d14=${sampleWithSales.sales_stats?.d14}, d30=${sampleWithSales.sales_stats?.d30}`);
    } else {
      console.log(`[StoreProducts] Sample product with sales: (none in this page, total ${data.length} products)`);
    }

    res.json({ code: 200, data, total, page, limit, message: 'success' });
  } catch (err) {
    console.error('[GET /api/store-products]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

export default router;
