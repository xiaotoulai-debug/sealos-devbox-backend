import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { encrypt, decrypt, maskSecret } from '../utils/shopCrypto';
import { getEmagCredentials, verifyConnection } from '../services/emagClient';
import { syncStoreProducts } from '../services/storeProductSync';

const router = Router();
router.use(authenticate);

const FULLY_MANAGED_PLATFORMS = ['shein', 'temu'];

function resolveBusinessModel(platform: string, explicit?: string): string {
  if (explicit && ['TRADITIONAL', 'FULLY_MANAGED'].includes(explicit)) return explicit;
  return FULLY_MANAGED_PLATFORMS.includes(platform.toLowerCase()) ? 'FULLY_MANAGED' : 'TRADITIONAL';
}

// GET /api/shops
router.get('/', async (_req: Request, res: Response) => {
  try {
    const shops = await prisma.shopAuthorization.findMany({ orderBy: { createdAt: 'desc' } });
    const safe = shops.map((s) => ({
      ...s,
      apiKey: maskSecret(decrypt(s.apiKey)),
      apiSecret: '********',
      accessToken: s.accessToken ? maskSecret(decrypt(s.accessToken)) : null,
      refreshToken: s.refreshToken ? '********' : null,
    }));
    res.json({ code: 200, data: safe, message: 'success' });
  } catch (err) {
    console.error('[GET /api/shops]', err);
    res.status(500).json({ code: 500, data: null, message: '获取店铺列表失败' });
  }
});

// POST /api/shops
router.post('/', async (req: Request, res: Response) => {
  try {
    const { platform, shopName, apiKey, apiSecret, accessToken, refreshToken, supplierId, expiresAt, isSandbox, businessModel } = req.body;
    if (!platform || !shopName) {
      res.status(400).json({ code: 400, data: null, message: '平台和店铺名为必填项' });
      return;
    }
    const bm = resolveBusinessModel(platform, businessModel);
    const needKey = apiKey || '';
    const needSecret = apiSecret || '-';

    const shop = await prisma.shopAuthorization.create({
      data: {
        platform,
        shopName,
        businessModel: bm,
        apiKey: encrypt(needKey),
        apiSecret: encrypt(needSecret),
        accessToken: accessToken ? encrypt(accessToken) : null,
        refreshToken: refreshToken ? encrypt(refreshToken) : null,
        supplierId: supplierId || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        isSandbox: !!isSandbox,
        status: 'active',
        createdBy: req.user!.userId,
      },
    });
    res.json({ code: 200, data: { id: shop.id, businessModel: bm }, message: '店铺授权创建成功' });
  } catch (err) {
    console.error('[POST /api/shops]', err);
    res.status(500).json({ code: 500, data: null, message: '创建失败' });
  }
});

// PATCH /api/shops/:id
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { shopName, apiKey, apiSecret, accessToken, refreshToken, supplierId, expiresAt, isSandbox, status, businessModel } = req.body;
    const data: Record<string, unknown> = {};
    if (shopName !== undefined) data.shopName = shopName;
    if (apiKey !== undefined) data.apiKey = encrypt(apiKey);
    if (apiSecret !== undefined) data.apiSecret = encrypt(apiSecret);
    if (accessToken !== undefined) data.accessToken = accessToken ? encrypt(accessToken) : null;
    if (refreshToken !== undefined) data.refreshToken = refreshToken ? encrypt(refreshToken) : null;
    if (supplierId !== undefined) data.supplierId = supplierId || null;
    if (expiresAt !== undefined) data.expiresAt = expiresAt ? new Date(expiresAt) : null;
    if (isSandbox !== undefined) data.isSandbox = !!isSandbox;
    if (status !== undefined) data.status = status;
    if (businessModel !== undefined) data.businessModel = businessModel;

    await prisma.shopAuthorization.update({ where: { id }, data: data as any });
    res.json({ code: 200, data: null, message: '更新成功' });
  } catch (err) {
    console.error('[PATCH /api/shops/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '更新失败' });
  }
});

// DELETE /api/shops/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await prisma.shopAuthorization.delete({ where: { id } });
    res.json({ code: 200, data: null, message: '已删除' });
  } catch (err) {
    console.error('[DELETE /api/shops/:id]', err);
    res.status(500).json({ code: 500, data: null, message: '删除失败' });
  }
});

// POST /api/shops/:id/sync-products — 店铺初始化同步：从 eMAG product_offer/read 拉取在售产品到 StoreProduct
router.post('/:id/sync-products', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const shop = await prisma.shopAuthorization.findUnique({ where: { id } });
    if (!shop) { res.status(404).json({ code: 404, data: null, message: '店铺不存在' }); return; }
    if (shop.platform.toLowerCase() !== 'emag') {
      res.status(400).json({ code: 400, data: null, message: '仅支持 eMAG 店铺的产品同步' });
      return;
    }

    const creds = await getEmagCredentials(id);
    const result = await syncStoreProducts(creds);
    res.json({
      code: 200,
      data: {
        shopId: result.shopId,
        totalFetched: result.totalFetched,
        upserted: result.upserted,
        errors: result.errors,
        rejectedCount: result.rejectedCount,
        rejectedReasons: result.rejectedReasons,
        rejectedSample: result.rejectedSample,
      },
      message: `已同步 ${result.upserted} 个产品${result.rejectedCount ? `，其中 ${result.rejectedCount} 个已驳回` : ''}${result.errors.length ? `，${result.errors.length} 条错误` : ''}`,
    });
  } catch (err: any) {
    console.error('[POST /api/shops/:id/sync-products]', err.message);
    res.status(500).json({ code: 500, data: null, message: err.message });
  }
});

// POST /api/shops/:id/verify
router.post('/:id/verify', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const shop = await prisma.shopAuthorization.findUnique({ where: { id } });
    if (!shop) { res.status(404).json({ code: 404, data: null, message: '店铺不存在' }); return; }

    const apiKey = decrypt(shop.apiKey);
    const platform = shop.platform.toLowerCase();
    let verified = false;
    let detail = '';

    if (platform === 'emag') {
      try {
        const creds = await getEmagCredentials(id);
        const result = await verifyConnection(creds);
        verified = result.verified;
        detail = result.detail;
      } catch (e: any) {
        detail = `eMAG 连接失败: ${e.message?.slice(0, 400)}`;
      }
    } else if (platform === 'shein') {
      detail = 'Shein 全托管平台 — 凭证已保存。Gegehu/尊豪系统对接需线下确认供应商 ID 后生效。订单将走「备货单→备货仓」流程。';
      verified = !!(shop.supplierId && apiKey);
    } else if (platform === 'temu') {
      detail = 'Temu 全托管平台 — 凭证已保存。请确认 Supplier ID 和 Access Token 正确，订单将走「备货单→备货仓」流程。';
      verified = !!(shop.supplierId && shop.accessToken);
    } else if (platform === 'amazon') {
      detail = 'Amazon 平台验证逻辑开发中，请确保凭证正确后手动验证';
    } else if (platform === 'aliexpress') {
      detail = 'AliExpress 平台验证逻辑开发中';
    } else {
      detail = `暂不支持 ${shop.platform} 平台的自动验证`;
    }

    if (verified) {
      await prisma.shopAuthorization.update({ where: { id }, data: { status: 'active' } });
    }

    res.json({ code: 200, data: { verified, detail }, message: verified ? '验证通过' : '验证未通过' });
  } catch (err) {
    console.error('[POST /api/shops/:id/verify]', err);
    res.status(500).json({ code: 500, data: null, message: '验证请求失败' });
  }
});

export default router;
