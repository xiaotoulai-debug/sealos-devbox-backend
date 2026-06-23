/**
 * 头程运费计算器
 *
 * 业务公式（老板确认）：
 *   头程运费(CNY) = MAX(实重kg, 体积重kg) × 17 元/kg
 *   体积重(kg) = 长(cm) × 宽(cm) × 高(cm) / 6000
 */

const VOLUME_DIVISOR = 6000;
const FREIGHT_RATE_PER_KG = 17;

/**
 * 计算单品头程运费（CNY）
 * @returns 头程费(CNY)，null 表示尺寸和重量数据均缺失无法计算
 */
export function calcHeadFreightCny(
  lengthCm: number | null,
  widthCm:  number | null,
  heightCm: number | null,
  actualWeightKg: number | null,
): number | null {
  const hasVolume = lengthCm != null && widthCm != null && heightCm != null
    && lengthCm > 0 && widthCm > 0 && heightCm > 0;
  const hasWeight = actualWeightKg != null && actualWeightKg > 0;

  if (!hasVolume && !hasWeight) return null;

  const volumeWeightKg = hasVolume
    ? (lengthCm! * widthCm! * heightCm!) / VOLUME_DIVISOR
    : 0;

  const chargeableWeight = Math.max(actualWeightKg ?? 0, volumeWeightKg);
  if (chargeableWeight <= 0) return null;

  return Math.round(chargeableWeight * FREIGHT_RATE_PER_KG * 100) / 100;
}
