/**
 * 店铺初始化同步 — 从 eMAG product_offer/read 拉取全部产品到 StoreProduct 表
 *
 * 数据源: 仅 eMAG API，与公海 Product 表完全分离
 * 限流: 3 req/sec (product_offer 路由)
 * 包含: 在售(status=1)、驳回(status=0)等全部状态，强制抓取 doc_errors
 */

import { prisma } from '../lib/prisma';
import { EmagCredentials } from './emagClient';
import { readProductOffers, findDocumentationByEans } from './emagProduct';
import type { EmagProductOffer } from './emagProduct';

const PAGE_SIZE = 100;
const DELAY_MS = 350; // 3 req/sec (product_offer)
const EAN_BATCH_SIZE = 100;
const EAN_DELAY_MS = 200; // 5 req/sec (documentation/find_by_eans)
const PLACEHOLDER = '待完善';
const PENDING_UPDATE = '待更新';

export interface SyncResult {
  shopId: number;
  totalFetched: number;
  upserted: number;
  errors: string[];
  rejectedCount: number;
  rejectedReasons: string[];
  rejectedSample?: { pnk: string; docErrors: string };
  eanImagesRecovered?: number;
}

/**
 * 分页拉取店铺全部产品（含已驳回），强制抓取 doc_errors
 */
export async function syncStoreProducts(creds: EmagCredentials): Promise<SyncResult> {
  const result: SyncResult = { shopId: creds.shopId, totalFetched: 0, upserted: 0, errors: [], rejectedCount: 0, rejectedReasons: [] };

  const allOffers: any[] = [];
  const seenPnkKey = new Set<string>();

  const fetchPage = async (extraFilters: Record<string, any> = {}) => {
    let page = 1;
    while (true) {
      const filters: Record<string, any> = {
        currentPage: page,
        itemsPerPage: PAGE_SIZE,
        ...extraFilters,
      };

      const res = await readProductOffers(creds, filters);
      if (res.isError) return;
      const raw = res.results as any;
      const batch = Array.isArray(raw) ? raw : (raw?.items ?? raw?.results ?? []);
      if (batch.length === 0) break;
      for (const o of batch) {
        const pnkKey = String(o?.part_number_key ?? o?.pnk ?? o?.part_number ?? '').trim();
        if (o && pnkKey) {
          if (!seenPnkKey.has(pnkKey)) {
            seenPnkKey.add(pnkKey);
            allOffers.push(o);
          }
        }
      }
      if (batch.length < PAGE_SIZE) break;
      page++;
      if (page > 500) break;
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  };

  await fetchPage(); // 先不传 status，拉取全部
  await new Promise((r) => setTimeout(r, DELAY_MS));
  await fetchPage({ validation_status: 8 }); // 强制拉取 validation_status=8 驳回产品
  await new Promise((r) => setTimeout(r, DELAY_MS));
  if (allOffers.length === 0) {
    await fetchPage({ status: 1 });
    await new Promise((r) => setTimeout(r, DELAY_MS));
    await fetchPage({ status: 0 });
  }
  result.totalFetched = allOffers.length;

  await prisma.storeProduct.deleteMany({ where: { shopId: creds.shopId } });
  console.log(`[storeProductSync] shop=${creds.shopId} 已清空旧数据，开始覆盖更新 ${allOffers.length} 个产品`);

  const firstFiveRaw: Array<{ pn: string; pnk: string; imageUrl: string }> = [];
  for (const o of allOffers) {
    try {
      const pnk = String(o.part_number_key ?? o.pnk ?? o.part_number ?? '').trim();
      const sku = o.part_number != null ? String(o.part_number).trim() : null;
      const vendorSku = sku;
      const eanRaw = o.ean;
      const ean = Array.isArray(eanRaw) && eanRaw.length > 0
        ? (eanRaw.map((x: any) => (typeof x === 'string' ? x : x?.value ?? x?.ean ?? String(x))).filter(Boolean).join(', ') || null)
        : (typeof eanRaw === 'string' && eanRaw.trim() ? eanRaw.trim() : null);
      if (!pnk) continue;

      const mainImageUrl = (() => {
        const imgs = o.images;
        if (!Array.isArray(imgs) || imgs.length === 0) return null;
        const main = imgs.find((img: any) => img?.display_type === 1 || img?.display_type === '1' || img?.displayType === 1);
        const url = main?.url ?? imgs[0]?.url;
        return typeof url === 'string' ? url.trim() : null;
      })();
      if (firstFiveRaw.length < 5) {
        firstFiveRaw.push({
          pn: vendorSku ?? o.part_number ?? '(空)',
          pnk,
          imageUrl: mainImageUrl ?? '(无)',
        });
      }

      const vsRaw = o.validation_status ?? o.offer_validation_status;
      const vsArr = Array.isArray(vsRaw) ? vsRaw : (vsRaw ? [vsRaw] : []);
      const transVsRaw = o.translation_validation_status;
      const transVsArr = Array.isArray(transVsRaw) ? transVsRaw : (transVsRaw ? [transVsRaw] : []);
      const offerVs = o.offer_validation_status;
      const offerVsArr = Array.isArray(offerVs) ? offerVs : (offerVs ? [offerVs] : []);

      const extractMsg = (e: any): string => {
        if (typeof e === 'string') return e;
        return e?.message ?? e?.error ?? e?.description ?? e?.field ?? e?.text
          ?? (e?.code ? `[${e.code}] ${e.message || e.description || e.detail || ''}`.trim() : '')
          ?? (e?.details ? (Array.isArray(e.details) ? e.details.map(extractMsg).join('; ') : String(e.details)) : '')
          ?? JSON.stringify(e);
      };
      const collectErrorsFromArr = (arr: any[]): string[] => {
        const msgs: string[] = [];
        for (const v of arr) {
          if (!v || typeof v !== 'object') continue;
          const errs = v.errors ?? v.doc_errors ?? v.docErrors ?? v.messages ?? v.documents;
          if (Array.isArray(errs)) {
            for (const e of errs) {
              const m = extractMsg(e);
              if (m && m !== '{}') msgs.push(m);
            }
          } else if (typeof errs === 'string') msgs.push(errs);
          else if (errs && typeof errs === 'object' && !Array.isArray(errs)) {
            const m = extractMsg(errs);
            if (m && m !== '{}') msgs.push(m);
          }
        }
        return msgs;
      };

      const docErrorsTop = o.doc_errors ?? o.docErrors;
      const docErrorsFromVs = collectErrorsFromArr(vsArr);
      const docErrorsFromTrans = collectErrorsFromArr(transVsArr);
      const docErrorsFromOffer = collectErrorsFromArr(offerVsArr);
      const docErrorsFromTop = Array.isArray(docErrorsTop)
        ? docErrorsTop.map((e: any) => typeof e === 'string' ? e : (e?.message ?? e?.error ?? e?.description ?? e?.field ?? JSON.stringify(e)))
        : (typeof docErrorsTop === 'string' ? [docErrorsTop] : []);

      const allErrorMsgs = [...new Set([...docErrorsFromTop, ...docErrorsFromVs, ...docErrorsFromTrans, ...docErrorsFromOffer])].filter(Boolean);
      const mergedRejectionReason = allErrorMsgs.length > 0 ? allErrorMsgs.join('; ') : null;

      let vsValue: any = null;
      let vsDesc: string | null = null;
      for (const v of vsArr) {
        const val = typeof v === 'object' && v ? (v as any).value : v;
        vsValue = val;
        vsDesc = typeof v === 'object' && v ? (v as any).description : null;
        if (val === 8 || val === '8') break;
      }
      let transRejected = false;
      for (const v of transVsArr) {
        const val = typeof v === 'object' && v ? (v as any).value : v;
        if (val === 8 || val === '8') {
          transRejected = true;
          break;
        }
      }
      let offerRejected = false;
      for (const v of offerVsArr) {
        const val = typeof v === 'object' && v ? (v as any).value : v;
        if (val === 0 || val === '0' || val === 8 || val === '8') {
          offerRejected = true;
          break;
        }
      }

      const isRejected = vsValue === 8 || vsValue === '8' || transRejected || (offerRejected && allErrorMsgs.length > 0);
      const isApproved = vsValue === 9 || vsValue === '9' && !transRejected;
      const fallbackText = isRejected ? PENDING_UPDATE : PLACEHOLDER;

      const rejectionReason = isRejected ? (mergedRejectionReason || vsDesc || '已驳回') : null;
      const docErrors = isRejected ? mergedRejectionReason : null;

      if (isRejected) {
        result.rejectedCount++;
        if (rejectionReason && !result.rejectedReasons.includes(rejectionReason)) {
          result.rejectedReasons.push(rejectionReason);
        }
        console.log(`\n========== [eMAG 已驳回产品] PNK=${pnk} ==========`);
        console.log(`  rejection_reason: ${rejectionReason || '(无)'}`);
        console.log(`  validation_status 原始 JSON:`);
        console.log(JSON.stringify(o.validation_status, null, 2));
        if (o.translation_validation_status) {
          console.log(`  translation_validation_status 原始 JSON:`);
          console.log(JSON.stringify(o.translation_validation_status, null, 2));
        }
        if (o.doc_errors || o.docErrors) {
          console.log(`  doc_errors 原始:`, JSON.stringify(o.doc_errors ?? o.docErrors, null, 2));
        }
        console.log(`  合并后错误词条: ${allErrorMsgs.join(' | ') || '(无)'}`);
        if (!result.rejectedSample) result.rejectedSample = { pnk, docErrors: rejectionReason || '' };
      }

      const salePrice = Number(o.sale_price ?? o.salePrice ?? o.main_offer_price ?? 0);
      const currencyRaw = o.currency ?? o.currency_type;
      const currency = (typeof currencyRaw === 'string' && currencyRaw.trim())
        ? currencyRaw.trim().toUpperCase()
        : (creds.region === 'RO' ? 'RON' : creds.region === 'BG' ? 'BGN' : 'HUF');
      let stock = 0;
      if (o.general_stock != null) {
        stock = Number(o.general_stock) || 0;
      } else if (o.estimated_stock != null) {
        stock = Number(o.estimated_stock) || 0;
      } else if (Array.isArray(o.stock) && o.stock.length > 0) {
        stock = o.stock.reduce((s: number, x: any) => s + Number(x.value ?? x ?? 0), 0);
      } else if (typeof o.stock === 'number') {
        stock = o.stock;
      }

      const rawName = String(o.name ?? o.title ?? '').trim();
      const name = rawName || fallbackText;

      const emagId = o.id != null ? String(o.id) : null;
      const mainImage = mainImageUrl;
      const imageUrl = mainImage;

      const statusNum = Number(o.status ?? 1);
      const validationStatus = isApproved ? 'active' : (vsDesc || 'rejected');

      await prisma.storeProduct.create({
        data: {
          shopId: creds.shopId,
          pnk,
          vendorSku: vendorSku ?? undefined,
          sku: sku ?? undefined,
          ean: ean ?? undefined,
          emagOfferId: emagId ?? undefined,
          name,
          salePrice,
          currency,
          stock,
          status: statusNum,
          categoryId: o.category_id ?? undefined,
          imageUrl: imageUrl ?? undefined,
          mainImage: mainImage ?? undefined,
          validationStatus: validationStatus ?? undefined,
          docErrors: docErrors ?? undefined,
          rejectionReason: rejectionReason,
        },
      });
      result.upserted++;
    } catch (e) {
      result.errors.push(`${o.part_number_key ?? o.part_number ?? o.pnk}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[storeProductSync] shop=${creds.shopId} 已同步 ${result.upserted} 个产品到 StoreProduct`);

  // ─── EAN 补全模式：main_image 为 null 的产品通过 documentation/find_by_eans 补图
  const noImageProducts = await prisma.storeProduct.findMany({
    where: { shopId: creds.shopId, mainImage: null, ean: { not: null } },
    select: { id: true, pnk: true, ean: true },
  });
  let eanImagesRecovered = 0;
  if (noImageProducts.length > 0) {
    try {
      const eanToProducts = new Map<string, Array<{ id: number; pnk: string }>>();
      for (const p of noImageProducts) {
        const eans = String(p.ean ?? '').split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
        const firstEan = eans[0];
        if (firstEan) {
          const list = eanToProducts.get(firstEan) ?? [];
          list.push({ id: p.id, pnk: p.pnk });
          eanToProducts.set(firstEan, list);
        }
      }
      const uniqueEans = [...eanToProducts.keys()];
      console.log(`\n[EAN 补全] 发现 ${noImageProducts.length} 个无图产品，共 ${uniqueEans.length} 个唯一 EAN，开始批量查询...`);
      for (let i = 0; i < uniqueEans.length; i += EAN_BATCH_SIZE) {
        const batch = uniqueEans.slice(i, i + EAN_BATCH_SIZE);
        await new Promise((r) => setTimeout(r, EAN_DELAY_MS));
        const res = await findDocumentationByEans(creds, batch);
        if (res.isError || !res.results) continue;
        const items = Array.isArray(res.results) ? res.results : (res.results as any)?.items ?? [];
        const eanToImage = new Map<string, string>();
        for (const item of items) {
          const ean = item?.ean ?? item?.EAN ?? item?.ean_code;
          const img = item?.product_image ?? item?.productImage ?? item?.image ?? item?.main_image;
          if (ean && typeof img === 'string' && img.trim()) {
            const eanStr = String(ean).trim();
            if (!eanToImage.has(eanStr)) eanToImage.set(eanStr, img.trim());
          }
        }
        for (const ean of batch) {
          const img = eanToImage.get(ean);
          const prods = eanToProducts.get(ean) ?? [];
          for (const prod of prods) {
            const got = !!img;
            if (got) eanImagesRecovered++;
            console.log(`[EAN 补全] PNK: ${prod.pnk}, EAN: ${ean}, 是否抓取到图片: ${got ? '是' : '否'}`);
            if (img) {
              await prisma.storeProduct.update({
                where: { id: prod.id },
                data: { mainImage: img, imageUrl: img },
              });
            }
          }
        }
      }
      result.eanImagesRecovered = eanImagesRecovered;
      console.log(`\n[EAN 补全] 完成，共找回 ${eanImagesRecovered} 张图片`);
    } catch (eanErr: any) {
      console.error(`[EAN 补全] 接口调用失败，跳过: ${eanErr?.message ?? eanErr}`);
      console.error(`  提示: 若 documentation/find_by_eans 路由不存在，请核对 eMAG API v4.5+ 文档中的正确 resource/action`);
    }
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
