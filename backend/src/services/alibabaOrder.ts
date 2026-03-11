import { callAlibabaAPIPost, getValidAccessToken, AlibabaAPIResult } from '../utils/alibaba';

const DEFAULT_ADDRESS_ID = process.env.ALIBABA_DEFAULT_ADDRESS_ID ?? '';

// ── 类型 ──────────────────────────────────────────────────────

interface CargoParam {
  offerId: number;
  specId: string;
  quantity: number;
}

interface CreateOrderResult {
  orderId: string;
  totalAmount: number;
  raw: unknown;
}

// ── 构建下单 Payload 并调用 1688 创建订单 ─────────────────────

export async function createAlibabaOrder(
  items: CargoParam[],
  addressId?: string,
): Promise<AlibabaAPIResult<CreateOrderResult>> {
  console.log('═══════════════════════════════════════════════════');
  console.log('[alibabaOrder] ★★★ 开始创建 1688 订单 ★★★');
  console.log('[alibabaOrder] 商品列表:', JSON.stringify(items));

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    console.error('[alibabaOrder] ❌ 无有效 AccessToken');
    return { success: false, data: null, errorCode: 'NO_TOKEN', errorMessage: '1688 授权已过期，请重新绑定账号' };
  }
  console.log('[alibabaOrder] ✅ AccessToken 有效 (前20位):', accessToken.slice(0, 20) + '...');

  // 1. 确定收货地址 ID
  const finalAddressId = addressId || DEFAULT_ADDRESS_ID;
  if (!finalAddressId) {
    console.error('[alibabaOrder] ❌ 无收货地址 ID（环境变量 ALIBABA_DEFAULT_ADDRESS_ID 未配置）');
    return { success: false, data: null, errorCode: 'NO_ADDRESS', errorMessage: '未配置 1688 收货地址 ID，请联系管理员在 .env 中设置 ALIBABA_DEFAULT_ADDRESS_ID' };
  }
  console.log(`[alibabaOrder] ✅ 使用收货地址 ID: ${finalAddressId}`);

  // 2. 构建请求参数
  const addressParam = JSON.stringify({ addressId: finalAddressId });

  const cargoParamList = JSON.stringify(
    items.map((item) => ({
      offerId:  item.offerId,
      specId:   item.specId || '',
      quantity: item.quantity,
    })),
  );

  console.log('[alibabaOrder] addressParam:', addressParam);
  console.log('[alibabaOrder] cargoParamList:', cargoParamList);

  // 3. 预览订单
  const previewApiPath = 'param2/1/com.alibaba.trade/alibaba.createOrder.preview';
  console.log('[alibabaOrder] ── 第一步: 预览订单 ──');
  const preview = await callAlibabaAPIPost<Record<string, unknown>>(
    previewApiPath,
    { flow: 'general', addressParam, cargoParamList },
    accessToken,
  );

  console.log('[alibabaOrder] 预览结果 success:', preview.success);
  console.log('[alibabaOrder] 预览完整响应:', JSON.stringify(preview.raw).slice(0, 2000));

  if (!preview.success) {
    const errMsg = preview.errorMessage ?? '预览订单网关失败';
    console.error(`[alibabaOrder] ❌ 预览网关失败: ${preview.errorCode} → ${errMsg}`);
    return { success: false, data: null, errorCode: preview.errorCode ?? 'PREVIEW_GW_FAILED', errorMessage: errMsg, raw: preview.raw };
  }

  const previewData = preview.data as any;
  if (previewData?.success === false || previewData?.success === 'false') {
    const errMsg = previewData.message ?? previewData.errorMsg ?? previewData.resultDesc ?? '预览订单业务失败';
    const errCode = previewData.errorCode ?? previewData.resultCode ?? 'PREVIEW_BIZ_FAILED';
    console.error(`[alibabaOrder] ❌ 预览业务失败: ${errCode} → ${errMsg}`);
    console.error('[alibabaOrder] 预览业务失败完整数据:', JSON.stringify(previewData).slice(0, 2000));
    return { success: false, data: null, errorCode: String(errCode), errorMessage: errMsg, raw: previewData };
  }

  console.log('[alibabaOrder] ✅ 预览成功');
  console.log('[alibabaOrder] ── 第二步: 正式下单 ──');

  // 4. 正式创建订单
  const createApiPath = 'param2/1/com.alibaba.trade/alibaba.trade.fastCreateOrder';
  const createResult = await callAlibabaAPIPost<Record<string, unknown>>(
    createApiPath,
    { flow: 'general', addressParam, cargoParamList },
    accessToken,
  );

  console.log('[alibabaOrder] 下单结果 success:', createResult.success);
  console.log('[alibabaOrder] 下单完整响应:', JSON.stringify(createResult.raw).slice(0, 2000));

  if (!createResult.success) {
    const errMsg = createResult.errorMessage ?? '1688 下单网关失败';
    console.error(`[alibabaOrder] ❌ 下单网关失败: ${createResult.errorCode} → ${errMsg}`);
    return {
      success: false, data: null,
      errorCode: createResult.errorCode ?? 'CREATE_GW_FAILED',
      errorMessage: errMsg,
      raw: createResult.raw,
    };
  }

  const rawData = createResult.data as any;
  if (rawData?.success === false || rawData?.success === 'false') {
    const errMsg = rawData.message ?? rawData.errorMsg ?? rawData.errorMessage ?? rawData.resultDesc ?? '1688 下单业务失败';
    const errCode = rawData.errorCode ?? rawData.resultCode ?? 'BIZ_ERROR';
    console.error(`[alibabaOrder] ❌ 下单业务失败: ${errCode} → ${errMsg}`);
    console.error('[alibabaOrder] 下单业务失败完整数据:', JSON.stringify(rawData).slice(0, 2000));
    return { success: false, data: null, errorCode: String(errCode), errorMessage: errMsg, raw: rawData };
  }

  const orderId = String(rawData.orderId ?? rawData.result?.orderId ?? rawData.result?.id ?? '');
  const totalAmount = Number(rawData.totalAmount ?? rawData.result?.totalAmount ?? 0);

  console.log('═══════════════════════════════════════════════════');
  console.log(`[alibabaOrder] ✅✅✅ 下单成功! orderId=${orderId}, totalAmount=${totalAmount}`);
  console.log('═══════════════════════════════════════════════════');

  return {
    success: true,
    data: { orderId, totalAmount, raw: rawData },
    raw: rawData,
  };
}
