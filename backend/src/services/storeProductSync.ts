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
import { resolveStockSignalsForSync } from './firstAvailableAt';
import { EmagCredentials, getEmagCredentials, REGION_DOMAIN } from './emagClient';
import { readProductOffers, findDocumentationByEans, readProductsByPnk } from './emagProduct';
import { normalizeEmagProduct, slugifyProductName } from './emagProductNormalizer';
import { getSalesForProduct, getSalesStatsByShop } from './salesStats';
import { calculateComprehensiveSales, classifyStoreProduct } from './productClassification';
import {
  inferContentPermission,
  inferEmagLinkType,
  inferLinkActionTips,
  inferOfferCompetition,
  resolveEffectiveBrandForSync,
  resolveEffectiveOwnershipForSync,
} from './emagLinkType';
import { inferBuyBoxStatus } from './emagBuyBox';

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

function normalizeBusinessKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

function buildStoreProductIdentityWhere(
  shopId: number,
  np: ReturnType<typeof normalizeEmagProduct>,
): Prisma.StoreProductWhereInput {
  const or: Prisma.StoreProductWhereInput[] = [];
  const emagOfferId = normalizeBusinessKey(np.emagOfferId);
  const sku = normalizeBusinessKey(np.sku);
  const vendorSku = normalizeBusinessKey(np.vendorSku);
  const ean = normalizeBusinessKey(np.ean);

  if (emagOfferId) or.push({ emagOfferId });
  if (sku) or.push({ sku });
  if (vendorSku) or.push({ vendorSku });
  if (ean) or.push({ ean });
  if (np.pnk) or.push({ pnk: np.pnk });

  return {
    shopId,
    isArchived: false,
    OR: or,
  };
}

async function saveStoreProductByBusinessIdentity(
  shopId: number,
  np: ReturnType<typeof normalizeEmagProduct>,
  data: Prisma.StoreProductUncheckedCreateInput,
  updateData: Prisma.StoreProductUpdateInput,
): Promise<void> {
  const identityWhere = buildStoreProductIdentityWhere(shopId, np);
  const existing = await prisma.storeProduct.findFirst({
    where: identityWhere,
    orderBy: [
      { mappedInventorySku: 'desc' },
      { syncedAt: 'desc' },
      { id: 'desc' },
    ],
    select: {
      id: true,
      pnk: true,
      firstAvailableAt: true,
      firstInboundAt: true,
      firstStockSignalAt: true,
    },
  });

  if (existing) {
    if (existing.pnk !== np.pnk) {
      console.log(
        `[StoreProduct Identity] shop=${shopId} SKU=${np.sku ?? np.vendorSku ?? '(none)'} ` +
        `Offer=${np.emagOfferId ?? '(none)'} PNK ${existing.pnk} -> ${np.pnk}`,
      );
    }
    const signalPatch = resolveStockSignalsForSync(np.stock, 0, existing);
    await prisma.storeProduct.update({
      where: { id: existing.id },
      data: {
        ...updateData,
        ...signalPatch,
      },
    });
    return;
  }

  const createSignalPatch = resolveStockSignalsForSync(np.stock, 0, {});
  await prisma.storeProduct.create({
    data: {
      ...data,
      ...createSignalPatch,
    },
  });
}

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

    // 批量预取本页已有记录，避免逐条查 DB（brand/ownership merge 用）
    const normalizedBatch: Array<{ raw: Record<string, unknown>; np: ReturnType<typeof normalizeEmagProduct> }> = [];
    for (const o of batch) {
      const np = normalizeEmagProduct(o as Record<string, unknown>, creds.region, {
        logOutput: pipelineLogCount < PIPELINE_LOG_LIMIT,
      });
      if (pipelineLogCount < PIPELINE_LOG_LIMIT) pipelineLogCount++;
      if (!np.pnk) continue;
      normalizedBatch.push({ raw: o as Record<string, unknown>, np });
    }

    const existingByPnk = new Map<string, {
      id: number;
      pnk: string;
      shopId: number;
      emagLinkType: string | null;
      emagLinkTypeConfidence: string | null;
      emagOwnership: unknown;
      emagOfferMeta: unknown;
    }>();
    if (normalizedBatch.length > 0) {
      const existingRows = await prisma.storeProduct.findMany({
        where: {
          shopId: creds.shopId,
          isArchived: false,
          pnk: { in: normalizedBatch.map(({ np }) => np.pnk) },
        },
        select: {
          id: true,
          pnk: true,
          shopId: true,
          emagLinkType: true,
          emagLinkTypeConfidence: true,
          emagOwnership: true,
          emagOfferMeta: true,
        },
      });
      for (const row of existingRows) {
        existingByPnk.set(row.pnk, row);
      }
    }

    // 逐条 upsert（brand/ownership 已与 DB 合并）
    for (const { np } of normalizedBatch) {
      try {
        const existing = existingByPnk.get(np.pnk);
        const { effectiveBrand, brandSource } = resolveEffectiveBrandForSync(np.brand, existing?.emagOfferMeta);
        const effectiveOwnership = resolveEffectiveOwnershipForSync(np.ownership, existing?.emagOwnership);

        // 引擎一（JSON）+ 引擎二（EAN API）合并
        const firstEan = np.ean ? String(np.ean).split(/[,\s]+/)[0]?.trim() : null;
        const eanImage = firstEan ? eanToImage.get(firstEan) ?? null : null;
        const mainImage: string | null = np.mainImage ?? eanImage;
        if (eanImage && !np.mainImage) result.eanImagesRecovered!++;

        const skuForLog = np.sku ?? np.vendorSku ?? np.pnk;
        const linkTypeResult = inferEmagLinkType({
          shopId: creds.shopId,
          pnk: np.pnk,
          rawApiData: { ownership: effectiveOwnership, brand: effectiveBrand },
          publishLog: null,
        });
        const contentPermission = inferContentPermission(linkTypeResult.linkType);
        const offerCompetition = inferOfferCompetition({ numberOfOffers: np.numberOfOffers });
        const linkActionTips = inferLinkActionTips(linkTypeResult.linkType, offerCompetition.offerCompetitionType);
        const buyBoxResult = inferBuyBoxStatus({
          buyButtonRank: np.buyButtonRank,
          salePrice: np.salePrice,
          bestOfferSalePrice: np.bestOfferSalePrice,
          mainOfferPrice: np.mainOfferPrice,
          stock: np.stock,
          status: np.status,
          offerValidationStatus: np.offerValidationStatus,
          numberOfOffers: np.numberOfOffers,
        });
        const compactOfferMeta = {
          ownership: effectiveOwnership,
          brand: effectiveBrand,
          brandSource,
          linkTypeReason: linkTypeResult.linkTypeReason,
          numberOfOffers: np.numberOfOffers,
          bestOfferSalePrice: np.bestOfferSalePrice,
          mainOfferPrice: np.mainOfferPrice,
          buyButtonRank: np.buyButtonRank,
          partNumberKey: np.pnk,
        };
        const buyBoxMeta = {
          buyButtonRank: np.buyButtonRank,
          salePrice: np.salePrice,
          bestOfferSalePrice: np.bestOfferSalePrice,
          mainOfferPrice: np.mainOfferPrice,
          stock: np.stock,
          offerValidationStatus: np.offerValidationStatus,
          numberOfOffers: np.numberOfOffers,
          checkedAt: new Date().toISOString(),
        };

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
          emagLinkType: linkTypeResult.linkType,
          emagLinkTypeSource: linkTypeResult.linkTypeSource,
          emagLinkTypeConfidence: linkTypeResult.linkTypeConfidence,
          emagOwnership: effectiveOwnership === undefined || effectiveOwnership === null
            ? Prisma.JsonNull
            : effectiveOwnership as Prisma.InputJsonValue,
          contentPermission: contentPermission.contentPermission,
          numberOfOffers: offerCompetition.numberOfOffers,
          offerCompetitionType: offerCompetition.offerCompetitionType,
          buyButtonRank: np.buyButtonRank,
          bestOfferSalePrice: np.bestOfferSalePrice,
          mainOfferPrice: np.mainOfferPrice,
          linkActionTips: linkActionTips as Prisma.InputJsonValue,
          emagOfferMeta: compactOfferMeta as Prisma.InputJsonValue,
          buyBoxStatus: buyBoxResult.buyBoxStatus,
          buyBoxStatusSource: buyBoxResult.buyBoxStatusSource,
          buyBoxStatusConfidence: buyBoxResult.buyBoxStatusConfidence,
          buyBoxRank: buyBoxResult.buyBoxRank,
          buyBoxActionTips: buyBoxResult.buyBoxActionTips as Prisma.InputJsonValue,
          buyBoxMeta: buyBoxMeta as Prisma.InputJsonValue,
          isArchived: false,
        };

        const updateData: Record<string, any> = { ...data };
        if (mainImage) {
          updateData.imageUrl = mainImage;
          updateData.mainImage = mainImage;
        } else {
          delete updateData.imageUrl;
          delete updateData.mainImage;
        }

        await saveStoreProductByBusinessIdentity(
          creds.shopId,
          np,
          data as Prisma.StoreProductUncheckedCreateInput,
          updateData as Prisma.StoreProductUpdateInput,
        );

        if (mainImage) {
          console.log(`[Global Pipeline] SKU: ${skuForLog} -> Valid Image: ${mainImage}`);
        }
        result.upserted++;
      } catch (e) {
        const pnk = np.pnk ?? '(unknown)';
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
        isArchived: false,
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
            where: { shopId: creds.shopId, pnk: np.pnk, isArchived: false },
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
    where: { shopId: creds.shopId, isArchived: false },
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
    where: { productUrl: null, isArchived: false },
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
      isArchived: false,
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
 * 回填综合日销与分类缓存。
 *
 * 前台列表/卡片以实时计算为准；这里仅刷新旧落库字段，作为排序、历史兼容和后台诊断缓存。
 */
export async function backfillComprehensiveSales(shopId?: number): Promise<{ updated: number; errors: string[] }> {
  const result = { updated: 0, errors: [] as string[] };

  try {
    const shops = shopId != null
      ? [{ id: shopId }]
      : await prisma.shopAuthorization.findMany({
          where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
          select: { id: true },
          orderBy: { id: 'asc' },
        });

    const BATCH = 200;
    for (const shop of shops) {
      const salesStats = await getSalesStatsByShop(shop.id, true);
      const products = await prisma.storeProduct.findMany({
        where: { shopId: shop.id, isArchived: false },
        select: {
          id: true,
          pnk: true,
          sku: true,
          vendorSku: true,
          mappedInventorySku: true,
          stock: true,
          syncedAt: true,
          mainImage: true,
          imageUrl: true,
          estimatedProfit: true,
        },
      });

      for (let i = 0; i < products.length; i += BATCH) {
        const batch = products.slice(i, i + BATCH);
        await Promise.all(batch.map(async (p) => {
          const sales = getSalesForProduct(salesStats.map, p.sku, p.vendorSku, p.pnk);
          const compSales = calculateComprehensiveSales(sales, p.stock);
          const classified = classifyStoreProduct({
            stock: p.stock,
            syncedAt: p.syncedAt,
            mappedInventorySku: p.mappedInventorySku,
            mainImage: p.mainImage,
            imageUrl: p.imageUrl,
            estimatedProfit: p.estimatedProfit != null ? Number(p.estimatedProfit) : null,
          }, sales);

          await prisma.storeProduct.update({
            where: { id: p.id },
            data: {
              comprehensiveSales: compSales,
              productClass: classified.productClass,
              classificationReason: classified.reason,
              classificationMetrics: { ...classified.metrics, riskTags: classified.riskTags } as Prisma.InputJsonValue,
              classifiedAt: new Date(),
            },
          });
          result.updated++;
        }));
      }
    }

    console.log(`[backfillComprehensiveSales] 完成，共更新 ${result.updated} 条产品综合日销`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(msg);
    console.error('[backfillComprehensiveSales] 失败:', msg);
  }

  return result;
}
