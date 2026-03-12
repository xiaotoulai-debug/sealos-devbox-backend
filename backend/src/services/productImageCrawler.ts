/**
 * 产品图片补货爬虫 — 当 eMAG API 未返回图片时，从商品页抓取
 *
 * 输入: product_url (eMAG 前台链接)
 * 输出: 主图 URL，或 null
 */

import * as cheerio from 'cheerio';
import * as https from 'https';
import * as http from 'http';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

function fetchHtml(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', (ch) => { data += ch; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const isPlaceholderUrl = (u: string): boolean => {
  const lower = u.toLowerCase();
  return lower.includes('emag-logo') || lower.includes('/logo') || lower.includes('placeholder')
    || lower.includes('temporary-images') || lower.includes('1x1') || lower.includes('default')
    || lower.includes('as/l.svg') || lower.includes('/l.svg');
};

/**
 * 从 eMAG 商品页抓取主图
 * 优先: meta og:image（真实商品图）
 * 备选: 产品图库，排除 logo/placeholder
 */
export async function fetchMainImageFromProductPage(productUrl: string): Promise<string | null> {
  if (!productUrl || typeof productUrl !== 'string') return null;
  const url = productUrl.trim();
  if (!url.startsWith('http')) return null;

  try {
    const html = await fetchHtml(url);
    if (!html || typeof html !== 'string') return null;

    const $ = cheerio.load(html);

    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage && typeof ogImage === 'string' && ogImage.startsWith('http') && !isPlaceholderUrl(ogImage)) {
      return ogImage.trim();
    }

    const candidates: string[] = [];
    $('.product-gallery-image img, .product-gallery img, .product-page-gallery img, .ph-gallery__main img').each((_, el) => {
      const src = $(el).attr('src') ?? $(el).attr('data-src') ?? $(el).attr('data-lazy-src');
      if (src && src.startsWith('http') && !isPlaceholderUrl(src)) {
        candidates.push(src.trim());
      }
    });

    $('img[src*="emagst.akamaized.net/products/"]').each((_, el) => {
      const src = $(el).attr('src') ?? $(el).attr('data-src');
      if (src && src.startsWith('http') && !isPlaceholderUrl(src) && !candidates.includes(src)) {
        candidates.push(src.trim());
      }
    });

    const first = candidates[0];
    return first && first.length > 10 ? first : null;
  } catch (e) {
    console.warn(`[productImageCrawler] fetch ${url} failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
 e);
    return null;
  }
}
