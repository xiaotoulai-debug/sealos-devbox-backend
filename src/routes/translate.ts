/**
 * 翻译代理接口 — 后端统一转发，避免前端直连第三方 API 暴露密钥或跨域问题
 *
 * POST /api/translate
 * Body: { text: string, from?: string, to?: string }
 * 返回: { code: 200, data: { translatedText: string }, message: 'success' }
 *
 * 翻译引擎优先级：MyMemory API（免费，无密钥，日限 5000 字符/请求，1000 请求/天）
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const MAX_TEXT_LEN = 3000;

router.post('/', async (req: Request, res: Response) => {
  try {
    const { text, from = 'ro', to = 'zh-CN' } = req.body ?? {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ code: 400, data: null, message: '请提供需要翻译的文本（text）' });
      return;
    }

    const trimmed = text.trim();
    if (trimmed.length > MAX_TEXT_LEN) {
      res.status(400).json({
        code: 400,
        data: null,
        message: `文本过长（${trimmed.length} 字符），最大支持 ${MAX_TEXT_LEN} 字符`,
      });
      return;
    }

    const langPair = `${from}|${to}`;
    const resp = await axios.get(MYMEMORY_URL, {
      params: { q: trimmed, langpair: langPair },
      timeout: 10000,
    });

    const translatedText = resp.data?.responseData?.translatedText;
    if (!translatedText) {
      console.error('[POST /api/translate] MyMemory 返回异常:', JSON.stringify(resp.data).slice(0, 300));
      res.status(502).json({ code: 502, data: null, message: '翻译服务暂时不可用，请稍后重试' });
      return;
    }

    res.json({
      code: 200,
      data: { translatedText, from, to },
      message: 'success',
    });
  } catch (err) {
    console.error('[POST /api/translate]', err);
    const msg = axios.isAxiosError(err) ? '翻译服务请求失败，请稍后重试' : '服务器内部错误';
    res.status(500).json({ code: 500, data: null, message: msg });
  }
});

export default router;
