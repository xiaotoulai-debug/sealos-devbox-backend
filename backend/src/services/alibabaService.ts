/**
 * 1688 采购订单同步服务层
 *
 * 复用项目已有的 callAlibabaAPIPost / getValidAccessToken 基础设施；
 * 本模块只负责解析 buyerView 详情 + logistics trace 两类接口的返回值。
 *
 * ─── API 对应关系 ────────────────────────────────────────────────
 *  syncOrderDetail    → alibaba.trade.get.buyerView
 *  getLogisticsTrace  → alibaba.logistics.trace.info.get
 */

import { callAlibabaAPIPost, getValidAccessToken } from '../utils/alibaba';

// ─── 通用错误结构 ─────────────────────────────────────────────────

export interface AliServiceError {
  error: true;
  message: string;
  errorCode?: string;
  raw?: unknown;
}

export function isAliServiceError(r: unknown): r is AliServiceError {
  return typeof r === 'object' && r !== null && 'error' in r && (r as AliServiceError).error === true;
}

// ─── buyerView 解析结果 ───────────────────────────────────────────

export interface OrderDetailResult {
  /** 1688 官方状态字符串，如 waitbuyerpay / waitsellersend / success / closed */
  alibabaStatus: string;
  /** 供应商登录名（卖家登录账号，稳定字段） */
  sellerLoginId: string | null;
  /** 供应商公司名（1688 企业资质名称，可能为空） */
  supplierName: string | null;
  /** 订单总金额（含运费） */
  totalAmount: number;
  /** 运费 */
  shippingFee: number;
  /**
   * 该主单下的物流订单列表（1688 允许一单多包裹）
   * 主单级别的 sync 只取第一条写入 PurchaseOrder，
   * 后续 logistics-trace 可用 logisticsId 查完整轨迹。
   */
  logisticsOrders: Array<{
    logisticsId: string;          // 物流单号（运单号）
    logisticsCompanyName: string; // 物流公司名称
    logisticsStatus: string;      // 当前物流状态文本
  }>;
  /** 1688 原始响应（用于排查 & 扩展） */
  rawResult: Record<string, unknown>;
}

/**
 * 调用 `alibaba.trade.get.buyerView` 查询 1688 订单详情，
 * 解析供应商、状态、物流单号。
 */
export async function syncOrderDetail(
  alibabaOrderId: string,
): Promise<OrderDetailResult | AliServiceError> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { error: true, message: '1688 授权已过期，请重新绑定账号', errorCode: 'NO_TOKEN' };
  }

  const apiPath = 'param2/1/com.alibaba.trade/alibaba.trade.get.buyerView';
  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    apiPath,
    { orderId: alibabaOrderId, webSite: '1688' },
    accessToken,
  );

  if (!result.success) {
    return {
      error: true,
      message: `1688 buyerView 接口请求失败：${result.errorMessage ?? '未知错误'}`,
      errorCode: result.errorCode,
      raw: result.raw,
    };
  }

  const raw = (result.raw ?? {}) as Record<string, unknown>;

  // ── 定位 result 层 ───────────────────────────────────────────
  // 1688 buyerView 典型响应结构：
  //   { result: { baseInfo: {...}, logisticsOrders: [...] } }
  // 但也见过直接挂在顶层的情况，做容错读取。
  const resultObj =
    (raw?.result as Record<string, unknown> | undefined) ??
    (raw as Record<string, unknown>);

  const baseInfo = (resultObj?.baseInfo as Record<string, unknown>) ?? {};
  if (!baseInfo || !baseInfo.status) {
    return {
      error: true,
      message: '1688 返回数据不完整（缺少 baseInfo.status），请确认订单号是否正确',
      raw,
    };
  }

  // ── 基础字段解析 ─────────────────────────────────────────────
  const alibabaStatus  = String(baseInfo.status ?? 'unknown');
  const totalAmount    = Number(baseInfo.totalAmount ?? 0);
  const shippingFee    = Number(baseInfo.shippingFee ?? 0);
  // 供应商：优先 sellerLoginId（稳定），再尝试 sellerCompanyName / sellerMemberId
  const sellerLoginId: string | null =
    String(baseInfo.sellerLoginId  ?? baseInfo.sellerId ?? '').trim() || null;
  const supplierName: string | null =
    String(baseInfo.sellerCompanyName ?? baseInfo.sellerNickname ?? '').trim() || null;

  // ── 物流订单解析 ─────────────────────────────────────────────
  // 典型路径：result.logisticsOrders[]
  //   每条包含：logisticsId / logisticsCompanyName / logisticsStatus
  const rawLogisticsOrders =
    (resultObj?.logisticsOrders as unknown[] | undefined) ?? [];

  const logisticsOrders = rawLogisticsOrders.map((lo) => {
    const l = (lo ?? {}) as Record<string, unknown>;
    return {
      logisticsId:          String(l.logisticsId          ?? l.logisticsBillNo ?? l.mailNo ?? ''),
      logisticsCompanyName: String(l.logisticsCompanyName ?? l.logisticsCompany ?? ''),
      logisticsStatus:      String(l.logisticsStatus      ?? l.status           ?? ''),
    };
  }).filter((l) => !!l.logisticsId);   // 过滤掉还没运单号的空记录

  return {
    alibabaStatus,
    sellerLoginId,
    supplierName,
    totalAmount:    Number(totalAmount.toFixed(2)),
    shippingFee:    Number(shippingFee.toFixed(2)),
    logisticsOrders,
    rawResult:      resultObj as Record<string, unknown>,
  };
}

// ─── 物流轨迹 ─────────────────────────────────────────────────────

export interface LogisticsTraceNode {
  /** 时间节点（ISO 字符串或原始格式） */
  eventTime: string;
  /** 状态文本 */
  description: string;
  /** 操作地点（可能为空） */
  location: string | null;
}

export interface LogisticsTraceResult {
  logisticsId: string;
  logisticsCompanyName: string;
  nodes: LogisticsTraceNode[];
}

/**
 * 调用 `alibaba.logistics.trace.info.get` 获取物流轨迹流转节点。
 *
 * @param logisticsId  物流单号（运单号）
 * @param webSite      站点标识，固定 "1688"
 */
export async function getLogisticsTrace(
  logisticsId: string,
  webSite = '1688',
): Promise<LogisticsTraceResult | AliServiceError> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { error: true, message: '1688 授权已过期，请重新绑定账号', errorCode: 'NO_TOKEN' };
  }

  const apiPath = 'param2/1/com.alibaba.logistics/alibaba.logistics.trace.info.get';
  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    apiPath,
    { logisticsOrderId: logisticsId, webSite },
    accessToken,
  );

  if (!result.success) {
    return {
      error: true,
      message: `1688 物流轨迹接口请求失败：${result.errorMessage ?? '未知错误'}`,
      errorCode: result.errorCode,
      raw: result.raw,
    };
  }

  const raw = (result.raw ?? {}) as Record<string, unknown>;

  // ── 典型响应结构 ─────────────────────────────────────────────
  // { result: { logisticsCompanyName, logisticsId, traceNodeList: [{...}] } }
  const resultObj = (raw?.result as Record<string, unknown>) ?? raw;

  const companyName = String(resultObj?.logisticsCompanyName ?? '');
  const traceNodeList = (resultObj?.traceNodeList as unknown[] | undefined) ?? [];

  const nodes: LogisticsTraceNode[] = traceNodeList.map((n) => {
    const node = (n ?? {}) as Record<string, unknown>;
    return {
      // 字段名在不同 1688 接口版本间有差异，做多路容错
      eventTime:   String(node.time         ?? node.eventTime   ?? node.acceptTime ?? ''),
      description: String(node.desc         ?? node.description ?? node.info        ?? ''),
      location:    String(node.address      ?? node.location    ?? node.city        ?? '').trim() || null,
    };
  }).filter((n) => !!n.eventTime || !!n.description);

  return {
    logisticsId,
    logisticsCompanyName: companyName,
    nodes,
  };
}
