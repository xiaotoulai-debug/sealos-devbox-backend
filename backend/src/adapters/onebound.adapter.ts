/**
 * 万邦 1688 API Adapter
 * 用于解析 1688 商品链接获取规格信息，替代废弃的 1688 官方 product.get 解析逻辑
 * 文档: https://open.onebound.cn/help/api/1688.item_get.html
 */

const ONEBOUND_BASE = 'https://api-gw.onebound.cn/1688/item_get';

export interface Onebound1688Sku {
  sku_id?: string;
  spec_id?: string;
  specId?: string;
  properties_name?: string;
  price?: string | number;
  quantity?: string | number;
  [key: string]: unknown;
}

export interface Onebound1688Item {
  num_iid?: string;
  title?: string;
  pic_url?: string;
  skus?: { sku?: Onebound1688Sku[] };
  [key: string]: unknown;
}

export interface Onebound1688Response {
  item?: Onebound1688Item;
  error?: string;
  [key: string]: unknown;
}

export interface Parsed1688Spec {
  skuId: string;
  specId: string;
  specName: string;
  price: number;
  stock: number;
}

/**
 * 调用万邦 1688 item_get 接口获取商品详情
 * @param numIid 1688 商品 ID（如从链接 offer/610947572360 提取）
 * @returns 原始响应，失败时抛出或返回带 error 的对象
 */
export async function get1688Item(numIid: string): Promise<Onebound1688Response> {
  const key = process.env.ONEBOUND_API_KEY?.trim();
  const secret = process.env.ONEBOUND_API_SECRET?.trim();

  if (!key || !secret) {
    throw new Error('ONEBOUND_API_KEY 或 ONEBOUND_API_SECRET 未配置，请在 .env 中填入');
  }

  const url = new URL(ONEBOUND_BASE);
  url.searchParams.set('key', key);
  url.searchParams.set('secret', secret);
  url.searchParams.set('num_iid', numIid);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`万邦 API HTTP ${res.status}: ${res.statusText}`);
    }

    const body = (await res.json()) as Onebound1688Response;
    if (body?.error) {
      throw new Error(String(body.error));
    }
    return body;
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error) {
      if (e.name === 'AbortError') throw new Error('万邦接口请求超时');
      throw e;
    }
    throw new Error('万邦接口解析失败');
  }
}

/** 32 位 MD5 哈希正则，用于从万邦错放字段中找回真实 specId */
const SPEC_ID_REGEX = /^[a-fA-F0-9]{32}$/;

/**
 * 从对象中递归/遍历所有值，找到第一个匹配 32 位 MD5 的字符串
 * 万邦 API 已知坑：specId 常被错放在 quantity、sku_id 等字段中
 */
function extractSpecIdFromObject(obj: unknown): string {
  if (obj == null) return '';
  if (typeof obj === 'string' && SPEC_ID_REGEX.test(obj)) return obj;
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const found = extractSpecIdFromObject(v);
      if (found) return found;
    }
  }
  return '';
}

/**
 * 从万邦 item_get 响应中提纯规格数组，供前端 1688 规格关联弹窗使用
 * 绝不返回原始 JSON，仅输出清晰结构
 * ★ specId 强制从 raw 中正则提取 32 位 MD5，万邦常错放字段
 */
export function normalizeOneboundSkus(res: Onebound1688Response): Parsed1688Spec[] {
  const item = res?.item;
  if (!item) return [];

  const skuList = Array.isArray(item.skus?.sku)
    ? item.skus.sku
    : Array.isArray(item.skus)
      ? item.skus
      : [];
  if (skuList.length === 0) {
    return [];
  }

  return skuList.map((rawSkuItem, idx) => {
    if (idx === 0) {
      console.log('\n\n👀👀👀 === 万邦原始 SKU 数据样本 === 👀👀👀');
      console.log(JSON.stringify(rawSkuItem, null, 2));
      console.log('👀👀👀 ============================== 👀👀👀\n\n');
    }
    console.log(`=== WANBANG RAW SKU ITEM [${idx}] ===`, JSON.stringify(rawSkuItem, null, 2));

    const skuId = String(rawSkuItem.sku_id ?? '');
    // 1. 优先取显式 spec_id/specId
    let specId = String(rawSkuItem.spec_id ?? rawSkuItem.specId ?? '').trim();
    // 2. 若非 32 位哈希，则遍历当前 sku 所有值，用正则找回
    if (!SPEC_ID_REGEX.test(specId)) {
      specId = extractSpecIdFromObject(rawSkuItem);
    }
    if (!specId) {
      console.warn(`[Onebound] SKU[${idx}] sku_id=${skuId} 未找到 32 位 specId，将无法下单`);
    }

    return {
      skuId,
      specId,
      specName: String(rawSkuItem.properties_name ?? ''),
      price: Number(rawSkuItem.price) || 0,
      stock: Number(rawSkuItem.quantity) || 0,
    };
  });
}
