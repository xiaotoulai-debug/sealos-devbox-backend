/**
 * 1688 采购订单同步服务层
 *
 * 复用项目已有的 callAlibabaAPIPost / getValidAccessToken 基础设施；
 * 本模块只负责解析 buyerView 详情 + logistics trace 两类接口的返回值。
 *
 * ─── API 对应关系 ────────────────────────────────────────────────
 *  syncOrderDetail        → alibaba.trade.get.buyerView
 *  syncLogisticsInfos     → alibaba.trade.getLogisticsInfos.buyerView（专项物流单列表）
 *  getLogisticsTrace      → alibaba.logistics.trace.info.get（按运单号查轨迹）
 *  getLogisticsTraceByOrder → alibaba.trade.getLogisticsTraceInfo.buyerView（按订单号查轨迹，首选）
 */

import { callAlibabaAPIPost, getValidAccessToken } from '../utils/alibaba';
import { prisma } from '../lib/prisma';

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
  // ★ 1688 buyerView 实际路径：result.nativeLogistics.logisticsItems[]
  //   每条包含：logisticsCompanyName / logisticsBillNo / logisticsCode / status
  //   注意：result.logisticsOrders 不存在，历史代码读错了字段！
  const nativeLogistics = (resultObj?.nativeLogistics as Record<string, unknown>) ?? {};
  const rawLogisticsOrders =
    (nativeLogistics?.logisticsItems as unknown[] | undefined) ?? [];

  const logisticsOrders = rawLogisticsOrders.map((lo) => {
    const l = (lo ?? {}) as Record<string, unknown>;
    return {
      // logisticsBillNo = 快递单号（运单号），logisticsCode = 平台物流码（备用）
      logisticsId:          String(l.logisticsBillNo ?? l.logisticsCode ?? l.mailNo ?? ''),
      logisticsCompanyName: String(l.logisticsCompanyName ?? l.logisticsCompany ?? ''),
      logisticsStatus:      String(l.status ?? l.logisticsStatus ?? ''),
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

// ─── 专项物流单列表 (alibaba.trade.getLogisticsInfos.buyerView) ──

export interface LogisticsInfo {
  /** 1688 物流单主键（查轨迹必须） */
  logisticsId: string;
  /** 运单号（快递单号） */
  logisticsBillNo: string;
  /** 物流公司名称 */
  logisticsCompanyName: string;
  /** 发货时间（原始字符串） */
  gmtSend: string | null;
  /** 当前物流状态文本 */
  logisticsStatus: string;
}

export interface LogisticsInfosResult {
  logisticsInfos: LogisticsInfo[];
  rawResult: Record<string, unknown>;
}

/**
 * 调用 `alibaba.trade.getLogisticsInfos.buyerView` 获取订单的物流单列表。
 * 提取：logisticsId / logisticsBillNo / logisticsCompanyName / gmtSend / logisticsStatus
 */
export async function syncLogisticsInfos(
  alibabaOrderId: string,
): Promise<LogisticsInfosResult | AliServiceError> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { error: true, message: '1688 授权已过期，请重新绑定账号', errorCode: 'NO_TOKEN' };
  }

  // ★ 注意：alibaba.trade.getLogisticsInfos.buyerView 在部分应用权限套餐下返回
  //   gw.APIUnsupported（HTTP 400）。当该接口不可用时，调用方应降级到
  //   alibaba.trade.get.buyerView 中的 logisticsOrders 字段。
  const apiPath = 'param2/1/com.alibaba.trade/alibaba.trade.getLogisticsInfos.buyerView';

  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    apiPath,
    { orderId: alibabaOrderId, webSite: '1688' },
    accessToken,
  );

  if (!result.success) {
    // gw.APIUnsupported 表示当前应用未开通此 API 权限，直接返回错误供调用方降级
    console.warn(`[syncLogisticsInfos] 接口不可用 errorCode=${result.errorCode}（${result.errorMessage}）`);
    return {
      error: true,
      message: `1688 getLogisticsInfos 接口请求失败：${result.errorMessage ?? '未知错误'}`,
      errorCode: result.errorCode,
      raw: result.raw,
    };
  }

  const raw = (result.raw ?? {}) as Record<string, unknown>;

  // 典型响应: { result: [ { logisticsId, logisticsBillNo, logisticsCompanyName, ... } ] }
  // 或直接: { result: { ... } }（单条时 1688 可能不包装成数组）
  let rawList: unknown[] = [];
  const rawResult = (raw?.result ?? raw) as unknown;
  if (Array.isArray(rawResult)) {
    rawList = rawResult;
  } else if (rawResult && typeof rawResult === 'object') {
    rawList = [rawResult];
  }

  const logisticsInfos: LogisticsInfo[] = rawList
    .map((item) => {
      const i = (item ?? {}) as Record<string, unknown>;
      return {
        logisticsId:          String(i.logisticsId          ?? i.logisticsOrderId ?? '').trim(),
        logisticsBillNo:      String(i.logisticsBillNo      ?? i.mailNo           ?? '').trim(),
        logisticsCompanyName: String(i.logisticsCompanyName ?? i.logisticsCompany ?? '').trim(),
        gmtSend:              i.gmtSend ? String(i.gmtSend) : null,
        logisticsStatus:      String(i.logisticsStatus      ?? i.status           ?? '').trim(),
      };
    })
    .filter((i) => !!i.logisticsId || !!i.logisticsBillNo);

  return { logisticsInfos, rawResult: raw };
}

// ─── 按订单号查物流轨迹 (alibaba.trade.getLogisticsTraceInfo.buyerView) ─

export interface LogisticsTraceByOrderResult {
  logisticsId: string;
  logisticsBillNo: string;
  logisticsCompanyName: string;
  /** 节点按时间倒序排列（最新在前） */
  nodes: LogisticsTraceNode[];
}

/**
 * 调用 `alibaba.trade.getLogisticsTraceInfo.buyerView` 按 1688 订单号直查轨迹。
 * 无需提前获取运单号，适合在采购单同步时一步到位。
 *
 * @param alibabaOrderId  1688 订单号
 */
export async function getLogisticsTraceByOrder(
  alibabaOrderId: string,
): Promise<LogisticsTraceByOrderResult | AliServiceError> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { error: true, message: '1688 授权已过期，请重新绑定账号', errorCode: 'NO_TOKEN' };
  }

  // ★ 正确 namespace 为 com.alibaba.logistics（官方文档：com.alibaba.logistics:alibaba.trade.getLogisticsTraceInfo.buyerView）
  //   旧写法 com.alibaba.trade 会导致 gw.APIUnsupported（HTTP 400）
  const apiPath = 'param2/1/com.alibaba.logistics/alibaba.trade.getLogisticsTraceInfo.buyerView';
  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    apiPath,
    { orderId: alibabaOrderId, webSite: '1688' },
    accessToken,
  );

  if (!result.success) {
    return {
      error: true,
      message: `1688 getLogisticsTraceInfo 接口请求失败：${result.errorMessage ?? '未知错误'}`,
      errorCode: result.errorCode,
      raw: result.raw,
    };
  }

  const raw = (result.raw ?? {}) as Record<string, unknown>;

  // ★ 1688 getLogisticsTraceInfo.buyerView 真实响应结构（经线上验证）：
  // {
  //   logisticsTrace: [{
  //     logisticsId: "LP00805234421740",
  //     logisticsBillNo: "73701751082121",
  //     logisticsCompanyName: "中通快递(ZTO)",
  //     logisticsSteps: [{ acceptTime: "2026-03-31 18:57:26", remark: "..." }, ...]
  //   }]
  // }
  // 注意：顶层 key 是 logisticsTrace（数组），不是 result.traceNodeList（旧的猜测写法）
  const traceArray = (raw?.logisticsTrace as unknown[] | undefined) ?? [];
  const firstEntry = (traceArray[0] ?? {}) as Record<string, unknown>;

  // 兼容旧版 result.traceNodeList 结构（防御性降级）
  const resultObj  = (raw?.result as Record<string, unknown>) ?? {};

  const logisticsId          = String(firstEntry?.logisticsId          ?? resultObj?.logisticsId          ?? resultObj?.logisticsOrderId ?? '').trim();
  const logisticsBillNo      = String(firstEntry?.logisticsBillNo      ?? resultObj?.logisticsBillNo      ?? resultObj?.mailNo           ?? '').trim();
  const logisticsCompanyName = String(firstEntry?.logisticsCompanyName ?? resultObj?.logisticsCompanyName ?? resultObj?.logisticsCompany ?? '').trim();

  // logisticsSteps（新结构）优先，traceNodeList（旧结构）兜底
  const rawNodes: unknown[] =
    (firstEntry?.logisticsSteps as unknown[] | undefined) ??
    (resultObj?.traceNodeList   as unknown[] | undefined) ??
    [];

  const nodes: LogisticsTraceNode[] = rawNodes
    .map((n) => {
      const node = (n ?? {}) as Record<string, unknown>;
      return {
        // logisticsSteps 字段：acceptTime + remark；兼容旧字段 time/desc
        eventTime:   String(node.acceptTime ?? node.time        ?? node.eventTime   ?? '').trim(),
        description: String(node.remark     ?? node.desc        ?? node.description ?? '').trim(),
        location:    String(node.address    ?? node.location    ?? node.city        ?? '').trim() || null,
      };
    })
    .filter((n) => !!n.eventTime || !!n.description)
    // 最新节点排前（倒序）
    .sort((a, b) => {
      const ta = new Date(a.eventTime).getTime();
      const tb = new Date(b.eventTime).getTime();
      return isNaN(ta) || isNaN(tb) ? 0 : tb - ta;
    });

  return { logisticsId, logisticsBillNo, logisticsCompanyName, nodes };
}

// ─────────────────────────────────────────────────────────────────

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

  // ★ 1688 文档要求参数名为 logisticsId（物流单主键），而非 logisticsOrderId
  const apiPath = 'param2/1/com.alibaba.logistics/alibaba.logistics.trace.info.get';
  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    apiPath,
    { logisticsId: logisticsId, webSite },
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

// ─── 1688 采购单自动同步（Cron 专用） ─────────────────────────────

/** 1688 状态 → 可读中文（与 purchase 路由保持一致） */
const ALIBABA_STATUS_MAP: Record<string, string> = {
  waitbuyerpay:     '等待买家付款',
  waitallpay:       '等待拼单付款',
  waitsellersend:   '等待卖家发货',
  waitbuyerreceive: '等待买家收货',
  success:          '交易成功',
  closed:           '交易关闭',
  cancelled:        '已取消',
};

export interface PurchaseSyncResult {
  orderId:         number;
  orderNo:         string;
  success:         boolean;
  alibabaStatus?:  string;
  logisticsCompany?: string | null;
  trackingNumber?:   string | null;
  error?:          string;
}

/**
 * 同步单条采购单的 1688 状态与物流信息，并直接落库。
 * 供定时任务（Cron）与手动同步路由共同复用，保证逻辑唯一来源。
 *
 * @param orderId       本地 PurchaseOrder.id
 * @param alibabaOrderId  1688 订单号
 * @param orderNo       订单号（日志用）
 */
export async function syncPurchaseOrderFromAlibaba(
  orderId: number,
  alibabaOrderId: string,
  orderNo: string,
): Promise<PurchaseSyncResult> {
  // ① 调用 buyerView 获取状态 + nativeLogistics 物流
  const detail = await syncOrderDetail(alibabaOrderId);
  if (isAliServiceError(detail)) {
    return { orderId, orderNo, success: false, error: detail.message };
  }

  const firstLogistics = detail.logisticsOrders[0] ?? null;
  const humanStatus    = ALIBABA_STATUS_MAP[detail.alibabaStatus] ?? detail.alibabaStatus;

  // ② 构建落库数据
  const updateData: Record<string, unknown> = {
    supplierName:    detail.supplierName ?? detail.sellerLoginId ?? undefined,
    logisticsStatus: firstLogistics
      ? `[${firstLogistics.logisticsCompanyName}] ${firstLogistics.logisticsStatus || humanStatus}`
      : humanStatus,
  };
  if (firstLogistics?.logisticsCompanyName) updateData.logisticsCompany = firstLogistics.logisticsCompanyName;
  if (firstLogistics?.logisticsId)          updateData.trackingNumber   = firstLogistics.logisticsId;

  // ③ 同步子单状态与金额
  await prisma.purchaseOrderItem.updateMany({
    where: { purchaseOrderId: orderId },
    data: {
      alibabaOrderStatus: detail.alibabaStatus,
      ...(detail.totalAmount > 0 ? { alibabaTotalAmount: detail.totalAmount } : {}),
      ...(detail.shippingFee  > 0 ? { shippingFee:        detail.shippingFee  } : {}),
    },
  });

  // ④ 原子落库主单
  await prisma.purchaseOrder.update({
    where: { id: orderId },
    data:  updateData,
  });

  return {
    orderId,
    orderNo,
    success:         true,
    alibabaStatus:   detail.alibabaStatus,
    logisticsCompany: (updateData.logisticsCompany as string | undefined) ?? null,
    trackingNumber:   (updateData.trackingNumber   as string | undefined) ?? null,
  };
}
