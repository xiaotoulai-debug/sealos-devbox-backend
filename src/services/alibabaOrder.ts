import { callAlibabaAPIPost, getValidAccessToken, AlibabaAPIResult } from '../utils/alibaba';

const DEFAULT_ADDRESS_ID = process.env.ALIBABA_DEFAULT_ADDRESS_ID ?? '';

// ── 类型 ──────────────────────────────────────────────────────

interface CargoParam {
  offerId: string | number;
  specId: string; // 1688 强制依赖 32 位 MD5 哈希，不可为空
  quantity: number;
}

interface CreateOrderResult {
  orderId: string;
  totalAmount: number;
  raw: unknown;
}

export interface AlibabaOrderDebugPayload {
  addressParam: string;
  cargoParamList: string;
  flow: string;
}

// ── 构建下单 Payload 并调用 1688 创建订单 ─────────────────────

export async function createAlibabaOrder(
  items: CargoParam[],
  addressId?: string,
): Promise<AlibabaAPIResult<CreateOrderResult> & { debugPayload?: AlibabaOrderDebugPayload }> {
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
  // ★ addressId 必须为 Number，1688 Java 后端对 Long 类型严格反序列化，String 会触发 500_002
  const addressParam = JSON.stringify({ addressId: Number(finalAddressId) });

  // ★ offerId/quantity 强转 Number（1688 Java 后端 Long 反序列化，String 会 500_002）
  // ★ specId 必须为 32 位 MD5 哈希字符串（String），不可为空
  const cargoItems = items.map((item) => ({
    offerId: Number(item.offerId),
    specId: String(item.specId ?? ''),
    quantity: Number(item.quantity) || 1,
  }));

  cargoItems.forEach((c, i) => {
    console.log(`[alibabaOrder] 类型校验 [${i}] offerId=${typeof c.offerId}(${c.offerId}) specId=${typeof c.specId}(${c.specId?.slice?.(-8)}) quantity=${typeof c.quantity}(${c.quantity})`);
  });

  cargoItems.forEach((c, i) => {
    console.log(`=== 1688 FINAL PAYLOAD [${i}] ===`, JSON.stringify(c));
  });

  const cargoParamList = JSON.stringify(cargoItems);
  console.log('=== FINAL 1688 ORDER PAYLOAD ===', JSON.stringify(JSON.parse(cargoParamList), null, 2));

  const orderData = { flow: 'general', addressParam, cargoParamList };
  const debugPayload: AlibabaOrderDebugPayload = { flow: 'general', addressParam, cargoParamList };

  console.log('=== 1688 ORDER SUBMIT PAYLOAD ===', JSON.stringify(orderData, null, 2));
  console.log('[alibabaOrder] addressParam:', addressParam);
  console.log('[alibabaOrder] cargoParamList:', cargoParamList);

  // 3. 预览订单
  const previewApiPath = 'param2/1/com.alibaba.trade/alibaba.createOrder.preview';
  console.log('[alibabaOrder] ── 第一步: 预览订单 ──');
  const preview = await callAlibabaAPIPost<Record<string, unknown>>(
    previewApiPath,
    orderData,
    accessToken,
  );

  console.log('[alibabaOrder] 预览结果 success:', preview.success);
  console.log('[alibabaOrder] 预览完整响应:', JSON.stringify(preview.raw).slice(0, 2000));

  if (!preview.success) {
    const errMsg = preview.errorMessage ?? '预览订单网关失败';
    console.error(`[alibabaOrder] ❌ 预览网关失败: ${preview.errorCode} → ${errMsg}`);
    return { success: false, data: null, errorCode: preview.errorCode ?? 'PREVIEW_GW_FAILED', errorMessage: errMsg, raw: preview.raw, debugPayload };
  }

  const previewData = preview.data as any;
  if (previewData?.success === false || previewData?.success === 'false') {
    const errMsg = previewData.message ?? previewData.errorMsg ?? previewData.resultDesc ?? '预览订单业务失败';
    const errCode = previewData.errorCode ?? previewData.resultCode ?? 'PREVIEW_BIZ_FAILED';
    console.error(`[alibabaOrder] ❌ 预览业务失败: ${errCode} → ${errMsg}`);
    console.error('[alibabaOrder] 预览业务失败完整数据:', JSON.stringify(previewData));
    return { success: false, data: null, errorCode: String(errCode), errorMessage: errMsg, raw: previewData, debugPayload };
  }

  console.log('[alibabaOrder] ✅ 预览成功');
  console.log('[alibabaOrder] ── 第二步: 正式下单 ──');

  // 4. 正式创建订单
  const createApiPath = 'param2/1/com.alibaba.trade/alibaba.trade.fastCreateOrder';
  console.log('🔥🔥🔥 1688 CREATE ORDER FULL PAYLOAD 🔥🔥🔥', JSON.stringify(orderData, null, 2));
  const createResult = await callAlibabaAPIPost<Record<string, unknown>>(
    createApiPath,
    orderData,
    accessToken,
  );

  console.log('[alibabaOrder] 下单结果 success:', createResult.success);
  console.log('[alibabaOrder] 下单完整响应:', JSON.stringify(createResult.raw).slice(0, 2000));

  if (!createResult.success) {
    const errMsg = createResult.errorMessage ?? '1688 下单网关失败';
    console.error(`[alibabaOrder] ❌ 下单网关失败: ${createResult.errorCode} → ${errMsg}`);
    console.log('❌❌❌ 1688 RAW ERROR ❌❌❌', JSON.stringify(createResult.raw, null, 2));
    return {
      success: false, data: null,
      errorCode: createResult.errorCode ?? 'CREATE_GW_FAILED',
      errorMessage: errMsg,
      raw: createResult.raw,
      debugPayload,
    };
  }

  const rawData = createResult.data as any;
  if (rawData?.success === false || rawData?.success === 'false') {
    const errMsg = rawData.message ?? rawData.errorMsg ?? rawData.errorMessage ?? rawData.resultDesc ?? '1688 下单业务失败';
    const errCode = rawData.errorCode ?? rawData.resultCode ?? 'BIZ_ERROR';
    console.error(`[alibabaOrder] ❌ 下单业务失败: ${errCode} → ${errMsg}`);
    console.log('❌❌❌ 1688 RAW ERROR ❌❌❌', JSON.stringify(createResult.raw ?? rawData, null, 2));
    return { success: false, data: null, errorCode: String(errCode), errorMessage: errMsg, raw: rawData, debugPayload };
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
