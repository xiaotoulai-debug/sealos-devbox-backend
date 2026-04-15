/**
 * 店铺初始化同步 — 两段式深层抓取 (Two-Stage Deep Sync)
 *
 * 第一阶段：Offer Sync — product_offer/read 快速拉取 SKU、价格、库存，upsert 基础信息
 * 第二阶段：Deep Catalog Enrichment — product/read 批量查询无图产品详情，应用图片提纯算法，回写 main_image
 *
 * 双引擎抓图：attachments/images + documentation/find_by_eans + product/read Catalog
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { EmagCredentials, getEmagCredentials, REGION_DOMAIN } from './emagClient';
import { readProductOffers, findDocumentationByEans, readProductsByPnk } from './emagProduct';
import { normalizeEmagProduct, slugifyProductName } from './emagProductNormalizer';

// ★ 降级配置（2026-04-15）：eMAG RO product_offer/read 响应极慢（实测 156s），
//   缩小单页大小 + 加大页间间隔，减轻单次请求的服务端处理压力。
// 全局 DEFAULT_TIMEOUT_MS=60s 保持不变；产品同步通过 readProductOffers options 单独配置 180s。
const PAGE_SIZE = 20;               // 从 100 降至 20，减小单次响应体积
const DELAY_MS  = 1000;             // 从 350ms 增至 1000ms，降低代理连接并发压力
const PRODUCT_OFFER_TIMEOUT = 180_000; // 产品同步专属超时 3min（不影响订单/其他接口的 60s）
// ★ Best-effort Delivery：允许单次同步任务中最多连续失败多少页后安全中止
const MAX_CONSECUTIVE_PAGE_FAILURES = 3;
const EAN_BATCH_SIZE = 100;
const EAN_DELAY_MS = 200;
const CATALOG_BATCH_SIZE = 50; // 第二阶段每批 SKU 数
const CATALOG_DELAY_MS = 300;

function isJpgOrPngUrl(u: string): boolean {
  const lower = u.toLowerCase();
  return lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') || lower.includes('.jpg?') || lower.includes('.png?');
}

export interface SyncResult {
  shopId: number;
  totalFetched: number;
  upserted: number;
  errors: string[];
  rejectedCount: number;
  rejectedReasons: string[];
  rejectedSample?: { pnk: string; docErrors: string };
  eanImagesRecovered?: number;
  deepSyncImagesUpdated?: number; // 第二阶段 Catalog 补图数量
}

/**
 * 分页拉取店铺全部产品（含已驳回），强制抓取 doc_errors
 */
export async function syncStoreProducts(creds: EmagCredentials, modifiedAfter?: string): Promise<SyncResult> {
  const result: SyncResult = { shopId: creds.shopId, totalFetched: 0, upserted: 0, errors: [], rejectedCount: 0, rejectedReasons: [], eanImagesRecovered: 0, deepSyncImagesUpdated: 0 };

  const seenPnkKey = new Set<string>();
  const firstFiveRaw: Array<{ pn: string; pnk: string; imageUrl: string }> = [];
  const PIPELINE_LOG_LIMIT = 20;
  let pipelineLogCount = 0;

  const baseFilters: Record<string, any> = {};
  if (modifiedAfter) baseFilters.modified = { from: modifiedAfter };

  // ─── 逐页 upsert 回调（Best-effort Delivery 核心）───────────────────────────
  // 每拉一页，立即预取 EAN 图片并 upsert，不等待全量拉取完成。
  // 网络抖动只影响当前页，已落库页不受影响。
  const processBatch = async (batch: any[]): Promise<void> => {
    // 收集本页无图产品的 EAN，预拉取图片（引擎二：documentation/find_by_eans）
    const eanToImage = new Map<string, string>();
    const pageEans: string[] = [];
    for (const o of batch) {
      const np = normalizeEmagProduct(o as Record<string, unknown>, creds.region, { logOutput: false });
      if (!np.pnk) continue;
      if (!np.mainImage && np.ean) {
        const firstEan = String(np.ean).split(/[,\s]+/)[0]?.trim();
        if (firstEan) pageEans.push(firstEan);
      }
    }
    const uniquePageEans = [...new Set(pageEans)];
    if (uniquePageEans.length > 0) {
      try {
        for (let i = 0; i < uniquePageEans.length; i += EAN_BATCH_SIZE) {
          const eanChunk = uniquePageEans.slice(i, i + EAN_BATCH_SIZE);
          await new Promise((r) => setTimeout(r, EAN_DELAY_MS));
          const eanRes = await findDocumentationByEans(creds, eanChunk);
          if (eanRes.isError || !eanRes.results) continue;
          const items = Array.isArray(eanRes.results) ? eanRes.results : (eanRes.results as any)?.items ?? [];
          for (const item of items) {
            const ean = item?.ean ?? item?.EAN ?? item?.ean_code;
            const img = item?.product_image ?? item?.productImage ?? item?.image ?? item?.main_image;
            if (ean && typeof img === 'string' && img.trim()) {
              const eanStr = String(ean).trim();
              if (!eanToImage.has(eanStr)) eanToImage.set(eanStr, img.trim());
            }
          }
        }
      } catch (eanErr: any) {
        console.warn(`[Engine 2 API] EAN 预拉取失败，跳过: ${eanErr?.message ?? eanErr}`);
      }
    }

    // 逐条规范化 + upsert
    for (const o of batch) {
      try {
        const np = normalizeEmagProduct(o as Record<string, unknown>, creds.region, {
          logOutput: pipelineLogCount < PIPELINE_LOG_LIMIT,
        });
        if (pipelineLogCount < PIPELINE_LOG_LIMIT) pipelineLogCount++;
        if (!np.pnk) continue;

        // 引擎一（JSON）+ 引擎二（EAN API）合并
        const firstEan = np.ean ? String(np.ean).split(/[,\s]+/)[0]?.trim() : null;
        const eanImage = firstEan ? eanToImage.get(firstEan) ?? null : null;
        const mainImage: string | null = np.mainImage ?? eanImage;
        if (eanImage && !np.mainImage) result.eanImagesRecovered!++;

        const skuForLog = np.sku ?? np.vendorSku ?? np.pnk;

        if (firstFiveRaw.length < 5) {
          firstFiveRaw.push({
            pn: np.vendorSku ?? np.sku ?? '(空)',
            pnk: np.pnk,
            imageUrl: mainImage ?? '(无)',
          });
        }

        if (np.isRejected) {
          result.rejectedCount++;
          if (np.rejectionReason && !result.rejectedReasons.includes(np.rejectionReason)) {
            result.rejectedReasons.push(np.rejectionReason);
          }
          if (!result.rejectedSample) result.rejectedSample = { pnk: np.pnk, docErrors: np.rejectionReason || '' };
        }

        console.log(`🚀 [eMAG 同步] PNK=${np.pnk} 准备存入数据库的图片 URL: ${mainImage ?? '(null - 无图片)'}`);

        const data: Record<string, any> = {
          shopId: creds.shopId,
          pnk: np.pnk,
          vendorSku: np.vendorSku ?? undefined,
          sku: np.sku ?? undefined,
          ean: np.ean ?? undefined,
          emagOfferId: np.emagOfferId ?? undefined,
          name: np.name,
          salePrice: np.salePrice,
          currency: np.currency,
          stock: np.stock,
          status: np.status,
          categoryId: np.categoryId,
          imageUrl: mainImage ?? undefined,
          mainImage: mainImage ?? undefined,
          productUrl: np.productUrl ?? undefined,
          validationStatus: np.validationStatus,
          docErrors: np.docErrors ?? undefined,
          rejectionReason: np.rejectionReason,
        };

        const updateData: Record<string, any> = { ...data };
        if (mainImage) {
          updateData.imageUrl = mainImage;
          updateData.mainImage = mainImage;
        } else {
          delete updateData.imageUrl;
          delete updateData.mainImage;
        }

        await prisma.storeProduct.upsert({
          where: { shopId_pnk: { shopId: creds.shopId, pnk: np.pnk } },
          create: data as Prisma.StoreProductCreateInput,
          update: updateData as Prisma.StoreProductUpdateInput,
        });

        if (mainImage) {
          console.log(`[Global Pipeline] SKU: ${skuForLog} -> Valid Image: ${mainImage}`);
        }
        result.upserted++;
      } catch (e) {
        const pnk = o?.part_number_key ?? o?.part_number ?? o?.pnk ?? '(unknown)';
        const errMsg = e instanceof Error ? e.message : String(e);
        result.errors.push(`${pnk}: ${errMsg}`);
        console.error(`[storeProductSync] Skip broken item PNK=${pnk}:`, e);
      }
    }
  };

  // ─── 弹性分页拉取（Best-effort Delivery：连续失败 MAX_CONSECUTIVE_PAGE_FAILURES 页后安全中止）
  const fetchPage = async (extraFilters: Record<string, any> = {}) => {
    let page = 1;
    let consecutiveFailures = 0;
    while (true) {
      const filters: Record<string, any> = {
        currentPage: page,
        itemsPerPage: PAGE_SIZE,
        ...baseFilters,
        ...extraFilters,
      };

      const pageStart = Date.now();
      try {
        // ★ 传入产品专属超时（180s），不影响全局 DEFAULT_TIMEOUT_MS=60s
        const res = await readProductOffers(creds, filters, { timeout: PRODUCT_OFFER_TIMEOUT });
        const pageElapsed = Date.now() - pageStart;

        if (res.isError) {
          const msgs = res.messages?.join('; ') ?? JSON.stringify(res.errors ?? res).slice(0, 300);
          console.error(
            `[Product Sync] shop=${creds.shopId}(${creds.region}) Page ${page} API error (${pageElapsed}ms): ${msgs}`,
          );
          consecutiveFailures++;
        } else {
          const raw = res.results as any;
          const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
          const newBatch = batch.filter((o: any) => {
            const pnkKey = String(o?.part_number_key ?? o?.pnk ?? o?.part_number ?? '').trim();
            if (!o || !pnkKey || seenPnkKey.has(pnkKey)) return false;
            seenPnkKey.add(pnkKey);
            return true;
          });

          console.log(
            `[Product Sync] shop=${creds.shopId}(${creds.region}) Page ${page} ✅ ${newBatch.length} 条 (${pageElapsed}ms)` +
            `${modifiedAfter ? ` modified_after=${modifiedAfter}` : ''}`,
          );

          if (newBatch.length > 0) {
            result.totalFetched += newBatch.length;
            // ★ 立即 upsert，不等待后续页（Best-effort Delivery）
            await processBatch(newBatch);
            console.log(
              `[Product Sync] shop=${creds.shopId}(${creds.region}) Page ${page} 💾 已入库 (累计 ${result.upserted} 条)`,
            );
          }

          consecutiveFailures = 0;

          if (batch.length === 0 || newBatch.length === 0) break;
          if (batch.length < PAGE_SIZE) break;
        }
      } catch (e: any) {
        const pageElapsed = Date.now() - pageStart;
        console.error(
          `[Product Sync] shop=${creds.shopId}(${creds.region}) Page ${page} ❌ 网络异常 (${pageElapsed}ms): ${e?.message?.slice(0, 120) ?? e}`,
        );
        consecutiveFailures++;
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
        console.warn(
          `[Product Sync] shop=${creds.shopId}(${creds.region}) ⚠️ 连续 ${MAX_CONSECUTIVE_PAGE_FAILURES} 页失败，` +
          `安全中止（已入库 ${result.upserted} 条，尽最大努力交付）`,
        );
        break;
      }

      page++;
      if (page > 500) break;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  };

  await fetchPage(); // 先不传 status，拉取全部
  await new Promise((r) => setTimeout(r, DELAY_MS));
  await fetchPage({ validation_status: 8 }); // 强制拉取 validation_status=8 驳回产品
  await new Promise((r) => setTimeout(r, DELAY_MS));
  if (result.totalFetched === 0) {
    await fetchPage({ status: 1 });
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await fetchPage({ status: 0 });
  }

  console.log(
    `[storeProductSync] shop=${creds.shopId} ${modifiedAfter ? `增量 modified_after=${modifiedAfter}` : '全量'}，` +
    `第一阶段完成，已同步 ${result.upserted} 个产品（EAN 补图: ${result.eanImagesRecovered ?? 0}，跨页去重: ${seenPnkKey.size} 个 PNK）`,
  );

  // ─── 第二阶段：深层图片补全 (Deep Catalog Enrichment) ───
  try {
    const noImageProducts = await prisma.storeProduct.findMany({
      where: {
        shopId: creds.shopId,
        OR: [
          { mainImage: null },
          { mainImage: '' },
        ],
      },
      select: { pnk: true, sku: true, vendorSku: true },
    });

    const pnkList = noImageProducts.map((p) => p.pnk).filter(Boolean);
    if (pnkList.length > 0) {
      let totalFetched = 0;
      let totalUpdated = 0;
      for (let i = 0; i < pnkList.length; i += CATALOG_BATCH_SIZE) {
        const batch = pnkList.slice(i, i + CATALOG_BATCH_SIZE);
        await new Promise((r) => setTimeout(r, CATALOG_DELAY_MS));
        let res = await readProductsByPnk(creds, batch);
        if (res.isError) {
          const msgs = res.messages?.join('; ') ?? '未知';
          if (/404|not found|resource/i.test(msgs)) {
            console.warn(`[Deep Sync] Shop: ${creds.region}, product/read 接口不可用（可能需 API 升级），跳过: ${msgs}`);
          } else {
            console.warn(`[Deep Sync] Shop: ${creds.region}, product/read 批次失败: ${msgs}`);
          }
          continue;
        }
        if (!res.results) continue;
        const items = Array.isArray(res.results) ? res.results : (res.results as any)?.items ?? (res.results as any)?.results ?? [];
        totalFetched += items.length;
        let batchUpdated = 0;
        for (const raw of items) {
          const np = normalizeEmagProduct(raw as Record<string, unknown>, creds.region, { logOutput: false });
          if (!np.pnk || !np.mainImage) continue;
          await prisma.storeProduct.updateMany({
            where: { shopId: creds.shopId, pnk: np.pnk },
            data: { mainImage: np.mainImage, imageUrl: np.mainImage },
          });
          batchUpdated++;
          const skuDisplay = np.sku ?? np.vendorSku ?? np.pnk;
          console.log(`[Global Pipeline] SKU: ${skuDisplay} -> Valid Image: ${np.mainImage}`);
        }
        totalUpdated += batchUpdated;
        console.log(`[Deep Sync] Shop: ${creds.region}, Fetched details for ${batch.length} SKUs. Updated ${batchUpdated} images.`);
      }
      result.deepSyncImagesUpdated = totalUpdated;
      console.log(`[Deep Sync] Shop: ${creds.region}, Fetched details for ${totalFetched} products. Updated ${totalUpdated} images.`);
    } else {
      console.log(`[Deep Sync] Shop: ${creds.region}, 无需要补图的产品，跳过 Catalog 调用`);
    }
  } catch (deepErr: any) {
    console.warn(`[Deep Sync] Shop: ${creds.region}, Catalog 补图失败（不影响主同步）:`, deepErr?.message ?? deepErr);
    result.errors.push(`Deep Sync: ${deepErr?.message ?? String(deepErr)}`);
  }

  const saved = await prisma.storeProduct.findMany({
    where: { shopId: creds.shopId },
    orderBy: { id: 'asc' },
    take: 5,
    select: {
      id: true, pnk: true, sku: true, ean: true, vendorSku: true, name: true, salePrice: true, stock: true,
      mainImage: true, imageUrl: true, emagOfferId: true, validationStatus: true,
      status: true, docErrors: true, rejectionReason: true,
    },
  });
  console.log(`\n[同步结果] 前 5 个产品 raw:`);
  firstFiveRaw.forEach((p, i) => {
    console.log(`  ${i + 1}. { PN: ${p.pn}, PNK: ${p.pnk}, ImageURL: ${p.imageUrl} }`);
  });
  console.log(`\n[数据库实据] 前 5 个产品已写入:`);
  saved.forEach((p, i) => {
    console.log(`  ${i + 1}. { PN: ${p.vendorSku ?? '(空)'}, PNK: ${p.pnk}, ImageURL: ${p.mainImage ?? '(无)'} }`);
  });
  const apiShape = saved.map((p) => {
    const v = p.validationStatus ?? (p.status === 1 ? 'active' : 'rejected');
    const validationStatusDisplay = v === 'rejected' || v === 'inactive' ? '已驳回' : '已通过';
    const displayName = p.name || (validationStatusDisplay === '已驳回' ? '待更新' : '待完善');
    const salePriceNum = Number(p.salePrice);
    const stockNum = p.stock;
    const isRejected = validationStatusDisplay === '已驳回';
    return {
      id: p.id,
      pnk: p.pnk,
      sku: p.sku ?? null,
      ean: p.ean ?? null,
      image: p.mainImage ?? p.imageUrl ?? null,
      main_image: p.mainImage ?? p.imageUrl ?? null,
      name: displayName,
      vendor_sku: p.vendorSku ?? null,
      emagOfferId: p.emagOfferId,
      sale_price: salePriceNum,
      sale_price_display: isRejected && salePriceNum === 0 ? '待更新' : salePriceNum,
      stock: stockNum,
      stock_display: isRejected && stockNum === 0 ? '待更新' : stockNum,
      validation_status: validationStatusDisplay,
      doc_errors: p.docErrors ?? null,
      rejection_reason: p.rejectionReason ?? null,
    };
  });
  console.log(`\n[API 结构] 前 5 个产品最终返回 JSON:`);
  apiShape.forEach((item, i) => {
    console.log(`  --- 产品 ${i + 1} ---`);
    console.log(JSON.stringify(item, null, 2));
  });
  const sample = apiShape[0];
  if (sample) {
    console.log(`\n[验证] 完整产品对象示例:`);
    console.log(JSON.stringify(sample, null, 2));
  }
  console.log('');

  return result;
}

/**
 * 补齐 product_url — 遍历 product_url 为 null 的产品，从 eMAG API 或构造链接并保存
 */
export async function backfillProductUrls(): Promise<{ updated: number; total: number; errors: string[] }> {
  const products = await prisma.storeProduct.findMany({
    where: { productUrl: null },
    select: { id: true, pnk: true, name: true, shopId: true, shop: { select: { shopName: true } } },
  });

  const result = { updated: 0, total: products.length, errors: [] as string[] };
  if (products.length === 0) {
    console.log('[backfillProductUrls] 无 product_url 为 null 的产品');
    return result;
  }

  const byShop = new Map<number, typeof products>();
  for (const p of products) {
    const list = byShop.get(p.shopId) ?? [];
    list.push(p);
    byShop.set(p.shopId, list);
  }

  for (const [shopId, list] of byShop) {
    try {
      const creds = await getEmagCredentials(shopId);
      const domain = REGION_DOMAIN[creds.region];

      const pnkSet = new Set(list.map((p) => p.pnk));
      const apiUrlMap = new Map<string, string>();
      let page = 1;
      while (true) {
        const pageStart = Date.now();
        const res = await readProductOffers(creds, { currentPage: page, itemsPerPage: PAGE_SIZE }, { timeout: PRODUCT_OFFER_TIMEOUT });
        console.log(`[Product Sync] backfillUrls shop=${shopId} Page ${page} fetched in ${Date.now() - pageStart}ms`);
        if (res.isError) {
          const msgs = res.messages?.join('; ') ?? 'API 返回错误';
          throw new Error(`[EMAG API ERROR] Shop: ${creds.region}, backfillProductUrls 失败: ${msgs}`);
        }
        const raw = res.results as any;
        const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
        if (batch.length === 0) break;
        for (const o of batch) {
          const pnk = String(o?.part_number_key ?? o?.pnk ?? o?.part_number ?? '').trim();
          if (!pnk || !pnkSet.has(pnk)) continue;
          const u = o.url ?? o.product_url ?? o.link ?? o.product_link ?? o.page_url ?? o.product_page ?? o.links?.view;
          let url: string;
          if (typeof u === 'string' && u.trim()) {
            url = u.trim();
          } else {
            const name = String(o.name ?? o.title ?? '').trim();
            const slug = name ? slugifyProductName(name) : 'product';
            url = `https://www.${domain}/${slug}/pd/${pnk}/`;
          }
          apiUrlMap.set(pnk, url);
        }
        if (batch.length < PAGE_SIZE) break;
        page++;
        if (page > 50) break;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }

      for (const p of list) {
        let url = apiUrlMap.get(p.pnk);
        if (!url) {
          const name = (p.name ?? '').trim();
          const slug = name ? slugifyProductName(name) : 'product';
          url = `https://www.${domain}/${slug}/pd/${p.pnk}/`;
        }
        await prisma.storeProduct.update({
          where: { id: p.id },
          data: { productUrl: url },
        });
        result.updated++;
        console.log(`[backfillProductUrls] SKU: ${p.pnk} -> URL: ${url}`);
      }
    } catch (e) {
      result.errors.push(`shopId=${shopId}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[backfillProductUrls] shopId=${shopId} 失败:`, e);
    }
  }

  return result;
}

/**
 * 批量补齐 main_image — 遍历 main_image 为空或占位图的产品，从 API 重新获取并更新
 * 来源优先级: main_url > images 数组(过滤 logo/placeholder/svg/temporary-images) > description HTML > EAN API
 */
export async function backfillProductImages(): Promise<{ updated: number; total: number; errors: string[] }> {
  const products = await prisma.storeProduct.findMany({
    where: {
      OR: [
        { mainImage: null },
        { mainImage: '' },
      ],
    },
    select: { id: true, pnk: true, sku: true, ean: true, shopId: true },
  });

  const result = { updated: 0, total: products.length, errors: [] as string[] };
  if (products.length === 0) {
    console.log('[backfillProductImages] 无需要补齐图片的产品');
    return result;
  }

  const byShop = new Map<number, typeof products>();
  for (const p of products) {
    const list = byShop.get(p.shopId) ?? [];
    list.push(p);
    byShop.set(p.shopId, list);
  }

  for (const [shopId, list] of byShop) {
    try {
      const creds = await getEmagCredentials(shopId);
      const pnkSet = new Set(list.map((p) => p.pnk));
      const apiImageMap = new Map<string, string>();
      let page = 1;
      while (true) {
        const pageStart = Date.now();
        const res = await readProductOffers(creds, { currentPage: page, itemsPerPage: PAGE_SIZE }, { timeout: PRODUCT_OFFER_TIMEOUT });
        console.log(`[Product Sync] backfillImages shop=${shopId} Page ${page} fetched in ${Date.now() - pageStart}ms`);
        if (res.isError) {
          const msgs = res.messages?.join('; ') ?? 'API 返回错误';
          throw new Error(`[EMAG API ERROR] Shop: ${creds.region}, backfillProductImages 失败: ${msgs}`);
        }
        const raw = res.results as any;
        const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
        if (batch.length === 0) break;
        for (const o of batch) {
          const np = normalizeEmagProduct(o as Record<string, unknown>, creds.region, { logOutput: false });
          const pnk = np.pnk;
          if (!pnk || !pnkSet.has(pnk) || apiImageMap.has(pnk)) continue;
          if (np.mainImage) apiImageMap.set(pnk, np.mainImage);
        }
        if (batch.length < PAGE_SIZE) break;
        page++;
        if (page > 50) break;
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }

      const noImageFromApi = list.filter((p) => !apiImageMap.has(p.pnk));
      const eanToProducts = new Map<string, Array<{ id: number; pnk: string }>>();
      for (const p of noImageFromApi) {
        const eans = String(p.ean ?? '').split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
        const firstEan = eans[0];
        if (firstEan) {
          const arr = eanToProducts.get(firstEan) ?? [];
          arr.push({ id: p.id, pnk: p.pnk });
          eanToProducts.set(firstEan, arr);
        }
      }
      const uniqueEans = [...eanToProducts.keys()];
      if (uniqueEans.length > 0) {
        try {
          for (let i = 0; i < uniqueEans.length; i += EAN_BATCH_SIZE) {
            const batch = uniqueEans.slice(i, i + EAN_BATCH_SIZE);
            await new Promise((r) => setTimeout(r, EAN_DELAY_MS));
            const res = await findDocumentationByEans(creds, batch);
            if (!res.isError && res.results) {
              const items = Array.isArray(res.results) ? res.results : (res.results as any)?.items ?? [];
              for (const item of items) {
                const ean = item?.ean ?? item?.EAN ?? item?.ean_code;
                const img = item?.product_image ?? item?.productImage ?? item?.image ?? item?.main_image;
                if (ean && typeof img === 'string' && img.trim()) {
                  const eanStr = String(ean).trim();
                  for (const prod of eanToProducts.get(eanStr) ?? []) {
                    apiImageMap.set(prod.pnk, img.trim());
                  }
                }
              }
            }
          }
        } catch (eanErr: any) {
          console.warn('[backfillProductImages] EAN 补图接口跳过:', eanErr?.message ?? eanErr);
        }
      }

      for (const p of list) {
        const img = apiImageMap.get(p.pnk);
        const skuDisplay = p.sku ?? p.pnk;
        if (img) {
          await prisma.storeProduct.update({
            where: { id: p.id },
            data: { mainImage: img, imageUrl: img },
          });
          result.updated++;
          console.log(`[Global Pipeline] SKU: ${skuDisplay} -> Valid Image: ${img}`);
        } else {
          console.log(`[Global Pipeline] SKU: ${skuDisplay} -> (无有效图)`);
        }
      }
    } catch (e) {
      result.errors.push(`shopId=${shopId}: ${e instanceof Error ? e.message : String(e)}`);
      console.error('[backfillProductImages] shopId=' + shopId, e);
    }
  }
  return result;
}

/**
 * 回填综合日销 — 从 platform_orders 聚合 7/14/30 日销量，计算综合日销并写入 store_products.comprehensive_sales
 * 公式: (d7/7 * 0.3) + (d14/14 * 0.3) + (d30/30 * 0.4)
 * 支持全量回填（不传 shopId）或指定店铺回填（传 shopId）
 */
export async function backfillComprehensiveSales(shopId?: number): Promise<{ updated: number; errors: string[] }> {
  const result = { updated: 0, errors: [] as string[] };

  const now = new Date();
  const d7Date = new Date(now); d7Date.setDate(d7Date.getDate() - 7);
  const d14Date = new Date(now); d14Date.setDate(d14Date.getDate() - 14);
  const d30Date = new Date(now); d30Date.setDate(d30Date.getDate() - 30);

  const shopWhere = shopId != null ? `AND po.shop_id = ${shopId}` : '';
  const skuExpr = `LOWER(TRIM(REPLACE(REPLACE(COALESCE(elem->>'sku', elem->>'ext_part_number', ''), E'\\r', ''), E'\\n', '')))`;
  const qtyExpr = `COALESCE((elem->>'quantity')::int, 0)`;
  const baseStatus = `po.status IN (1,2,3,4)`;

  try {
    // 聚合三个时间段的销量
    const [d7Rows, d14Rows, d30Rows] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ shop_id: number; sku: string; total: string }>>(
        `SELECT po.shop_id, ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders po, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseStatus} AND po.order_time >= '${d7Date.toISOString().slice(0, 10)}' ${shopWhere} GROUP BY po.shop_id, 2`
      ),
      prisma.$queryRawUnsafe<Array<{ shop_id: number; sku: string; total: string }>>(
        `SELECT po.shop_id, ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders po, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseStatus} AND po.order_time >= '${d14Date.toISOString().slice(0, 10)}' ${shopWhere} GROUP BY po.shop_id, 2`
      ),
      prisma.$queryRawUnsafe<Array<{ shop_id: number; sku: string; total: string }>>(
        `SELECT po.shop_id, ${skuExpr} as sku, SUM(${qtyExpr}) as total FROM platform_orders po, jsonb_array_elements(products_json::jsonb) as elem WHERE ${baseStatus} AND po.order_time >= '${d30Date.toISOString().slice(0, 10)}' ${shopWhere} GROUP BY po.shop_id, 2`
      ),
    ]);

    // 按 shopId+sku 建立销量 Map
    type SalesKey = string; // `${shopId}:${sku}`
    const salesMap = new Map<SalesKey, { d7: number; d14: number; d30: number }>();
    const mergeRows = (rows: Array<{ shop_id: number; sku: string; total: string }>, key: 'd7' | 'd14' | 'd30') => {
      for (const r of rows) {
        const k: SalesKey = `${r.shop_id}:${r.sku}`;
        const s = salesMap.get(k) ?? { d7: 0, d14: 0, d30: 0 };
        s[key] = Number(r.total) || 0;
        salesMap.set(k, s);
      }
    };
    mergeRows(d7Rows, 'd7');
    mergeRows(d14Rows, 'd14');
    mergeRows(d30Rows, 'd30');

    // 查出所有需要回填的产品（sku 和 vendorSku 都要尝试匹配）
    const products = await prisma.storeProduct.findMany({
      where: shopId != null ? { shopId } : {},
      select: { id: true, shopId: true, sku: true, vendorSku: true },
    });

    const BATCH = 200;
    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);
      await Promise.all(batch.map(async (p) => {
        const keys = new Set(
          [p.sku, p.vendorSku]
            .filter(Boolean)
            .map((s) => s!.trim().toLowerCase())
        );
        let d7 = 0, d14 = 0, d30 = 0;
        for (const sku of keys) {
          const k: SalesKey = `${p.shopId}:${sku}`;
          const s = salesMap.get(k);
          if (s) { d7 += s.d7; d14 += s.d14; d30 += s.d30; }
        }
        const compSales = parseFloat(((d7 / 7) * 0.3 + (d14 / 14) * 0.3 + (d30 / 30) * 0.4).toFixed(2));
        await prisma.storeProduct.update({
          where: { id: p.id },
          data: { comprehensiveSales: compSales },
        });
        result.updated++;
      }));
    }

    console.log(`[backfillComprehensiveSales] 完成，共更新 ${result.updated} 条产品综合日销`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(msg);
    console.error('[backfillComprehensiveSales] 失败:', msg);
  }

  return result;
}
