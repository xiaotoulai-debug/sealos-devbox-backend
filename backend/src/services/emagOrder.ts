import { EmagCredentials, emagApiCall, EmagApiResponse, REGION_CURRENCY, EmagRegion } from './emagClient';

// ─── eMAG 订单服务 (API v4.5.0) ──────────────────────────────────
//
// 关键流程:
//   1. order/read   — 拉取新订单 (status=1 新建)
//   2. order/acknowledge — 确认已读, 停止 eMAG 通知推送
//   3. order/save   — 更新订单 (注意: 必须回传原始全量字段, 否则会覆盖)
//
// 订单状态映射:
//   1 = New, 2 = In progress, 3 = Prepared, 4 = Finalized, 5 = Cancelled

export interface EmagOrder {
  id: number;
  status: number;
  type?: number;  // 2 = FBE
  date: string;
  payment_mode: string;
  payment_mode_id: number;
  customer: {
    id: number;
    name: string;
    email?: string;
    phone_1?: string;
    billing_street?: string;
    billing_city?: string;
    billing_suburb?: string;
    billing_country?: string;
    shipping_city?: string;
    shipping_country?: string;
    [key: string]: any;
  };
  products: Array<{
    id: number;
    product_id: number;
    part_number: string;
    ext_part_number?: string;
    name?: string;
    product_name?: string;
    quantity: number;
    sale_price: number;
    vat_rate?: number;  // 增值税率，如 21 表示 21% [cite: 1518]
    [key: string]: any;
  }>;
  shipping_cost?: number;
  shipping_cost_vat?: number;
  shipping?: number;
  [key: string]: any; // eMAG 返回的其他字段保留
}

/** 平台订单展示用：买家信息映射 */
export interface MappedCustomer {
  name: string | null;
  phone_1: string | null;
  billing_street: string | null;
  billing_city: string | null;
  billing_suburb: string | null;
}

/** 平台订单展示用：产品明细映射 */
export interface MappedProduct {
  product_name: string | null;
  pnk: string | null;
  sku: string | null;
  sale_price: number;
  vat_rate: number;  // 增值税率小数，如 0.21 表示 21%
  quantity: number;
}

/**
 * 将 eMAG 原始订单转为前端展示格式（深度映射 customer 与 products）
 * @param region 站点区域，用于确定 currency（BG 自 2026 年起为 EUR）
 */
export function mapOrderForDisplay(o: EmagOrder, region?: EmagRegion): {
  id: number;
  status: number;
  type?: number;
  status_text: string;
  date: string | null;
  orderTime: string | null;  // eMAG date 映射 [cite: 1352]
  payment_mode: string | null;
  payment_mode_id: number | null;
  customer: MappedCustomer;
  products: MappedProduct[];
  total: number;
  currency: string;
} {
  const c = o?.customer ?? {};
  const customer: MappedCustomer = {
    name: c.name ?? null,
    phone_1: c.phone_1 ?? null,
    billing_street: c.billing_street ?? null,
    billing_city: c.billing_city ?? null,
    billing_suburb: c.billing_suburb ?? null,
  };
  const products: MappedProduct[] = (o?.products ?? [])
    .filter((p: any) => p != null && typeof p === 'object')
    .map((p: any) => {
      const rawVat = Number(p?.vat_rate ?? p?.vat ?? 0.21);
      const vatRate = rawVat <= 1 ? rawVat : rawVat / 100;
      return {
        product_name: p?.product_name ?? p?.name ?? null,
        pnk: p?.part_number ?? null,
        sku: p?.ext_part_number ?? null,
        sale_price: Number(p?.sale_price ?? 0),
        vat_rate: vatRate,
        quantity: Number(p?.quantity ?? 0),
      };
    });
  const statusNum = Number(o?.status ?? 0);
  const shipping = Number(o?.shipping_cost ?? o?.shipping_cost_vat ?? o?.shipping ?? 0);
  const productsGross = products.reduce(
    (s, p) => s + p.sale_price * (1 + p.vat_rate) * p.quantity,
    0
  );
  const total = Math.round((productsGross + shipping) * 100) / 100;
  const orderTime = o?.date ?? o?.created_at ?? null;
  const rawCurrency = (o as any)?.currency;
  const currency = (typeof rawCurrency === 'string' && rawCurrency.trim())
    ? (rawCurrency.trim().toUpperCase() === 'BGN' ? 'EUR' : rawCurrency.trim().toUpperCase())
    : (region && REGION_CURRENCY[region]) ?? 'RON';
  return {
    id: o?.id ?? 0,
    status: statusNum,
    type: o?.type,
    status_text: getStatusText(statusNum),
    date: orderTime,
    orderTime,
    payment_mode: o?.payment_mode ?? null,
    payment_mode_id: o?.payment_mode_id ?? null,
    customer,
    products,
    total,
    currency,
  };
}

/**
 * eMAG 状态映射 [cite: 1342-1348] 物理级写死，严禁修改
 * 4=已完成(Finalized) 0=已取消(Cancelled) — 确保 4 永不映射为「已取消」
 */
const statusMap: Record<number, string> = {
  0: '已取消',
  1: '新订单',
  2: '处理中',
  3: '已准备',
  4: '已完成',
  5: '已退货',
};

function getStatusText(status: number): string {
  return statusMap[status] ?? `状态${status}`;
}

export { statusMap };

export interface ReadOrdersOptions {
  id?: number;            // 单订单查询
  status?: number;        // 单状态筛选；不传则 API 可能只返回 New，需显式传 1,2,3,4,5 分批拉取
  type?: number;          // 订单履行类型：2=FBE（平台代发）, 3=FBM（卖家自发，API 默认）
                          // ★ API 默认值为 3，必须显式传 2 才能拉取 FBE 订单，否则永久漏单
  createdAfter?: string;   // YYYY-mm-dd HH:ii:ss 或 YYYY-MM-DD
  createdBefore?: string;
  modifiedAfter?: string;  // 增量优先：仅拉取该时间后有变动的订单 YYYY-mm-dd HH:ii:ss
  currentPage?: number;
  itemsPerPage?: number;
}

/** 全状态常量：1=New, 2=In progress, 3=Prepared, 4=Finalized, 5=Cancelled */
export const ALL_ORDER_STATUSES = [1, 2, 3, 4, 5] as const;

/** 转为 eMAG 日期格式 YYYY-mm-dd HH:ii:ss */
function toEmagDateTime(dateStr: string, time: string): string {
  const d = dateStr.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d} ${time}`;
  return dateStr;
}

/**
 * 读取 eMAG 订单列表 (POST, 参数包裹在 data 内)
 * eMAG 限流: 12 req/sec (order 路由)
 * 日期格式: YYYY-mm-dd HH:ii:ss (参考文档)
 */
export async function readOrders(
  creds: EmagCredentials,
  opts: ReadOrdersOptions = {},
): Promise<EmagApiResponse<EmagOrder[]>> {
  const filters: Record<string, any> = {};
  if (opts.id !== undefined) filters.id = opts.id;
  if (opts.status !== undefined) filters.status = opts.status;
  if (opts.type !== undefined) filters.type = opts.type;

  // ★ 参数格式修正（2026-04-03，文档 v4.4.7 §5.4）：
  //   eMAG 要求 createdAfter/createdBefore 为顶层扁平字段（YYYY-mm-dd HH:ii:ss）。
  //   原嵌套结构 { created: { from, to } } 会触发 500 "Error processing data"。
  if (opts.createdAfter) {
    const raw = opts.createdAfter.slice(0, 10);
    filters.createdAfter = toEmagDateTime(raw, opts.createdAfter.includes(' ') ? opts.createdAfter.slice(11, 19) : '00:00:00');
  }
  if (opts.createdBefore) {
    const raw = opts.createdBefore.slice(0, 10);
    filters.createdBefore = toEmagDateTime(raw, opts.createdBefore.includes(' ') ? opts.createdBefore.slice(11, 19) : '23:59:59');
  }
  if (opts.modifiedAfter) {
    filters.modified = { from: opts.modifiedAfter.includes(' ') ? opts.modifiedAfter : `${opts.modifiedAfter} 00:00:00` };
  }
  if (opts.currentPage)  filters.currentPage = opts.currentPage;
  if (opts.itemsPerPage) filters.itemsPerPage = opts.itemsPerPage;

  return emagApiCall<EmagOrder[]>(creds, 'order', 'read', filters);
}

/**
 * 按全状态分页拉取订单（status 1,2,3,4,5 各查一遍，合并去重）
 * 用于平台订单同步，确保不漏单
 *
 * ★ 双轮扫描设计（文档 v4.4.7 §5.4，2026-04-03 修正参数格式后启用）：
 *   第一轮（modified 扫描）：严格模式 —— 任何分页失败立即抛出异常，不允许静默吞错。
 *   第二轮（created 扫描）： 宽松模式 —— 单个状态网络超时/报错仅跳过本状态，
 *     不会抛出，也不会中断其他状态或其他店铺的同步（防 HU 超时阻断 RO/BG）。
 *   两轮结果通过内存 Map(orderId) 去重，避免同一订单重复 upsert。
 *
 * ★ 异常隔离架构：
 *   - 调用方（syncAllPlatformOrders）使用 Promise.allSettled，每店独立隔离
 *   - modified 轮失败 → 整个店铺同步中止（防漏单铁律）
 *   - created 轮单个状态失败 → 仅跳过该状态，其他状态和其他店铺正常继续
 */
export async function readOrdersForAllStatuses(
  creds: EmagCredentials,
  opts: Omit<ReadOrdersOptions, 'status'> & {
    statuses?: number[];
    createdAfter?: string;
    // ★ types: 显式指定需拉取的履行类型。默认 [2, 3]（FBE + FBM）
    //   eMAG API type 参数默认值为 3（FBM），不传 type=2 永久漏拉 FBE 订单
    types?: number[];
  } = {},
): Promise<EmagApiResponse<EmagOrder[]>> {
  const statuses     = opts.statuses ?? [...ALL_ORDER_STATUSES];
  // ★ 默认同时拉取 FBE(2) 和 FBM(3)，逐类型独立循环，结果 Map 内存去重
  const types        = opts.types ?? [2, 3];
  const allOrders    = new Map<number, EmagOrder>();
  const itemsPerPage = opts.itemsPerPage ?? 100;

  for (const orderType of types) {
    // ── 第一轮：modified 扫描（严格模式，防漏单铁律）───────────────────────
    for (const status of statuses) {
      let page = 1;
      while (true) {
        const res = await readOrders(creds, {
          ...opts,
          type:         orderType,
          createdAfter: undefined,   // 第一轮只用 modifiedAfter，显式清空 createdAfter
          status,
          currentPage:  page,
          itemsPerPage,
        });

        // ★ 严禁静默吞错：API 返回 isError 时立即抛出，让同步任务感知并上报
        if (res.isError) {
          const errMsg = res.messages?.join('; ') ?? 'eMAG API 返回错误（isError=true）';
          throw new Error(`eMAG 订单同步失败（modified scan, type=${orderType} status=${status} page=${page}）：${errMsg}`);
        }

        const batch = Array.isArray(res.results) ? res.results : [];
        for (const o of batch) {
          if (o?.id != null) allOrders.set(o.id, o);
        }

        if (batch.length < itemsPerPage) break;
        page++;
        if (page > 100) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // ── 第二轮：created 扫描（宽松模式，网络抖动不中断整体）────────────────
    // 仅当调用方显式传入 createdAfter 时执行；用于补录"从未被 modified 命中"的订单
    if (opts.createdAfter) {
      for (const status of statuses) {
        let page = 1;
        while (true) {
          let res;
          try {
            res = await readOrders(creds, {
              ...opts,
              type:          orderType,
              modifiedAfter: undefined,  // 第二轮只用 createdAfter，显式清空 modifiedAfter
              status,
              currentPage:  page,
              itemsPerPage,
            });
          } catch (networkErr) {
            // 宽松模式：网络异常跳过本状态，不抛出
            console.warn(
              `[readOrdersForAllStatuses] created 轮网络异常` +
              ` shop=${creds.region} type=${orderType} status=${status} page=${page}:` +
              ` ${networkErr instanceof Error ? networkErr.message : networkErr}，跳过本状态`,
            );
            break;
          }

          if (res.isError) {
            // 宽松模式：API 错误跳过本状态，记录警告
            console.warn(
              `[readOrdersForAllStatuses] created 轮 API 错误` +
              ` shop=${creds.region} type=${orderType} status=${status} page=${page}:` +
              ` ${res.messages?.join('; ') ?? 'isError=true'}，跳过本状态`,
            );
            break;
          }

          const batch = Array.isArray(res.results) ? res.results : [];
          for (const o of batch) {
            // 去重：modified 轮已抓取的订单 id 不覆盖（保留 modified 轮的最新数据）
            if (o?.id != null && !allOrders.has(o.id)) allOrders.set(o.id, o);
          }

          if (batch.length < itemsPerPage) break;
          page++;
          if (page > 100) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }

  return {
    isError: false,
    results: [...allOrders.values()],
  };
}

/**
 * 确认订单已读 (acknowledge)
 * 调用后 eMAG 停止对该订单发送通知, 必须在入库后尽快调用
 */
export async function acknowledgeOrders(
  creds: EmagCredentials,
  orderIds: number[],
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'order', 'acknowledge', orderIds);
}

/**
 * 读取新订单并自动 acknowledge
 * 典型的同步流程: read(status=1) → 本地入库 → acknowledge
 */
export async function syncNewOrders(
  creds: EmagCredentials,
  opts: Omit<ReadOrdersOptions, 'status'> = {},
): Promise<{ orders: EmagOrder[]; acknowledged: number[] }> {
  const readRes = await readOrders(creds, { ...opts, status: 1 });
  if (readRes.isError || !Array.isArray(readRes.results)) {
    return { orders: [], acknowledged: [] };
  }

  const orders = readRes.results;
  if (orders.length === 0) return { orders: [], acknowledged: [] };

  const ids = orders.map((o) => o.id);
  const ackRes = await acknowledgeOrders(creds, ids);

  const acknowledged = ackRes.isError ? [] : ids;
  if (ackRes.isError) {
    console.warn('[eMAG] acknowledge 失败, 这些订单下次仍会被拉取:', ids, ackRes.messages);
  }

  return { orders, acknowledged };
}

/**
 * 更新订单 (order/save)
 * 重要: eMAG 要求更新时必须发送初始 read 返回的全量字段,
 *       否则未发送的字段会被置空/覆盖
 */
export async function updateOrder(
  creds: EmagCredentials,
  orderData: EmagOrder,
): Promise<EmagApiResponse> {
  return emagApiCall(creds, 'order', 'save', [orderData]);
}

export interface CountOrdersOptions {
  status?: number;
  createdAfter?: string;   // ISO date
  createdBefore?: string;
}

/**
 * 获取订单数量（支持按日期筛选）
 */
export async function countOrders(
  creds: EmagCredentials,
  statusOrOpts?: number | CountOrdersOptions,
): Promise<number> {
  const opts = typeof statusOrOpts === 'number'
    ? { status: statusOrOpts }
    : (statusOrOpts ?? {});
  const filters: Record<string, any> = {};
  if (opts.status !== undefined) filters.status = opts.status;
  if (opts.createdAfter || opts.createdBefore) {
    filters.created = {};
    if (opts.createdAfter) {
      const raw = opts.createdAfter.slice(0, 10);
      filters.created.from = toEmagDateTime(raw, opts.createdAfter.includes(' ') ? opts.createdAfter.slice(11, 19) : '00:00:00');
    }
    if (opts.createdBefore) {
      const raw = opts.createdBefore.slice(0, 10);
      filters.created.to = toEmagDateTime(raw, opts.createdBefore.includes(' ') ? opts.createdBefore.slice(11, 19) : '23:59:59');
    }
  }
  const res = await emagApiCall<{ noOfItems: number }>(creds, 'order', 'count', filters);
  return res.isError ? 0 : (res.results?.noOfItems ?? 0);
}
