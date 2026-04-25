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
import { fetch1688OrderDetail, isFetch1688OrderError } from '../services/alibabaOrderSync';
import { get1688Item, normalizeOneboundSkus, type Onebound1688Response } from '../adapters/onebound.adapter';

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
// 解析 1688 商品链接 → 万邦 API 获取规格（已替代废弃的 1688 官方 product.get）
router.post('/parse-link', async (req: Request, res: Response) => {
  try {
    const { url } = req.body ?? {};
    if (!url || typeof url !== 'string') {
      res.status(400).json({ code: 400, data: null, message: '请提供有效的 1688 链接' });
      return;
    }

    const offerIdMatch = url.match(/offer\/(\d+)/i) || url.match(/id=(\d+)/i) || url.match(/(\d{10,})/);
    const numIid = offerIdMatch?.[1] ?? null;
    if (!numIid) {
      res.status(400).json({ code: 400, data: null, message: '无法从链接中解析出商品 ID，请确认链接格式' });
      return;
    }

    let resBody: Onebound1688Response;
    try {
      resBody = await get1688Item(numIid);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '万邦接口解析失败';
      console.error('[parse-link] 万邦 API 失败:', msg);
      res.status(500).json({
        code: 500,
        data: null,
        message: '万邦接口解析失败，请重试或检查链接。若持续失败，请确认 .env 中 ONEBOUND_API_KEY 与 ONEBOUND_API_SECRET 已正确配置。',
      });
      return;
    }

    const item = resBody?.item;
    if (!item) {
      res.status(500).json({
        code: 500,
        data: null,
        message: '万邦接口解析失败，请重试或检查链接',
      });
      return;
    }

    const rawSpecs = normalizeOneboundSkus(resBody);
    const title = String(item.title ?? `1688 商品 #${numIid}`);
    const imageUrl = item.pic_url ? String(item.pic_url) : null;

    const specs = rawSpecs.map((s) => ({
      skuId: s.skuId,
      specId: s.specId,
      specName: s.specName,
      price: s.price,
      stock: s.stock,
      imageUrl: null as string | null,
    }));

    if (specs.length === 0) {
      specs.push({
        skuId: numIid,
        specId: numIid,
        specName: '默认规格（单SKU）',
        price: Number(item.price) || 0,
        stock: Number(item.num) || 0,
        imageUrl: null,
      });
    }

    console.log(`[parse-link] 万邦解析成功: ${title}, ${specs.length} 个规格`);
    res.json({
      code: 200,
      data: { offerId: numIid, title, imageUrl, specs },
      message: 'success',
    });
  } catch (err) {
    console.error('[POST /api/alibaba/parse-link]', err);
    res.status(500).json({
      code: 500,
      data: null,
      message: '万邦接口解析失败，请重试或检查链接',
    });
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

// ── GET /api/alibaba/product-specs ───────────────────────────
// 根据 offerId 拉取 1688 商品规格列表，返回前端可直接渲染的扁平数组。
//
// 响应格式（严格扁平）:
//   { code: 200, data: [{ specId, skuId, attributes, price }] }
//
// 三级降级策略：
//   1. 万邦 item_get（无需 1688 授权，最快）
//   2. 1688 官方 alibaba.product.get
//   3. 历史买家订单反查
// ──────────────────────────────────────────────────────────────

/**
 * 解析万邦 properties_name 字段为人类可读的规格字符串。
 *
 * 万邦典型格式（分号分隔，每段 propId:valueId:propName:valueName）：
 *   "0:0:颜色:黑色;1:1:规格:(20*30)CM"
 *
 * 也可能是简化的 "propName:valueName" 对。
 *
 * 输出示例：
 *   "颜色:黑色; 规格:(20*30)CM"
 */
function parsePropertiesName(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const segments = raw.split(';').map((s) => s.trim()).filter(Boolean);

  const parts = segments.map((seg) => {
    const cols = seg.split(':');
    if (cols.length >= 4) {
      // propId:valueId:propName:valueName（标准万邦格式）
      // propName 在 index 2，valueName 在 index 3
      // 注意：valueName 本身可能含冒号，如 "(20*30)CM" 不含但要兜底
      const propName  = cols[2].trim();
      const valueName = cols.slice(3).join(':').trim();  // 兼容 valueName 含冒号
      if (propName) return `${propName}:${valueName}`;
    }
    if (cols.length === 2) {
      // 简化格式 propName:valueName
      return seg.trim();
    }
    // 兜底：原样保留
    return seg.trim();
  }).filter((s) => {
    // 过滤掉纯数字组成的无意义段（如 "0:0"）
    return !!s && !/^\d+:\d*$/.test(s);
  });

  return parts.join('; ');
}

/**
 * 从万邦规格数组提取扁平的 SpecItem 列表
 * 输出字段: specId / skuId / attributes / price
 */
function extractSpecsFromOnebound(
  rawBody: Onebound1688Response,
  offerId: string,
): Array<{ specId: string; skuId: string; attributes: string; price: number }> {
  const rawSpecs = normalizeOneboundSkus(rawBody);
  const item     = rawBody.item;

  if (rawSpecs.length > 0) {
    return rawSpecs.map((s) => ({
      specId:     s.specId,
      skuId:      s.skuId,
      attributes: parsePropertiesName(s.specName) || s.specName || '默认规格',
      price:      s.price,
    }));
  }

  // 无规格时：单 SKU 兜底（offerId 本身作为 specId）
  return [{
    specId:     offerId,
    skuId:      offerId,
    attributes: '默认规格（单SKU）',
    price:      Number(item?.price) || 0,
  }];
}

router.get('/product-specs', async (req: Request, res: Response) => {
  try {
    const offerId = String(req.query.offerId ?? '').trim();
    if (!offerId || !/^\d{5,}$/.test(offerId)) {
      res.status(400).json({
        code: 400, data: null,
        message: '请提供有效的 1688 offerId（纯数字，至少 5 位）',
      });
      return;
    }

    // ── 策略 1：万邦 API ──────────────────────────────────────
    try {
      const rawBody = await get1688Item(offerId);
      const specs   = extractSpecsFromOnebound(rawBody, offerId);

      console.log(
        `[product-specs] 万邦成功 offerId=${offerId} → ${specs.length} 条规格`,
        specs.length > 0 ? `示例: "${specs[0].attributes}"` : '',
      );

      res.json({ code: 200, data: specs, message: 'success' });
      return;
    } catch (e) {
      console.warn(`[product-specs] 万邦失败 offerId=${offerId}:`, e instanceof Error ? e.message : e);
    }

    // ── 策略 2：1688 官方 alibaba.product.get ────────────────
    const accessToken = await getValidAccessToken();
    if (accessToken) {
      try {
        const officialResult = await callAlibabaAPI<Record<string, unknown>>(
          'param2/1/com.alibaba.product/alibaba.product.get',
          { productID: offerId, webSite: '1688' },
          accessToken,
        );
        if (officialResult.success && officialResult.data) {
          const parsed = normalizeProductGetResponse(offerId, officialResult.data);
          const specs = parsed.specs.map((s) => ({
            specId:     s.specId,
            skuId:      s.specId,
            attributes: s.specName || '默认规格',
            price:      s.price ?? 0,
          }));
          console.log(`[product-specs] 官方 API 成功 offerId=${offerId} → ${specs.length} 条`);
          res.json({ code: 200, data: specs, message: 'success' });
          return;
        }
      } catch (e) {
        console.warn(`[product-specs] 官方 API 失败:`, e instanceof Error ? e.message : e);
      }

      // ── 策略 3：历史买家订单反查 ─────────────────────────────
      const fromOrders = await searchProductFromOrders(offerId, accessToken);
      if (fromOrders) {
        const specs = fromOrders.specs.map((s) => ({
          specId:     s.specId,
          skuId:      s.specId,
          attributes: s.specName || '默认规格',
          price:      s.price ?? 0,
        }));
        console.log(`[product-specs] 历史订单反查成功 offerId=${offerId} → ${specs.length} 条`);
        res.json({ code: 200, data: specs, message: 'success' });
        return;
      }
    }

    res.status(502).json({
      code: 502, data: null,
      message: `无法获取 offerId=${offerId} 的规格信息，万邦和 1688 官方接口均未返回有效数据`,
    });
  } catch (err) {
    console.error('[GET /api/alibaba/product-specs]', err);
    res.status(500).json({ code: 500, data: null, message: '获取规格列表失败' });
  }
});

// ── PATCH /api/alibaba/quick-map ─────────────────────────────
// 快捷单点更新产品的 specId（下单弹窗内直接选规格补全）
//
// Body: { productId: number, externalSkuId: string, externalSkuIdNum?: string }
// ──────────────────────────────────────────────────────────────
router.patch('/quick-map', async (req: Request, res: Response) => {
  try {
    const { productId, externalSkuId, externalSkuIdNum } = req.body ?? {};

    if (!productId || !externalSkuId || typeof externalSkuId !== 'string') {
      res.status(400).json({
        code: 400, data: null,
        message: '缺少 productId 或 externalSkuId（32位MD5 specId）',
      });
      return;
    }

    const cleanSpecId = String(externalSkuId).trim();
    if (!/^[a-fA-F0-9]{32}$/.test(cleanSpecId)) {
      res.status(400).json({
        code: 400, data: null,
        message: `externalSkuId 必须是 32 位十六进制 MD5 字符串，收到: "${cleanSpecId.slice(0, 20)}..." (len=${cleanSpecId.length})`,
      });
      return;
    }

    const product = await prisma.product.findUnique({
      where:  { id: Number(productId) },
      select: { id: true, sku: true, externalProductId: true, externalSkuId: true },
    });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: {
        externalSkuId:    cleanSpecId,
        externalSkuIdNum: externalSkuIdNum ? String(externalSkuIdNum).trim() : undefined,
        externalSynced:   true,   // 规格重新绑定后恢复有效状态，解除换链死锁
      },
      select: {
        id: true, sku: true,
        externalProductId: true, externalSkuId: true, externalSkuIdNum: true,
        externalSynced: true,     // 返回最新状态供前端刷新徽章
      },
    });

    console.log(
      `[quick-map] 产品 #${product.id}(${product.sku}) specId 更新：` +
      `${product.externalSkuId?.slice(0, 8) ?? 'null'} → ${cleanSpecId.slice(0, 8)}...`,
    );

    res.json({
      code: 200,
      data: updated,
      message: `规格映射已更新 (specId: ${cleanSpecId.slice(0, 8)}...)`,
    });
  } catch (err) {
    console.error('[PATCH /api/alibaba/quick-map]', err);
    res.status(500).json({ code: 500, data: null, message: '更新规格映射失败' });
  }
});

// ── POST /api/alibaba/create-order ───────────────────────────
// 将已关联 1688 的采购产品批量下单到 1688（按 offerId 分组拆单，禁止跨店混单）
// ★ 正确时序：先确保有 PurchaseOrder + PurchaseOrderItem，再调 1688，最后用 orderId 精准 update 子单
router.post('/create-order', async (req: Request, res: Response) => {
  try {
    const { productIds, addressId } = req.body ?? {};
    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供需要下单的产品 ID' });
      return;
    }

    const userId = req.user!.userId;
    const username = req.user!.username ?? 'unknown';
    const products = await prisma.product.findMany({
      where: {
        id: { in: productIds.map((id) => Number(id)).filter((n) => !isNaN(n)) },
        ownerId: userId,
        externalProductId: { not: null },
      },
    });

    const SPEC_ID_REGEX = /^[a-fA-F0-9]{32}$/;
    const validProducts = products.filter((p) => {
      const offerId = p.externalProductId?.trim();
      const specId = p.externalSkuId?.trim();
      return !!offerId && !!specId && SPEC_ID_REGEX.test(specId);
    });

    if (validProducts.length === 0) {
      res.status(400).json({
        code: 400,
        data: null,
        message: '未找到有效的 1688 关联产品。请确保每个产品已绑定 1688 商品 ID 和 32 位 MD5 规格 ID（specId）。',
      });
      return;
    }

    const cargoItems = validProducts.map((p) => ({
      offerId: String(p.externalProductId ?? '').trim(),
      specId: String(p.externalSkuId ?? '').trim(),
      quantity: Math.max(1, Number(p.purchaseQuantity) || 1),
      productId: p.id,
    }));

    const byOfferId = new Map<string, typeof cargoItems>();
    for (const item of cargoItems) {
      const list = byOfferId.get(item.offerId) ?? [];
      list.push(item);
      byOfferId.set(item.offerId, list);
    }

    // ★ 步骤 1：确保有 PurchaseOrder，若无则创建并绑定产品
    let purchaseOrderId = validProducts.find((p) => p.purchaseOrderId != null)?.purchaseOrderId ?? null;
    if (!purchaseOrderId) {
      const totalAmount = validProducts.reduce(
        (s, p) => s + (Number(p.purchasePrice) || 0) * (p.purchaseQuantity || 1),
        0,
      );
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const prefix = `${username}-${dateStr}-`;
      const todayCount = await prisma.purchaseOrder.count({ where: { orderNo: { startsWith: prefix } } });
      const orderNo = `${prefix}${String(todayCount + 1).padStart(3, '0')}`;

      const created = await prisma.purchaseOrder.create({
        data: {
          orderNo,
          operator: username,
          totalAmount: totalAmount,
          itemCount: validProducts.length,
          status: 'PLACED',
        },
      });
      purchaseOrderId = created.id;
      await prisma.product.updateMany({
        where: { id: { in: validProducts.map((p) => p.id) } },
        data: { status: 'ORDERED', purchaseOrderId },
      });
    }

    // ★ 步骤 2：为每个 offerId 组预先创建 PurchaseOrderItem，拿到真实 id（解决 purchaseOrderItemId 为 null 的断层）
    const offerIdToItemId = new Map<string, number>();
    for (const [offerId, group] of byOfferId) {
      const existing = await prisma.purchaseOrderItem.findFirst({ where: { purchaseOrderId, offerId } });
      if (existing) {
        offerIdToItemId.set(offerId, existing.id);
      } else {
        const created = await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId,
            offerId,
            quantity: group.reduce((s, g) => s + g.quantity, 0),
            productIds: JSON.stringify(group.map((g) => g.productId)),
          },
        });
        offerIdToItemId.set(offerId, created.id);
      }
    }

    // ★ 步骤 3：调用 1688 下单，拿到 orderId 后精准 update 子单
    const addressIdStr = addressId ? String(addressId) : undefined;
    const results: { orderId: string; totalAmount: number; productIds: number[] }[] = [];
    const debug1688Res: unknown[] = [];
    const debugDbUpdate: unknown[] = [];

    for (const [offerId, group] of byOfferId) {
      const payload = group.map((item) => ({
        offerId: item.offerId,
        specId: item.specId,
        quantity: item.quantity,
      }));

      const result = await createAlibabaOrder(payload, addressIdStr);

      if (!result.success) {
        res.json({
          code: 200,
          data: { success: false, errorCode: result.errorCode, errorMessage: result.errorMessage, raw_1688_response: result.raw },
          message: `1688 下单失败: ${result.errorMessage}`,
          debug_payload: result.debugPayload ?? null,
          debug_1688_res: result.raw,
        });
        return;
      }

      debug1688Res.push({ offerId, raw: result.raw ?? result });

      const aliOrderId = result.data!.orderId;
      const aliTotalAmount = result.data!.totalAmount;
      const groupProductIds = group.map((g) => g.productId);
      results.push({ orderId: aliOrderId, totalAmount: aliTotalAmount, productIds: groupProductIds });

      await prisma.product.updateMany({
        where: { id: { in: groupProductIds } },
        data: { externalOrderId: aliOrderId, externalSynced: true },
      });

      const itemId = offerIdToItemId.get(offerId)!;
      await prisma.purchaseOrderItem.update({
        where: { id: itemId },
        data: {
          alibabaOrderId: aliOrderId,
          alibabaOrderStatus: 'waitbuyerpay',
          alibabaTotalAmount: aliTotalAmount > 0 ? aliTotalAmount : undefined,
          productIds: JSON.stringify(groupProductIds),
        },
      });

      debugDbUpdate.push({
        offerId,
        purchaseOrderId,
        purchaseOrderItemId: itemId,
        alibabaOrderId: aliOrderId,
        groupProductIds,
      });
    }

    const totalSynced = results.reduce((s, r) => s + r.productIds.length, 0);
    const orderIds = results.map((r) => r.orderId).join(', ');

    res.json({
      code: 200,
      data: {
        success: true,
        aliOrderId: results.length === 1 ? results[0].orderId : undefined,
        aliOrderIds: results.map((r) => r.orderId),
        totalAmount: results.reduce((s, r) => s + r.totalAmount, 0),
        syncedCount: totalSynced,
        orderCount: results.length,
      },
      message: results.length === 1
        ? `1688 下单成功！订单号: ${orderIds}`
        : `1688 下单成功！共 ${results.length} 个订单: ${orderIds}`,
      debug_1688_res: debug1688Res,
      debug_db_update: debugDbUpdate,
    });
  } catch (err) {
    res.status(500).json({ code: 500, data: null, message: '1688 下单接口异常' });
  }
});

// ── PUT /api/alibaba/bind ────────────────────────────────────
// 将系统 SKU 与 1688 规格绑定。★ specId（32位 MD5）必传，否则下单会失败！
const SPEC_ID_REGEX_BIND = /^[a-fA-F0-9]{32}$/;
router.put('/bind', async (req: Request, res: Response) => {
  try {
    const { productId, offerId, specId, skuId } = req.body ?? {};

    console.log('[PUT /api/alibaba/bind] 收到 payload:', JSON.stringify({ productId, offerId, specId: specId ? `${String(specId).slice(0, 8)}...` : undefined, skuId }));

    const pidNum = Number(productId);
    if (!Number.isFinite(pidNum) || pidNum <= 0) {
      res.status(400).json({
        code: 400, data: null,
        message:
          '缺少有效的 productId（须为正整数）。请从采购单列表/详情 items[].productId 读取，勿使用子单行 id（PurchaseOrderItem.id）。',
      });
      return;
    }
    if (!offerId) {
      res.status(400).json({ code: 400, data: null, message: '缺少 1688 商品 ID（offerId）' });
      return;
    }
    if (!specId || typeof specId !== 'string') {
      res.status(400).json({
        code: 400,
        data: null,
        message: '缺少 specId（32 位 MD5 规格哈希）。解析接口返回的 specs 中每个规格都有 specId，请确保前端在确认绑定时将选中的 spec.specId 一并传给本接口。',
      });
      return;
    }
    const finalSpecId = String(specId).trim();
    if (!SPEC_ID_REGEX_BIND.test(finalSpecId)) {
      res.status(400).json({
        code: 400,
        data: null,
        message: `specId 必须是 32 位十六进制字符串（MD5 格式），当前收到: ${finalSpecId.slice(0, 20)}... 长度=${finalSpecId.length}。请检查解析接口返回的 specId 是否正确传递。`,
      });
      return;
    }

    const product = await prisma.product.findUnique({ where: { id: pidNum } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: `产品不存在（productId=${pidNum}）` });
      return;
    }

    const finalSkuIdNum = skuId != null ? String(skuId).trim() : null;

    await prisma.product.update({
      where: { id: product.id },
      data: {
        externalProductId: String(offerId),
        externalSkuId:     finalSpecId,
        externalSkuIdNum:  finalSkuIdNum || null,
        externalSynced:    true,   // offerId+specId 同时写入，映射完整，解除换链死锁
      },
    });

    console.log(`[PUT /api/alibaba/bind] 绑定成功 productId=${productId} externalSkuId=${finalSpecId.slice(0, 8)}...`);
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

// ── POST /api/alibaba/sync-1688-order ────────────────────────
// 拉取 1688 子单详情，更新 PurchaseOrderItem 的金额、运费、状态
// 参数组合（三选一）：
//   { alibabaOrderId }       ← 直接传 1688 订单号（=PurchaseOrderItem.alibabaOrderId）
//   { externalOrderId }      ← Product 表字段名，与 alibabaOrderId 等价
//   { purchaseOrderItemId }  ← PurchaseOrderItem 主键（同时传 externalOrderId 更佳）
router.post('/sync-1688-order', async (req: Request, res: Response) => {
  try {
    const {
      alibabaOrderId: reqAliId,
      externalOrderId: reqExtId,
      purchaseOrderItemId,
    } = req.body ?? {};

    // externalOrderId / alibabaOrderId 是同一个 1688 订单号，统一为 resolvedAliId
    const resolvedAliId: string | null = (reqAliId ?? reqExtId ?? null)
      ? String(reqAliId ?? reqExtId)
      : null;

    // ── 第一步：定位 PurchaseOrderItem ────────────────────────
    let item: {
      id: number;
      alibabaOrderId: string | null;
      alibabaOrderStatus: string | null;
      alibabaTotalAmount: unknown;
      shippingFee: unknown;
    } | null = null;

    if (purchaseOrderItemId) {
      item = await prisma.purchaseOrderItem.findUnique({
        where: { id: Number(purchaseOrderItemId) },
        select: { id: true, alibabaOrderId: true, alibabaOrderStatus: true, alibabaTotalAmount: true, shippingFee: true },
      });
    }

    if (!item && resolvedAliId) {
      item = await prisma.purchaseOrderItem.findFirst({
        where: { alibabaOrderId: resolvedAliId },
        select: { id: true, alibabaOrderId: true, alibabaOrderStatus: true, alibabaTotalAmount: true, shippingFee: true },
      });
    }

    if (!item) {
      res.json({
        code: 400, data: null, success: false,
        message: '未找到对应的 1688 子单记录，请确认参数是否正确',
        debug: { purchaseOrderItemId, resolvedAliId },
      });
      return;
    }

    // ── 第二步：确定实际使用的 1688 订单号 ───────────────────
    // 优先使用数据库已存值；若为空则用请求体传来的 externalOrderId/alibabaOrderId 作为补救
    const finalAliOrderId: string | null = item.alibabaOrderId ?? resolvedAliId;

    if (!finalAliOrderId) {
      res.json({
        code: 400, data: null, success: false,
        message: '该子单尚未关联 1688 订单号，请先在 1688 完成下单后再同步',
      });
      return;
    }

    // 若数据库 alibabaOrderId 之前为空，顺手补写
    if (!item.alibabaOrderId && finalAliOrderId) {
      await prisma.purchaseOrderItem.update({
        where: { id: item.id },
        data: { alibabaOrderId: finalAliOrderId },
      });
    }

    // ── 第三步：调用共享函数获取 1688 订单详情（必须走 res.result.baseInfo）────────────────
    const detail = await fetch1688OrderDetail(finalAliOrderId);

    if (isFetch1688OrderError(detail)) {
      res.json({
        code: 200, data: null, success: false,
        message: detail.message,
        debug: { errorCode: detail.errorCode, raw: detail.raw },
      });
      return;
    }

    const { status: alibabaOrderStatus, totalAmount: alibabaTotalAmount, shippingFee } = detail;

    // ── 第四步：强制更新 PurchaseOrderItem（金额与运费必须写入）────────────────
    await prisma.purchaseOrderItem.update({
      where: { id: item.id },
      data: {
        alibabaOrderId: finalAliOrderId,
        alibabaOrderStatus,
        alibabaTotalAmount: Number(alibabaTotalAmount),
        shippingFee: Number(shippingFee),
      },
    });

    // ★ 统一使用 externalOrderId 作为前端主字段名
    res.json({
      code: 200,
      success: true,
      data: {
        purchaseOrderItemId: item.id,
        externalOrderId:     finalAliOrderId,
        alibabaOrderId:      finalAliOrderId,
        alibabaOrderStatus,
        alibabaTotalAmount,
        shippingFee,
        debug_raw_price:     detail.debug_raw_price,
      },
      message: '1688 子单详情已同步',
    });
  } catch (err) {
    console.error('[POST /api/alibaba/sync-1688-order]', err);
    res.json({
      code: 200, data: null, success: false,
      message: `同步异常: ${err instanceof Error ? err.message : '未知错误'}`,
    });
  }
});

// ── GET /api/alibaba/1688-logistics ──────────────────────────
// 获取 1688 订单的物流信息与轨迹
router.get('/1688-logistics', async (req: Request, res: Response) => {
  try {
    const alibabaOrderId = String(req.query.alibabaOrderId ?? '').trim();
    if (!alibabaOrderId) {
      res.status(400).json({ code: 400, data: null, message: '缺少 alibabaOrderId 参数' });
      return;
    }

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      res.status(401).json({ code: 401, data: null, message: '1688 授权已过期，请重新绑定账号' });
      return;
    }

    // ① 获取物流基本信息（公司 + 单号）
    const logisticApiPath = 'param2/1/com.alibaba.logistics/alibaba.logistics.OpQueryLogisticOrderInfo';
    const logisticResult = await callAlibabaAPI<Record<string, unknown>>(
      logisticApiPath,
      { bizOrderId: alibabaOrderId, webSite: '1688' },
      accessToken,
    );

    // ② 获取物流轨迹
    const trackApiPath = 'param2/1/com.alibaba.logistics/alibaba.logistics.OpQueryLogisticOrderTraceInfo';
    const trackResult = await callAlibabaAPI<Record<string, unknown>>(
      trackApiPath,
      { bizOrderId: alibabaOrderId, webSite: '1688' },
      accessToken,
    );

    const isRateLimit = (r: typeof logisticResult) =>
      r.errorCode === 'rate-limit-exceeded' || String(r.errorCode).includes('limit');

    if (!logisticResult.success && isRateLimit(logisticResult)) {
      res.json({ code: 200, data: null, message: '1688 接口限流，请稍后重试（每分钟调用次数已达上限）' });
      return;
    }

    // 解析物流基本信息
    const logisticRaw = (logisticResult.raw as any) ?? {};
    const logisticList: any[] = logisticRaw?.result ?? logisticRaw?.logisticsOrderInfoList ?? [];
    const firstLogistic = Array.isArray(logisticList) ? logisticList[0] : logisticList;
    const logisticsCompany: string = String(
      firstLogistic?.logisticsCompanyName ?? firstLogistic?.cpCode ?? firstLogistic?.companyName ?? ''
    );
    const logisticsNo: string = String(
      firstLogistic?.mailNo ?? firstLogistic?.logisticsNo ?? firstLogistic?.waybillCode ?? ''
    );

    // 持久化物流信息到 PurchaseOrderItem（通过 alibabaOrderId 精准找到子单）
    if (logisticsCompany || logisticsNo) {
      await prisma.purchaseOrderItem.updateMany({
        where: { alibabaOrderId },
        data: {
          logisticsCompany: logisticsCompany || undefined,
          logisticsNo: logisticsNo || undefined,
        },
      });
      console.log(`[1688-logistics] 已落库 alibabaOrderId=${alibabaOrderId} 物流公司=${logisticsCompany} 单号=${logisticsNo}`);
    }

    // 解析物流轨迹
    const trackRaw = (trackResult.raw as any) ?? {};
    const traceList: any[] = trackRaw?.result ?? trackRaw?.traceList ?? trackRaw?.traces ?? [];
    const traces = (Array.isArray(traceList) ? traceList : []).map((t: any) => ({
      time: t.acceptTime ?? t.time ?? t.actionTime ?? '',
      description: t.acceptAddress ?? t.remark ?? t.action ?? t.description ?? '',
      location: t.acceptAddress ?? t.location ?? '',
    })).filter((t) => t.time || t.description);

    res.json({
      code: 200,
      data: {
        alibabaOrderId,
        logisticsCompany,
        logisticsNo,
        traces,
        rawLogistic: firstLogistic ?? null,
      },
      message: traces.length > 0 ? '获取物流轨迹成功' : '暂无物流轨迹信息（可能尚未发货）',
    });
  } catch (err) {
    console.error('[GET /api/alibaba/1688-logistics]', err);
    res.status(500).json({ code: 500, data: null, message: '获取物流信息异常，请稍后重试' });
  }
});

export default router;
