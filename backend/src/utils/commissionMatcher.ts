/**
 * 本地佣金率匹配引擎
 *
 * 性能红线：纯本地字符串运算，零外部调用，零 LLM，毫秒级响应。
 *
 * 优先级链路（调用方 profitCalculator.ts 负责完整三级降级）：
 *   Level 1  StoreProduct.commissionRate        — 已有 API/手动设置的精确值（调用方处理）
 *   Level 2  guessCommissionRate()              — 本模块：关键词字典匹配
 *   Level 3  DEFAULT_COMMISSION_RATE (0.18)     — commissionMap.ts 常量，调用方兜底
 *
 * 匹配算法说明：
 *   1. 将 productName + categoryName 合并为单一文本，统一转小写
 *   2. 按 COMMISSION_RULES 顺序（rate 低 → 高）遍历每条规则
 *   3. 在 keywordsEn / keywordsRo / keywordsZh 中任意命中一个关键词即返回
 *   4. 优先精确短语匹配（多词组），再退化为单词包含匹配
 *   5. 全部规则未命中 → 返回 null，由调用方使用 DEFAULT_COMMISSION_RATE 兜底
 */

import { COMMISSION_RULES_SORTED } from '../config/commissionMap';

/**
 * 根据产品名称 / 类目名称猜测佣金率。
 *
 * @param productName  产品标题（StoreProduct.name 或 Product.name，必填）
 * @param categoryName 类目名称（Product.category 或 StoreProduct 类目字段，可选）
 * @returns 匹配到的佣金率（小数），未命中返回 null
 */
export function guessCommissionRate(
  productName: string,
  categoryName?: string | null,
): number | null {
  // 合并文本：产品名 + 类目名，统一小写，双空格/特殊字符规范化
  const haystack = normalize(`${productName} ${categoryName ?? ''}`);

  for (const rule of COMMISSION_RULES_SORTED) {
    const allKeywords = [...rule.keywordsEn, ...rule.keywordsRo, ...rule.keywordsZh];

    // 优先尝试多词短语（含空格）：精确度更高，避免 "tv" 误命中 "activity"
    const phrases  = allKeywords.filter((k) => k.includes(' '));
    const singles  = allKeywords.filter((k) => !k.includes(' '));

    // 先检查短语（不能被单词边界污染，直接 includes 即可）
    if (phrases.some((phrase) => haystack.includes(phrase))) {
      return rule.rate;
    }

    // 再检查单词（使用词边界正则，避免 "tv" 命中 "activity"）
    if (singles.some((word) => matchWord(haystack, word))) {
      return rule.rate;
    }
  }

  return null; // 调用方负责 DEFAULT_COMMISSION_RATE 兜底
}

// ─── 内部工具函数 ────────────────────────────────────────────────────────

/**
 * 规范化文本：小写 + 去除多余空白，保留中文字符
 * 注意：不剥离标点，避免 "type-c" → "typec" 之类的误匹配
 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 词边界匹配：英文单词前后检查非字母数字边界，防止短词污染
 * 中文关键词直接用 includes（中文字符天然无边界问题）
 */
function matchWord(haystack: string, keyword: string): boolean {
  // 中文关键词：直接包含匹配
  if (/[\u4e00-\u9fa5]/.test(keyword)) {
    return haystack.includes(keyword);
  }
  // 英文/罗马尼亚语：词边界正则（\b 在 JS 中仅匹配 ASCII，满足需求）
  // 对于含连字符的词如 "type-c"，连字符视为边界，不额外特殊处理
  try {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(keyword)}(?![a-z0-9])`, 'i');
    return pattern.test(haystack);
  } catch {
    // 正则构建失败（极端字符），降级为 includes
    return haystack.includes(keyword);
  }
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── 调试工具（仅供开发/脚本使用，生产不调用）─────────────────────────────

/**
 * 调试：返回匹配过程的详细说明（命中规则 label、命中关键词）
 * 用于 audit-profit 脚本或人工核对时溯源
 */
export function debugGuessCommissionRate(
  productName: string,
  categoryName?: string | null,
): { rate: number | null; source: 'matched' | 'no_match'; matchedLabel?: string; matchedKeyword?: string } {
  const haystack = normalize(`${productName} ${categoryName ?? ''}`);

  for (const rule of COMMISSION_RULES_SORTED) {
    const allKeywords = [...rule.keywordsEn, ...rule.keywordsRo, ...rule.keywordsZh];
    const phrases = allKeywords.filter((k) => k.includes(' '));
    const singles = allKeywords.filter((k) => !k.includes(' '));

    for (const phrase of phrases) {
      if (haystack.includes(phrase)) {
        return { rate: rule.rate, source: 'matched', matchedLabel: rule.label, matchedKeyword: phrase };
      }
    }
    for (const word of singles) {
      if (matchWord(haystack, word)) {
        return { rate: rule.rate, source: 'matched', matchedLabel: rule.label, matchedKeyword: word };
      }
    }
  }

  return { rate: null, source: 'no_match' };
}
