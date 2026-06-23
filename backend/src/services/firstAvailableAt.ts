import { prisma } from '../lib/prisma';
import { hasNoHistoricalSales, NEW_OBSERVATION_WINDOW_DAYS, type ClassificationSalesStats } from './productClassification';

export type StockSignalRecord = {
  id: number;
  stock: number;
  inTransitStock: number;
  firstAvailableAt?: Date | null;
  firstInboundAt?: Date | null;
  firstStockSignalAt?: Date | null;
};

export type EffectiveStockSignals = {
  firstAvailableAt: Date | null;
  firstInboundAt: Date | null;
  firstStockSignalAt: Date | null;
};

export type StockSignalDbPatch = {
  firstAvailableAt?: Date;
  firstInboundAt?: Date;
  firstStockSignalAt?: Date;
};

/**
 * 解析有效库存信号时间（分类/列表读取用）。
 * 允许对无历史销量产品做 firstStockSignalAt 历史初始化；firstAvailableAt/firstInboundAt 在首次检测到有货/在途时补写。
 */
export function resolveEffectiveStockSignals(
  record: StockSignalRecord,
  salesStats: ClassificationSalesStats,
  now = new Date(),
): { signals: EffectiveStockSignals; pendingDbPatch: StockSignalDbPatch } {
  const pendingDbPatch: StockSignalDbPatch = {};
  let firstAvailableAt = record.firstAvailableAt ?? null;
  let firstInboundAt = record.firstInboundAt ?? null;
  let firstStockSignalAt = record.firstStockSignalAt ?? null;

  const stock = Number(record.stock) || 0;
  const inTransit = Number(record.inTransitStock) || 0;
  const hasPlatformStock = stock > 0;
  const hasInbound = inTransit > 0;
  const hasAnySignal = hasPlatformStock || hasInbound;
  const noHistoricalSales = hasNoHistoricalSales(salesStats);

  if (hasInbound && !firstInboundAt) {
    firstInboundAt = now;
    pendingDbPatch.firstInboundAt = now;
  }

  if (hasPlatformStock && !firstAvailableAt) {
    firstAvailableAt = now;
    pendingDbPatch.firstAvailableAt = now;
  }

  if (hasAnySignal && !firstStockSignalAt && noHistoricalSales) {
    firstStockSignalAt = now;
    pendingDbPatch.firstStockSignalAt = now;
  }

  return {
    signals: { firstAvailableAt, firstInboundAt, firstStockSignalAt },
    pendingDbPatch,
  };
}

export async function buildStockSignalMap(
  items: Array<StockSignalRecord & { salesStats: ClassificationSalesStats }>,
  now = new Date(),
  options: { scheduleDbBackfill?: boolean } = {},
): Promise<Map<number, EffectiveStockSignals>> {
  const scheduleDbBackfill = options.scheduleDbBackfill ?? true;
  const map = new Map<number, EffectiveStockSignals>();
  const patchesById = new Map<number, StockSignalDbPatch>();

  for (const item of items) {
    const { signals, pendingDbPatch } = resolveEffectiveStockSignals(item, item.salesStats, now);
    map.set(item.id, signals);
    if (Object.keys(pendingDbPatch).length > 0) {
      patchesById.set(item.id, pendingDbPatch);
    }
  }

  if (scheduleDbBackfill && patchesById.size > 0) {
    scheduleStockSignalBackfill(patchesById);
  }

  return map;
}

export function scheduleStockSignalBackfill(patchesById: Map<number, StockSignalDbPatch>): void {
  setImmediate(async () => {
    try {
      let updated = 0;
      for (const [id, patch] of patchesById) {
        const current = await prisma.storeProduct.findUnique({
          where: { id },
          select: { firstAvailableAt: true, firstInboundAt: true, firstStockSignalAt: true },
        });
        if (!current) continue;

        const data: StockSignalDbPatch = {};
        if (patch.firstAvailableAt && !current.firstAvailableAt) data.firstAvailableAt = patch.firstAvailableAt;
        if (patch.firstInboundAt && !current.firstInboundAt) data.firstInboundAt = patch.firstInboundAt;
        if (patch.firstStockSignalAt && !current.firstStockSignalAt) data.firstStockSignalAt = patch.firstStockSignalAt;
        if (Object.keys(data).length === 0) continue;

        await prisma.storeProduct.update({ where: { id }, data });
        updated += 1;
      }
      if (updated > 0) {
        console.log(`[stockSignals] 后台补写库存信号时间: ${updated} 条`);
      }
    } catch (e) {
      console.error('[stockSignals] 后台补写失败:', e instanceof Error ? e.message : e);
    }
  });
}

/** @deprecated 使用 resolveEffectiveStockSignals */
export type FirstAvailableAtItem = StockSignalRecord & { firstSeenAt?: Date | null };

/** @deprecated 使用 buildStockSignalMap */
export async function buildFirstAvailableAtMap(
  items: Array<{ id: number; stock: number; firstAvailableAt: Date | null; firstSeenAt?: Date | null }>,
  now = new Date(),
  _options: { syntheticBackfill?: boolean; scheduleDbBackfill?: boolean } = {},
): Promise<Map<number, Date | null>> {
  const map = new Map<number, Date | null>();
  for (const item of items) {
    map.set(item.id, item.firstAvailableAt ?? null);
  }
  return map;
}

export function resolveFirstAvailableAtForSync(
  stock: number,
  existingFirstAvailableAt: Date | null | undefined,
  now = new Date(),
): Date | undefined {
  if (existingFirstAvailableAt) return undefined;
  if (Number(stock) > 0) return now;
  return undefined;
}

export function resolveStockSignalsForSync(
  stock: number,
  inTransitStock: number,
  existing: {
    firstAvailableAt?: Date | null;
    firstInboundAt?: Date | null;
    firstStockSignalAt?: Date | null;
  },
  now = new Date(),
): StockSignalDbPatch {
  const patch: StockSignalDbPatch = {};
  const platformStock = Number(stock) || 0;
  const inTransit = Number(inTransitStock) || 0;

  if (platformStock > 0 && !existing.firstAvailableAt) {
    patch.firstAvailableAt = now;
  }
  if (inTransit > 0 && !existing.firstInboundAt) {
    patch.firstInboundAt = now;
  }
  if ((platformStock > 0 || inTransit > 0) && !existing.firstStockSignalAt) {
    patch.firstStockSignalAt = now;
  }
  return patch;
}

export { NEW_OBSERVATION_WINDOW_DAYS };
