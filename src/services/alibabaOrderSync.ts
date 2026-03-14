/**
 * 1688 订单详情拉取与解析（共享逻辑）
 * ★ 严禁使用 getBuyerOrderList（列表接口，返回 541 条），必须只用 getBuyerView（详情接口）
 * ★ 必须从 result.baseInfo 提取：status、totalAmount、shippingFee
 */
import { callAlibabaAPIPost, getValidAccessToken } from '../utils/alibaba';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface Fetch1688OrderResult {
  status: string;
  totalAmount: number;
  shippingFee: number;
  debug_raw_price: Record<string, unknown> | null;
}

export interface Fetch1688OrderError {
  error: true;
  message: string;
  errorCode?: string;
  raw?: unknown;
}

/**
 * 调用 1688 alibaba.trade.get.buyerView（详情接口），按 orderId 查单笔详情
 * 请求参数：orderId = externalOrderId（该采购项的 1688 订单号）
 */
export async function fetch1688OrderDetail(
  orderId: string
): Promise<Fetch1688OrderResult | Fetch1688OrderError> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return { error: true, message: '1688 授权已过期，请重新绑定账号' };
  }

  // ★ 必须使用详情接口，禁止 getBuyerOrderList（列表接口）
  const viewPath = 'param2/1/com.alibaba.trade/alibaba.trade.get.buyerView';

  const result = await callAlibabaAPIPost<Record<string, unknown>>(
    viewPath,
    { orderId, webSite: '1688' },
    accessToken
  );

  if (!result.success) {
    const errMsg = result.errorMessage ?? '1688 接口请求失败';
    const errCode = result.errorCode ?? '';
    return {
      error: true,
      message: `1688 同步失败: ${errMsg}`,
      errorCode: String(errCode),
      raw: result.raw,
    };
  }
  if (!result.raw) {
    return { error: true, message: '1688 返回为空' };
  }

  const res = result.raw as Record<string, unknown>;
  const resultObj = res?.result as Record<string, unknown> | undefined;

  if (!resultObj || typeof resultObj !== 'object') {
    return {
      error: true,
      message: '1688 未查到该订单号的详情',
      raw: res,
    };
  }

  const baseInfo =
    resultObj?.baseInfo && typeof resultObj.baseInfo === 'object'
      ? (resultObj.baseInfo as Record<string, unknown>)
      : undefined;

  if (!baseInfo) {
    return {
      error: true,
      message: '1688 未查到该订单号的详情',
      raw: res,
    };
  }

  const status: string = String(baseInfo.status ?? 'unknown');
  const totalAmount: number = Number(baseInfo.totalAmount) || 0;
  const shippingFee: number = Number(baseInfo.shippingFee || 0);

  return {
    status,
    totalAmount: Number(Number(totalAmount).toFixed(2)),
    shippingFee: Number(Number(shippingFee).toFixed(2)),
    debug_raw_price: baseInfo ?? null,
  };
}

/**
 * 同步并更新 PurchaseOrderItem 的金额、状态
 */
export async function syncAndUpdatePurchaseOrderItem(
  purchaseOrderItemId: number,
  alibabaOrderId: string
): Promise<Fetch1688OrderResult | Fetch1688OrderError> {
  const detail = await fetch1688OrderDetail(alibabaOrderId);
  if ('error' in detail && detail.error) return detail;

  await prisma.purchaseOrderItem.update({
    where: { id: purchaseOrderItemId },
    data: {
      alibabaOrderStatus: detail.status,
      alibabaTotalAmount: detail.totalAmount,
      shippingFee: detail.shippingFee,
    },
  });

  return detail;
}
