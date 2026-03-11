/**
 * 平台订单全量同步 — 循环分页拉取 eMAG 订单并写入 PlatformOrder 表
 * 启动时自动执行，确保历史订单（含已完成）全部入库
 * eMAG 限制: 单次查询日期范围不超过 31 天 [cite: dashboardStats]
 */
import { prisma } from '../lib/prisma';
import { getEmagCredentials } from './emagClient';
import { readOrders, mapOrderForDisplay } from './emagOrder';
import type { EmagOrder } from './emagOrder';

const ITEMS_PER_PAGE = 100;  // 推荐稳定值 [cite: 1384, 1397]
const SYNC_DAYS = 365;       // 全量同步时间窗口：近 365 天

function getDateRange(): { from: string; to: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - SYNC_DAYS);
  return {
    from: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    to: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`,
  };
}

export interface SyncResult {
  shopId: number;
  totalFetched: number;
  totalUpserted: number;
  pages: number;
  errors: string[];
}

async function upsertOrder(shopId: number, o: EmagOrder): Promise<void> {
  const mapped = mapOrderForDisplay(o);
  const orderTime = mapped.orderTime
    ? new Date(mapped.orderTime.replace(' ', 'T'))
    : new Date(0);

  await prisma.platformOrder.upsert({
    where: { shopId_emagOrderId: { shopId, emagOrderId: o.id } },
    create: {
      shopId,
      emagOrderId: o.id,
      status: mapped.status,
      statusText: mapped.status_text,
      orderTime,
      orderType: mapped.type ?? null,
      paymentMode: mapped.payment_mode ?? null,
      total: mapped.total,
      currency: mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson: JSON.stringify(o),
    },
    update: {
      status: mapped.status,
      statusText: mapped.status_text,
      orderTime,
      orderType: mapped.type ?? null,
      paymentMode: mapped.payment_mode ?? null,
      total: mapped.total,
      currency: mapped.currency ?? 'RON',
      customerJson: JSON.stringify(mapped.customer),
      productsJson: JSON.stringify(mapped.products),
      rawJson: JSON.stringify(o),
      syncedAt: new Date(),
    },
  });
}

/**
 * 对单个店铺执行全量订单同步（循环分页，按 31 天批次）
 */
export async function syncPlatformOrdersForShop(shopId: number): Promise<SyncResult> {
  const result: SyncResult = { shopId, totalFetched: 0, totalUpserted: 0, pages: 0, errors: [] };
  let creds;
  try {
    creds = await getEmagCredentials(shopId);
  } catch (e) {
    result.errors.push(`获取店铺凭证失败: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  const { from, to } = getDateRange();

  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    const readRes = await readOrders(creds, {
      currentPage,
      itemsPerPage: ITEMS_PER_PAGE,
    });

    if (readRes.isError) {
      result.errors.push(`page ${currentPage}: ${readRes.messages?.join('; ') ?? 'eMAG API 错误'}`);
      break;
    }

    const orders = Array.isArray(readRes.results) ? readRes.results : [];
    const inRange = orders.filter((o: any) => {
      const d = (o.date ?? o.created_at ?? '').toString().slice(0, 10);
      return d >= from && d <= to;
    });
    result.totalFetched += inRange.length;
    result.pages++;

    for (const o of inRange as EmagOrder[]) {
      try {
        await upsertOrder(shopId, o);
        result.totalUpserted++;
      } catch (e) {
        result.errors.push(`order ${o.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    hasMore = orders.length >= ITEMS_PER_PAGE;
    if (hasMore) currentPage++;
    if (currentPage > 100) break;
  }

  return result;
}

/**
 * 强制同步单笔订单（按 id 拉取并 upsert）
 */
export async function syncPlatformOrderById(shopId: number, orderId: number): Promise<{ ok: boolean; total?: number; status_text?: string; error?: string }> {
  const { readOrders, mapOrderForDisplay } = await import('./emagOrder');
  const creds = await getEmagCredentials(shopId);
  const readRes = await readOrders(creds, { id: orderId });
  if (readRes.isError || !Array.isArray(readRes.results) || readRes.results.length === 0) {
    return { ok: false, error: readRes.messages?.join('; ') ?? '订单不存在' };
  }
  const o = readRes.results[0] as EmagOrder;
  await upsertOrder(shopId, o);
  const mapped = mapOrderForDisplay(o);
  return { ok: true, total: mapped.total, status_text: mapped.status_text };
}

/**
 * 对所有 eMAG 店铺执行全量订单同步（启动时调用）
 */
export async function syncAllPlatformOrders(): Promise<SyncResult[]> {
  const shops = await prisma.shopAuthorization.findMany({
    where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
    select: { id: true },
  });

  const results: SyncResult[] = [];
  for (const shop of shops) {
    const r = await syncPlatformOrdersForShop(shop.id);
    results.push(r);
    console.log(`[platformOrderSync] shop=${shop.id} 拉取=${r.totalFetched} 入库=${r.totalUpserted} 页数=${r.pages}`);
  }
  return results;
}
