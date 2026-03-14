/**
 * @deprecated 已废弃 — 老板拍板采用【本地关联 SKU 兜底策略】
 * 平台产品无图时，通过 mapped_inventory_sku 关联 Inventory.local_image 兜底。
 * 本爬虫方案因 eMAG WAF 拦截且维护成本高，已下线。
 *
 * OG:Image HTML 兜底抓图引擎（原第三引擎）
 *
 * 针对 eMAG "跟卖"产品，API 不返回图片（只返回 own content input）。
 * 从产品前台页面 HTML 的 <meta property="og:image"> 提取主图。
 *
 * 性能保护：并发控制 + 请求间隔 + 超时保护 + fire-and-forget
 * 纯正则解析，不依赖 cheerio（避免 Node 18 undici 兼容问题）
 */

import https from 'https';
import http from 'http';
import { prisma } from '../lib/prisma';

const CONCURRENCY = 3;
const DELAY_MS = 800;
const TIMEOUT_MS = 10000;

const UA_LIST = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Twitterbot/1.0',
];

function isCaptchaPage(html: string): boolean {
  return html.includes('eMAG Captcha') || html.includes('captcha-sdk.awswaf.com') || html.includes('awsWafCaptcha');
}

/**
 * 纯正则从 HTML <head> 中提取 og:image / twitter:image
 */
function extractOgImageFromHtml(html: string): string | null {
  if (!html || isCaptchaPage(html)) return null;

  // <meta property="og:image" content="URL">
  const og1 = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  if (og1?.[1]?.startsWith('http')) return og1[1];

  // <meta content="URL" property="og:image"> (反序)
  const og2 = html.match(/<meta[^>]+content\s*=\s*["'](https?:\/\/[^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
  if (og2?.[1]) return og2[1];

  // twitter:image
  const tw = html.match(/<meta[^>]+name\s*=\s*["']twitter:image["'][^>]+content\s*=\s*["']([^"']+)["']/i);
  if (tw?.[1]?.startsWith('http')) return tw[1];

  // 降级：从 JSON-LD 结构化数据提取 "image"
  const jsonLd = html.match(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLd?.[1]) {
    try {
      const data = JSON.parse(jsonLd[1]);
      const img = data?.image ?? data?.image?.[0] ?? data?.thumbnailUrl;
      if (typeof img === 'string' && img.startsWith('http')) return img;
      if (typeof img === 'object' && img?.url?.startsWith('http')) return img.url;
    } catch { /* ignore parse error */ }
  }

  return null;
}

/**
 * 使用 Node 原生 http/https 请求页面（避免 axios/undici 在 Node 18 的兼容问题）
 */
function fetchHtml(url: string, ua: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
      },
    }, (res) => {
      // 跟随重定向（3xx）
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        fetchHtml(redirectUrl, ua).then(resolve).catch(reject);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 从单个 eMAG 产品页面抓取 og:image
 */
async function scrapeOgImage(productUrl: string, attemptIndex: number = 0): Promise<string | null> {
  const ua = UA_LIST[attemptIndex % UA_LIST.length];
  try {
    const html = await fetchHtml(productUrl, ua);
    if (isCaptchaPage(html)) return null;
    return extractOgImageFromHtml(html);
  } catch (err: any) {
    console.warn(`[OG Scraper] HTTP 异常: ${err?.message ?? err} -> ${productUrl.slice(0, 80)}`);
    return null;
  }
}

export interface OgScrapeResult {
  total: number;
  updated: number;
  failed: number;
  captchaBlocked: number;
  errors: string[];
}

/**
 * 批量抓取无图产品的 og:image 并回写数据库
 */
export async function scrapeOgImagesForProducts(
  shopId: number,
  products: Array<{ id: number; pnk: string; productUrl: string | null; sku: string | null }>,
): Promise<OgScrapeResult> {
  const result: OgScrapeResult = { total: products.length, updated: 0, failed: 0, captchaBlocked: 0, errors: [] };

  const validProducts = products.filter((p) => p.productUrl && p.productUrl.startsWith('http'));
  if (validProducts.length === 0) {
    console.log(`[OG Scraper] shop=${shopId} 无有效 productUrl 可抓取`);
    return result;
  }

  console.log(`[OG Scraper] shop=${shopId} 开始抓取 ${validProducts.length} 个跟卖产品的 og:image...`);

  let captchaDetected = false;
  let idx = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, validProducts.length) }, async () => {
    while (idx < validProducts.length) {
      if (captchaDetected) break;

      const current = idx++;
      const p = validProducts[current];
      const skuDisplay = p.sku ?? p.pnk;

      try {
        await new Promise((r) => setTimeout(r, DELAY_MS));
        const imageUrl = await scrapeOgImage(p.productUrl!, current);

        if (imageUrl) {
          await prisma.storeProduct.updateMany({
            where: { shopId, pnk: p.pnk },
            data: { mainImage: imageUrl, imageUrl: imageUrl },
          });
          result.updated++;
          console.log(`[OG Scraper] ✅ SKU: ${skuDisplay} -> ${imageUrl.slice(0, 100)}`);
        } else {
          result.captchaBlocked++;
          if (result.captchaBlocked >= 3) {
            console.warn(`[OG Scraper] ⚠️ shop=${shopId} 连续 ${result.captchaBlocked} 次无法获取，停止（可能被 WAF 拦截）`);
            captchaDetected = true;
            break;
          }
          result.failed++;
        }
      } catch (e: any) {
        result.failed++;
        result.errors.push(`${p.pnk}: ${e?.message ?? e}`);
      }
    }
  });

  await Promise.all(workers);

  if (captchaDetected) {
    console.log(`[OG Scraper] shop=${shopId} 结果: ${result.updated} 成功, ${result.captchaBlocked} 被拦截 — 建议从本地浏览器手动抓图或配置代理`);
  } else {
    console.log(`[OG Scraper] shop=${shopId} 完成: ${result.updated} 成功, ${result.failed} 失败 (共 ${validProducts.length} 个)`);
  }
  return result;
}

/**
 * 异步 fire-and-forget：查找指定店铺的无图产品并抓取 og:image
 */
export function fireAndForgetOgScrape(shopId: number): void {
  (async () => {
    try {
      const noImageProducts = await prisma.storeProduct.findMany({
        where: {
          shopId,
          OR: [{ mainImage: null }, { mainImage: '' }],
        },
        select: { id: true, pnk: true, productUrl: true, sku: true },
      });

      if (noImageProducts.length === 0) {
        console.log(`[OG Scraper] shop=${shopId} 所有产品都有图片，跳过`);
        return;
      }

      await scrapeOgImagesForProducts(shopId, noImageProducts);
    } catch (e: any) {
      console.error(`[OG Scraper] shop=${shopId} fire-and-forget 异常:`, e?.message ?? e);
    }
  })();
}
