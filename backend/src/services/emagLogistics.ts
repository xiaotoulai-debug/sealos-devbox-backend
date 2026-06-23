import { EmagCredentials, emagApiCall, EmagApiResponse } from './emagClient';

// ─── eMAG 库存 & 物流服务 (API v4.5.0) ──────────────────────────
//
// 库存更新:
//   - offer/save (轻量化, 仅更新价格/库存/状态)
//   - product_offer/save (重型, 更新全量产品信息)
//
// 物流 AWB:
//   - awb/save  — 生成运单号, 是订单转为 Finalized 状态的触发点
//   - awb/read  — 查询运单详情
//
// 限流: 3 req/sec (非订单路由)

// ─── 库存更新 ────────────────────────────────────────────────────

export interface OfferStockUpdate {
  id?: number;                        // eMAG product_offer ID
  part_number?: string;               // SKU, 与 id 二选一
  sale_price?: number;                // 更新售价
  status?: number;                    // 1=Active, 0=Inactive
  stock?: Array<{
    warehouse_id: number;
    value: number;
  }>;
  handling_time?: Array<{
    warehouse_id: number;
    value: number;
  }>;
  [key: string]: any;
}

/**
 * 轻量级 offer 更新 (offer/save)
 * 仅更新库存/价格/状态, 无需回传全量产品字段
 */
export async function saveOffer(
  creds: EmagCredentials,
  offers: OfferStockUpdate[],
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'product_offer', 'save', offers);
}

/**
 * 批量更新库存的便捷方法
 */
export async function batchUpdateStock(
  creds: EmagCredentials,
  items: Array<{ partNumber: string; stock: number; warehouseId?: number }>,
): Promise<EmagApiResponse> {
  const offers: OfferStockUpdate[] = items.map((item) => ({
    part_number: item.partNumber,
    stock: [{ warehouse_id: item.warehouseId ?? 1, value: item.stock }],
  }));
  return saveOffer(creds, offers);
}

/**
 * 批量更新价格
 */
export async function batchUpdatePrice(
  creds: EmagCredentials,
  items: Array<{ partNumber: string; salePrice: number }>,
): Promise<EmagApiResponse> {
  const offers: OfferStockUpdate[] = items.map((item) => ({
    part_number: item.partNumber,
    sale_price: item.salePrice,
  }));
  return saveOffer(creds, offers);
}

/**
 * 上下架产品
 */
export async function setOfferStatus(
  creds: EmagCredentials,
  partNumber: string,
  active: boolean,
): Promise<EmagApiResponse> {
  return saveOffer(creds, [{ part_number: partNumber, status: active ? 1 : 0 }]);
}

// ─── 物流 AWB ────────────────────────────────────────────────────

export interface EmagAwb {
  order_id: number;
  sender?: {
    name?: string;
    phone1?: string;
    locality_id?: number;
    street?: string;
    zipcode?: string;
    [key: string]: any;
  };
  receiver?: {
    name?: string;
    phone1?: string;
    locality_id?: number;
    street?: string;
    zipcode?: string;
    [key: string]: any;
  };
  envelope_number?: number;           // 包裹数
  weight?: number;                    // 重量 kg
  parcels?: number;
  cod?: number;                       // 货到付款金额
  courier_account_id?: number;
  pickup_and_return?: number;         // 1=到付退回
  saturday_delivery?: number;
  insured_value?: number;
  observation?: string;
  [key: string]: any;
}

/**
 * 生成 AWB 运单 (awb/save)
 * 这是订单从 "In progress/Prepared" 转为 "Finalized" 的触发点
 */
export async function saveAwb(
  creds: EmagCredentials,
  awbData: EmagAwb[],
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'awb', 'save', awbData);
}

/**
 * 为单个订单创建运单
 */
export async function createOrderAwb(
  creds: EmagCredentials,
  params: {
    orderId: number;
    weight: number;
    parcels?: number;
    envelopeNumber?: number;
    courierAccountId?: number;
    observation?: string;
  },
): Promise<EmagApiResponse> {
  const awb: EmagAwb = {
    order_id: params.orderId,
    weight: params.weight,
    parcels: params.parcels ?? 1,
    envelope_number: params.envelopeNumber ?? 1,
  };
  if (params.courierAccountId) awb.courier_account_id = params.courierAccountId;
  if (params.observation) awb.observation = params.observation;

  return saveAwb(creds, [awb]);
}

/**
 * 读取 AWB 详情
 */
export async function readAwb(
  creds: EmagCredentials,
  filters: Record<string, any> = {},
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'awb', 'read', filters);
}
