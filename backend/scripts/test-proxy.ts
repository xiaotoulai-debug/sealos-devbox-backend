#!/usr/bin/env npx ts-node
/**
 * 代理连通性测试脚本
 * 用途: 验证 EMAG_PROXY_URL 配置是否生效，确认出口 IP 为代理服务器固定 IP
 * 用法: npx ts-node --skip-project --compiler-options '{"module":"commonjs","esModuleInterop":true}' scripts/test-proxy.ts
 */
import 'dotenv/config';

if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
}

import axios from 'axios';
import HttpsProxyAgent from 'https-proxy-agent';
import HttpProxyAgent from 'http-proxy-agent';

const PROXY_URL = process.env.EMAG_PROXY_URL?.trim();
const TEST_URL  = 'http://myip.ipip.net';

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 eMAG 正向代理连通性测试');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── Step 1: 不走代理，获取本机直连出口 IP ─────────────────────
  console.log('📡 [1/2] 直连测试（不经代理）...');
  try {
    const { data } = await axios.get<string>(TEST_URL, { timeout: 10000, responseType: 'text' });
    console.log(`   ✅ 本机直连返回: ${String(data).trim()}`);
    console.log(`      ⚠  若此 IP 出现在 eMAG 白名单则无需代理；若 eMAG 报 "Invalid vendor ip"，需启用代理\n`);
  } catch (e) {
    console.error(`   ❌ 直连失败: ${e instanceof Error ? e.message : e}\n`);
  }

  // ── Step 2: 走代理，获取代理出口 IP ──────────────────────────
  console.log('🛡  [2/2] 代理测试...');
  if (!PROXY_URL) {
    console.warn('   ⚠  EMAG_PROXY_URL 未配置或为空，跳过代理测试');
    console.warn('      请在 .env 中设置: EMAG_PROXY_URL="http://代理IP:端口"');
    process.exit(0);
  }

  const maskedProxy = PROXY_URL.replace(/:([^@/]+)@/, ':***@');
  console.log(`   使用代理: ${maskedProxy}`);

  try {
    // 目标是 HTTP，使用 httpAgent（不是 httpsAgent）
    const agent = HttpProxyAgent(PROXY_URL);
    const { data } = await axios.get<string>(TEST_URL, {
      httpAgent: agent,
      timeout: 15000,
      responseType: 'text',
    });

    const result = String(data).trim();
    console.log(`   ✅ 经代理返回: ${result}`);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🎉 代理工作正常！上方返回内容即为代理出口 IP 信息。`);
    console.log(`   请将代理服务器 IP 加入 eMAG 后台 IP 白名单。`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`   ❌ 代理请求失败: ${msg}`);
    console.error('\n   可能原因:');
    console.error('   1. 代理服务器地址/端口有误');
    console.error('   2. 代理认证账密错误');
    console.error('   3. 代理服务器未启动或防火墙拦截');
    process.exit(1);
  }
}

main();
