import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth';
import {
  callAlibabaAPI,
  APP_KEY,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  persistToken,
  getValidAccessToken,
} from '../utils/alibaba';
import { createAlibabaOrder } from '../services/alibabaOrder';

const router = Router();
const prisma = new PrismaClient();

// CORS_ORIGIN 为 * 时无法作为重定向目标，使用默认值
const FRONTEND_URL = (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*')
  ? process.env.CORS_ORIGIN.split(',')[0].trim()
  : 'http://localhost:5173';

// ── OAuth 2.0 路由（无需 JWT 认证）──────────────────────────

/**
 * GET /api/alibaba/authorize
 * 构造 1688 授权 URL 并 302 重定向
 */
router.get('/authorize', (_req: Request, res: Response) => {
  const url = buildAuthorizeUrl();
  res.redirect(url);
});

/**
 * GET /api/alibaba/callback
 * 1688 授权回调：用 code 换取 token 并持久化，然后跳回前端
 */
router.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.redirect(`${FRONTEND_URL}?alibaba_auth=error&msg=${encodeURIComponent('缺少授权码')}`);
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    await persistToken(token);
    console.log('[1688 OAuth] 授权成功，memberId:', token.memberId, 'loginId:', token.resource_owner);

    const params = new URLSearchParams({
      alibaba_auth:  'success',
      login_id:      token.resource_owner ?? '',
    });
    res.redirect(`${FRONTEND_URL}?${params.toString()}`);
  } catch (err) {
    console.error('[1688 OAuth callback]', err);
    const msg = err instanceof Error ? err.message : '未知错误';
    res.redirect(`${FRONTEND_URL}?alibaba_auth=error&msg=${encodeURIComponent(msg)}`);
  }
});

// ── 以下路由需要系统 JWT 认证 ────────────────────────────────
router.use(authenticate);

// ── GET /api/alibaba/test-connection ─────────────────────────
router.get('/test-connection', async (_req: Request, res: Response) => {
  try {
    const apiPath = 'param2/1/system/currentTime';
    const result = await callAlibabaAPI<{ time: string }>(apiPath);

    if (result.success) {
      res.json({
        code: 200,
        data: { connected: true, serverTime: result.data, raw: result.raw },
        message: '1688 API 连通性测试成功！签名验证通过。',
      });
    } else {
      res.json({
        code: 200,
        data: {
          connected: false,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          raw: result.raw,
          debug: { apiPath, appKey: APP_KEY },
        },
        message: `1688 API 响应异常: ${result.errorMessage}`,
      });
    }
  } catch (err) {
    console.error('[GET /api/alibaba/test-connection]', err);
    res.status(500).json({ code: 500, data: null, message: '测试连接失败' });
  }
});

// ── GET /api/alibaba/auth-status ─────────────────────────────
router.get('/auth-status', async (_req: Request, res: Response) => {
  try {
    const auth = await prisma.alibabaAuth.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!auth) {
      res.json({ code: 200, data: { authorized: false }, message: '未授权' });
      return;
    }
    const now = new Date();
    const tokenExpired = now >= auth.expiresAt;
    const refreshExpired = auth.refreshTokenExpiresAt ? now >= auth.refreshTokenExpiresAt : false;

    let statusText = '授权有效';
    if (tokenExpired && refreshExpired) statusText = '授权已完全过期，请重新绑定';
    else if (tokenExpired) statusText = 'Token 已过期，将在下次调用时自动刷新';

    res.json({
      code: 200,
      data: {
        authorized:    !tokenExpired || !refreshExpired,
        loginId:       auth.loginId,
        memberId:      auth.memberId,
        aliId:         auth.aliId,
        expiresAt:     auth.expiresAt,
        refreshExpiresAt: auth.refreshTokenExpiresAt,
        tokenExpired,
        refreshExpired,
      },
      message: statusText,
    });
  } catch (err) {
    console.error('[GET /api/alibaba/auth-status]', err);
    res.status(500).json({ code: 500, data: null, message: '查询授权状态失败' });
  }
});

// ── POST /api/alibaba/refresh-token ──────────────────────────
router.post('/refresh-token', async (_req: Request, res: Response) => {
  try {
    const token = await getValidAccessToken();
    if (!token) {
      res.json({ code: 200, data: { refreshed: false }, message: 'Token 无法刷新，请重新授权' });
      return;
    }
    res.json({ code: 200, data: { refreshed: true }, message: 'Token 刷新成功' });
  } catch (err) {
    console.error('[POST /api/alibaba/refresh-token]', err);
    res.status(500).json({ code: 500, data: null, message: 'Token 刷新失败' });
  }
});

// ── GET /api/alibaba/addresses ───────────────────────────────
// 获取 1688 买家收货地址列表
router.get('/addresses', async (_req: Request, res: Response) => {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      res.status(401).json({ code: 401, data: null, message: '1688 授权已过期，请重新绑定账号' });
      return;
    }

    const result = await callAlibabaAPI<Record<string, unknown>>(
      'param2/1/com.alibaba.trade/alibaba.trade.receiveAddress.get',
      {},
      accessToken,
    );

    console.log('[addresses] API 响应:', result.success ? '成功' : `失败(${result.errorCode})`);

    if (!result.success) {
      console.error('[addresses] 1688 接口失败:', result.errorCode, result.errorMessage);
      res.json({ code: 200, data: [], message: `获取地址失败: ${result.errorMessage}` });
      return;
    }

    const raw = result.data as any;
    console.log('[addresses] 原始数据:', JSON.stringify(raw).slice(0, 1500));

    const nested = raw?.result ?? raw;
    const list: any[] = nested?.receiveAddressItems ?? nested?.addressList ?? nested?.data ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      res.json({ code: 200, data: [], message: '1688 地址列表为空' });
      return;
    }

    const DEFAULT_ID = process.env.ALIBABA_DEFAULT_ADDRESS_ID ?? '';

    const addresses = list.map((a: any) => {
      const id = String(a.id ?? a.addressId ?? '');
      const addrCodeText = a.addressCodeText ?? '';
      return {
        addressId:    id,
        fullName:     a.fullName ?? a.contactName ?? '',
        mobile:       a.mobilePhone ?? a.mobile ?? '',
        phone:        a.phone ?? a.telephone ?? '',
        provinceText: addrCodeText.split(/\s+/)[0] ?? '',
        cityText:     addrCodeText.split(/\s+/)[1] ?? '',
        areaText:     addrCodeText.split(/\s+/)[2] ?? '',
        townText:     a.townName ?? '',
        address:      a.address ?? '',
        postCode:     a.post ?? a.postCode ?? '',
        isDefault:    a.isDefault === true || a.isDefault === 'true' || id === DEFAULT_ID,
      };
    });

    console.log(`[addresses] 返回 ${addresses.length} 个地址`);
    res.json({ code: 200, data: addresses, message: 'success' });
  } catch (err) {
    console.error('[GET /api/alibaba/addresses]', err);
    res.status(500).json({ code: 500, data: null, message: '获取收货地址失败' });
  }
});

// ── POST /api/alibaba/parse-link ─────────────────────────────
// 解析 1688 商品链接 → 多策略获取真实规格
router.post('/parse-link', async (req: Request, res: Response) => {
  try {
    const { url } = req.body ?? {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ code: 400, data: null, message: '请提供有效的 1688 链接' });
      return;
    }

    const offerIdMatch = url.match(/offer\/(\d+)/i) || url.match(/id=(\d+)/i) || url.match(/(\d{10,})/);
    const offerId = offerIdMatch?.[1] ?? null;
    if (!offerId) {
      res.status(400).json({ code: 400, data: null, message: '无法从链接中解析出商品 ID，请确认链接格式' });
      return;
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      res.status(401).json({ code: 401, data: null, message: '1688 授权已过期，请在「系统设置 → 1688 配置」中重新绑定账号' });
      return;
    }

    // ── 策略 1: 官方 alibaba.product.get ──────────────────
    const productResult = await callAlibabaAPI<Record<string, unknown>>(
      'param2/1/com.alibaba.product/alibaba.product.get',
      { productID: offerId, webSite: '1688' },
      accessToken,
    );
    if (productResult.success && productResult.data) {
      const parsed = normalizeProductGetResponse(offerId, productResult.data);
      console.log(`[parse-link] 策略1(product.get)成功: ${parsed.title}, ${parsed.specs.length} 个规格`);
      res.json({ code: 200, data: parsed, message: 'success' });
      return;
    }

    // ── 策略 2: 从买家订单历史搜索 productID ─────────────
    console.log(`[parse-link] product.get 失败(${productResult.errorCode}), 回退到订单历史搜索...`);
    const orderResult = await searchProductFromOrders(offerId, accessToken);
    if (orderResult) {
      console.log(`[parse-link] 策略2(订单历史)成功: ${orderResult.title}, ${orderResult.specs.length} 个规格`);
      res.json({ code: 200, data: orderResult, message: 'success' });
      return;
    }

    // ── 全部失败 → 返回明确诊断信息 ──────────────────────
    const errCode = productResult.errorCode ?? 'UNKNOWN';
    console.error(`[parse-link] 全部策略失败: product.get=${productResult.errorCode}, 订单搜索=未匹配`);

    if (errCode === 'gw.APIACLDecline') {
      res.json({
        code: 200,
        data: null,
        message: `商品 #${offerId} 无法自动解析：\n` +
          '① product.get API 权限不足（ACL 拒绝）— 请到 1688 开放平台后台开通 com.alibaba.product 权限；\n' +
          '② 买家订单历史中未找到该商品 — 请先在 1688 下单购买过该商品。\n' +
          '您可以使用「手动添加规格」录入。',
      });
      return;
    }
    res.json({
      code: 200,
      data: null,
      message: `商品 #${offerId} 解析失败 [${errCode}]: ${productResult.errorMessage ?? '未知错误'}。可使用「手动添加规格」。`,
    });
  } catch (err) {
    console.error('[POST /api/alibaba/parse-link]', err);
    res.status(500).json({ code: 500, data: null, message: '解析链接失败' });
  }
});

// ── 标准化 alibaba.product.get 返回 ──────────────────────────
function normalizeProductGetResponse(offerId: string, raw: Record<string, unknown>) {
  const info = (raw as any).productInfo ?? raw;
  const title    = info.subject ?? info.title ?? `1688 商品 #${offerId}`;
  const imageUrl = info.image?.images?.[0] ?? info.mainImage ?? null;

  const specs: { specId: string; specName: string; price: number | null; imageUrl: string | null }[] = [];

  if (Array.isArray(info.skuInfos) && info.skuInfos.length > 0) {
    for (const sku of info.skuInfos) {
      const attrNames = Array.isArray(sku.attributes)
        ? sku.attributes.map((a: any) => a.attributeValue ?? a.value ?? '').join(' / ')
        : '';
      specs.push({
        specId:   String(sku.skuId ?? sku.specId),
        specName: attrNames || `SKU #${sku.skuId}`,
        price:    sku.price != null ? Number(sku.price) : null,
        imageUrl: sku.imageUrl ?? null,
      });
    }
  } else if (Array.isArray(info.skuProps)) {
    for (const prop of info.skuProps) {
      if (Array.isArray(prop.value)) {
        for (const v of prop.value) {
          specs.push({
            specId:   String(v.name ?? v.imageUrl ?? `${offerId}-${specs.length}`),
            specName: `${prop.prop ?? ''}: ${v.name ?? ''}`.trim(),
            price:    null,
            imageUrl: v.imageUrl ?? null,
          });
        }
      }
    }
  }

  if (specs.length === 0) {
    specs.push({ specId: offerId, specName: '默认规格（单SKU）', price: null, imageUrl: null });
  }

  return { offerId, title, imageUrl, specs };
}

// ── 从买家订单历史搜索商品规格 ───────────────────────────────
async function searchProductFromOrders(
  offerId: string,
  accessToken: string,
): Promise<{ offerId: string; title: string; imageUrl: string | null; specs: { specId: string; specName: string; price: number | null; imageUrl: string | null }[] } | null> {
  try {
    const apiPath = 'param2/1/com.alibaba.trade/alibaba.trade.getBuyerOrderList';
    const allSpecs = new Map<string, { specId: string; specName: string; price: number; imageUrl: string | null }>();
    let title = '';
    let imageUrl: string | null = null;
    let found = false;

    for (let page = 1; page <= 5; page++) {
      const result = await callAlibabaAPI<{ result?: unknown[] }>(
        apiPath,
        { page: String(page), pageSize: '50' },
        accessToken,
      );
      const orders = (result.data as any)?.result ?? (result.data as any) ?? [];
      if (!Array.isArray(orders) || orders.length === 0) break;

      for (const order of orders) {
        const items: any[] = order.productItems ?? [];
        for (const item of items) {
          const pid = String(item.productID);
          if (pid !== offerId) continue;
          found = true;

          if (!title) title = item.name ?? '';
          if (!imageUrl) {
            const imgs = item.productImgUrl;
            imageUrl = Array.isArray(imgs) ? (imgs[1] ?? imgs[0] ?? null) : null;
          }

          const specId = item.specId ?? String(item.skuID ?? '');
          if (specId && !allSpecs.has(specId)) {
            const skuAttrs: any[] = item.skuInfos ?? [];
            const specName = skuAttrs.map((s: any) => `${s.name}: ${s.value}`).join(' / ') || `SKU #${item.skuID}`;
            allSpecs.set(specId, {
              specId,
              specName,
              price: item.price != null ? Number(item.price) : 0,
              imageUrl: null,
            });
          }
        }
      }

      if (found && orders.length < 50) break;
    }

    if (!found) return null;

    const specs = [...allSpecs.values()];
    if (specs.length === 0) {
      specs.push({ specId: offerId, specName: '默认规格（单SKU）', price: 0, imageUrl: null });
    }

    return {
      offerId,
      title: title || `1688 商品 #${offerId}`,
      imageUrl,
      specs,
    };
  } catch (err) {
    console.error('[searchProductFromOrders]', err);
    return null;
  }
}

// ── POST /api/alibaba/create-order ───────────────────────────
// 将已关联 1688 的采购产品批量下单到 1688
router.post('/create-order', async (req: Request, res: Response) => {
  try {
    const { productIds, addressId } = req.body ?? {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供需要下单的产品 ID' });
      return;
    }

    const userId = req.user!.userId;
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds.map(Number) },
        ownerId: userId,
        externalProductId: { not: null },
      },
    });

    if (products.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '未找到已关联 1688 的产品' });
      return;
    }

    const notLinked = productIds.length - products.length;
    if (notLinked > 0) {
      console.log(`[create-order] ${notLinked} 个产品未关联 1688，跳过`);
    }

    const cargoItems = products.map((p) => ({
      offerId:  Number(p.externalProductId),
      specId:   p.externalSkuId ?? '',
      quantity: p.purchaseQuantity ?? 1,
    }));

    console.log(`[create-order] 向 1688 下单: ${cargoItems.length} 个商品, addressId=${addressId || '(默认)'}`, JSON.stringify(cargoItems));

    const result = await createAlibabaOrder(cargoItems, addressId ? String(addressId) : undefined);

    if (!result.success) {
      const errDetail = `[${result.errorCode}] ${result.errorMessage}`;
      console.error(`[create-order] ❌ 1688 下单失败: ${errDetail}`);
      if (result.raw) {
        console.error('[create-order] 1688 原始返回:', JSON.stringify(result.raw).slice(0, 2000));
      }
      res.json({
        code: 200,
        data: {
          success: false,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          rawError: typeof result.raw === 'object' ? JSON.stringify(result.raw).slice(0, 500) : undefined,
        },
        message: `1688 下单失败: ${result.errorMessage}`,
      });
      return;
    }

    const aliOrderId = result.data!.orderId;

    await prisma.product.updateMany({
      where: { id: { in: products.map((p) => p.id) } },
      data: { externalOrderId: aliOrderId, externalSynced: true },
    });

    console.log(`[create-order] 1688 下单成功, orderId=${aliOrderId}, 已更新 ${products.length} 个产品`);

    res.json({
      code: 200,
      data: {
        success: true,
        aliOrderId,
        totalAmount: result.data!.totalAmount,
        syncedCount: products.length,
      },
      message: `1688 下单成功！订单号: ${aliOrderId}`,
    });
  } catch (err) {
    console.error('[POST /api/alibaba/create-order]', err);
    res.status(500).json({ code: 500, data: null, message: '1688 下单接口异常' });
  }
});

// ── PUT /api/alibaba/bind ────────────────────────────────────
// 将系统 SKU 与 1688 规格绑定
router.put('/bind', async (req: Request, res: Response) => {
  try {
    const { productId, offerId, specId } = req.body ?? {};
    if (!productId || !offerId) {
      res.status(400).json({ code: 400, data: null, message: '缺少产品 ID 或 1688 商品 ID' });
      return;
    }
    const userId = req.user!.userId;
    const product = await prisma.product.findFirst({ where: { id: Number(productId), ownerId: userId } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }

    await prisma.product.update({
      where: { id: product.id },
      data: {
        externalProductId: String(offerId),
        externalSkuId: specId ? String(specId) : null,
      },
    });

    res.json({ code: 200, data: null, message: '1688 规格绑定成功' });
  } catch (err) {
    console.error('[PUT /api/alibaba/bind]', err);
    res.status(500).json({ code: 500, data: null, message: '绑定失败' });
  }
});

// ── PUT /api/alibaba/unbind ──────────────────────────────────
// 解除 1688 规格绑定
router.put('/unbind', async (req: Request, res: Response) => {
  try {
    const { productId } = req.body ?? {};
    if (!productId) {
      res.status(400).json({ code: 400, data: null, message: '缺少产品 ID' });
      return;
    }
    const userId = req.user!.userId;
    await prisma.product.updateMany({
      where: { id: Number(productId), ownerId: userId },
      data: { externalProductId: null, externalSkuId: null, externalSynced: false, externalOrderId: null },
    });
    res.json({ code: 200, data: null, message: '已解除 1688 绑定' });
  } catch (err) {
    console.error('[PUT /api/alibaba/unbind]', err);
    res.status(500).json({ code: 500, data: null, message: '解除绑定失败' });
  }
});

export default router;
