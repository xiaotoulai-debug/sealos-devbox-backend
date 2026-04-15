import { EmagCredentials, emagApiCall, EmagApiResponse } from './emagClient';

// ─── eMAG 产品发布服务 (API v4.5.0) ──────────────────────────────
//
// 接口: product_offer/save
//
// 两种发布模式:
//   1. Draft (草稿模式)  — 仅创建 offer 骨架, 需后续补充完整信息
//   2. Full Product      — 完整产品信息一步到位发布
//
// 限流: 3 req/sec (非订单路由)

export interface EmagProductOffer {
  id?: number;
  part_number: string;               // SKU / Part Number (唯一标识)
  name: string;                      // 产品名称
  brand?: string;
  category_id: number;               // eMAG 类目 ID
  description?: string;              // HTML 描述
  sale_price: number;                // 含税销售价
  recommended_price?: number;
  min_sale_price?: number;
  max_sale_price?: number;
  currency_type?: string;            // RON / EUR(BG) / HUF
  vat_id?: number;                   // 税率 ID (19% → vat_id=1 for RO)
  status?: number;                   // 1=Active
  stock?: Array<{
    warehouse_id: number;
    value: number;                   // 库存数量
  }>;
  handling_time?: {
    value: number;                   // 备货天数
    warehouse_id: number;
  }[];
  images?: Array<{
    display_type: number;            // 1=主图
    url: string;
  }>;
  characteristics?: Array<{
    id: number;
    value: string;
  }>;
  [key: string]: any;
}

/**
 * 发布/更新产品 (product_offer/save)
 * 可批量提交, 每次最多建议 100 个
 */
export async function saveProductOffers(
  creds: EmagCredentials,
  offers: EmagProductOffer[],
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'product_offer', 'save', offers);
}

/**
 * 创建 Draft 草稿产品 — 仅必填字段
 * eMAG 允许先创建骨架, 后续通过 save 补充信息
 */
export async function saveDraftOffer(
  creds: EmagCredentials,
  draft: {
    partNumber: string;
    name: string;
    categoryId: number;
    salePrice: number;
    stock?: number;
    warehouseId?: number;
  },
): Promise<EmagApiResponse> {
  const offer: EmagProductOffer = {
    part_number: draft.partNumber,
    name: draft.name,
    category_id: draft.categoryId,
    sale_price: draft.salePrice,
    status: 1,
  };

  if (draft.stock !== undefined) {
    offer.stock = [{ warehouse_id: draft.warehouseId ?? 1, value: draft.stock }];
  }

  return saveProductOffers(creds, [offer]);
}

/**
 * 发布完整产品
 */
export async function saveFullProductOffer(
  creds: EmagCredentials,
  product: {
    partNumber: string;
    name: string;
    categoryId: number;
    salePrice: number;
    description?: string;
    brand?: string;
    vatId?: number;
    stock?: number;
    warehouseId?: number;
    handlingTime?: number;
    images?: string[];
    characteristics?: Array<{ id: number; value: string }>;
  },
): Promise<EmagApiResponse> {
  const offer: EmagProductOffer = {
    part_number: product.partNumber,
    name: product.name,
    category_id: product.categoryId,
    sale_price: product.salePrice,
    status: 1,
  };

  if (product.description) offer.description = product.description;
  if (product.brand) offer.brand = product.brand;
  if (product.vatId) offer.vat_id = product.vatId;

  if (product.stock !== undefined) {
    const wh = product.warehouseId ?? 1;
    offer.stock = [{ warehouse_id: wh, value: product.stock }];
    if (product.handlingTime !== undefined) {
      offer.handling_time = [{ warehouse_id: wh, value: product.handlingTime }];
    }
  }

  if (product.images?.length) {
    offer.images = product.images.map((url, i) => ({ display_type: i === 0 ? 1 : 2, url }));
  }

  if (product.characteristics?.length) {
    offer.characteristics = product.characteristics;
  }

  return saveProductOffers(creds, [offer]);
}

/**
 * 读取产品 offer（支持分页，status=1 为在售）
 *
 * options.timeout 默认继承全局 DEFAULT_TIMEOUT_MS（60s）；
 * 产品同步场景可传 { timeout: 180_000 }，订单等轻量接口不受影响。
 */
export async function readProductOffers(
  creds: EmagCredentials,
  filters: Record<string, any> = {},
  options: { timeout?: number } = {},
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'product_offer', 'read', filters, options);
}

/**
 * 获取在售产品数量 (product_offer/count)
 */
export async function countProductOffers(
  creds: EmagCredentials,
  filters: Record<string, any> = {},
): Promise<number> {
  const res = await emagApiCall<{ noOfItems: number }>(creds, 'product_offer', 'count', filters);
  return res.isError ? 0 : (res.results?.noOfItems ?? 0);
}

/**
 * 获取 eMAG 类目列表
 */
export async function readCategories(
  creds: EmagCredentials,
  filters: Record<string, any> = {},
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'category', 'read', filters);
}

/**
 * 获取类目数量
 */
export async function countCategories(creds: EmagCredentials): Promise<number> {
  const res = await emagApiCall<{ noOfItems: number }>(creds, 'category', 'count');
  return res.isError ? 0 : (res.results?.noOfItems ?? 0);
}

/**
 * 获取类目特征字段 (用于发布时填充 characteristics)
 */
export async function readCategoryCharacteristics(
  creds: EmagCredentials,
  categoryId: number,
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'category', 'read', { id: categoryId });
}

/**
 * 根据 EAN 批量查询产品文档（含 product_image）
 * 用于跟卖产品图片补全，限速 5 req/sec
 * @param eans EAN 数组，每批最多 100 个
 */
export async function findDocumentationByEans(
  creds: EmagCredentials,
  eans: string[],
): Promise<EmagApiResponse<Array<{ ean?: string; product_image?: string; [key: string]: any }>>> {
  const filtered = eans.map((e) => String(e).trim()).filter(Boolean);
  if (filtered.length === 0) return { isError: true, messages: ['eans 为空'] };
  return emagApiCall(creds, 'documentation', 'find_by_eans', { eans: filtered });
}

/**
 * Catalog 产品详情接口 — 根据 PNK 批量查询完整产品数据（含 images/attachments）
 * 用于两段式同步的第二阶段：深层图片补全
 * 尝试参数: part_number_key | ids | part_numbers（依 eMAG API 版本而定）
 * @param pnkList part_number_key 数组，每批建议 50 个
 */
export async function readProductsByPnk(
  creds: EmagCredentials,
  pnkList: string[],
): Promise<EmagApiResponse<any[]>> {
  const filtered = pnkList.map((p) => String(p).trim()).filter(Boolean);
  if (filtered.length === 0) return { isError: true, messages: ['pnkList 为空'] };
  const payload = { part_number_key: filtered };
  return emagApiCall(creds, 'product', 'read', payload);
}
