/**
 * 【前置侦查脚本】eMAG 佣金 API 端点探测
 *
 * 目标：在正式编码 commissionSync.ts 之前，100% 确认以下三件事：
 *   1. 正确的 API Endpoint（resource + action 的组合）
 *   2. 正确的请求 Payload 字段名（part_number / part_number_key / id）
 *   3. 响应体中佣金率的真实字段名（commission / commission_rate / value 等）
 *
 * 用法：npm run ops:test-commission [shopId]
 *   shopId 可选，不传则自动取第一个 RO 店铺
 *
 * 侦查策略：对同一个真实 SKU，依次尝试所有已知端点变体，打印每次的
 *   完整 REQUEST PAYLOAD 和 RAW RESPONSE，便于精准识别可用端点。
 */

import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { getEmagCredentials, emagApiCall } from '../src/services/emagClient';

// ─── 待探测的端点变体（按 eMAG API v4.4.3 文档可能的命名排列）────────
// emagApiCall(creds, resource, action, data) → POST {baseUrl}/{resource}/{action}
const ENDPOINT_VARIANTS: Array<{
  label: string;
  resource: string;
  action: string;
}> = [
  // eMAG v4.4.3 changelog 新增接口（Section 2.12），最可能正确
  { label: 'offer_commission / read',           resource: 'offer_commission',  action: 'read'       },
  // 备选变体 A：沿用 product_offer 命名空间
  { label: 'product_offer / commission',        resource: 'product_offer',     action: 'commission' },
  // 备选变体 B：product_offer 下的嵌套 action
  { label: 'product_offer_commission / read',   resource: 'product_offer_commission', action: 'read' },
  // 备选变体 C：commission 单独资源
  { label: 'commission / read',                 resource: 'commission',        action: 'read'       },
];

// ─── 待探测的 Payload 字段名变体 ─────────────────────────────────────
function buildPayloads(partNumber: string, pnk: string, id: number) {
  return [
    { _desc: 'part_number（SKU）',               part_number:     partNumber  },
    { _desc: 'part_number_key（PNK）',           part_number_key: pnk         },
    { _desc: 'id（StoreProduct DB id）',         id:              id           },
    { _desc: 'part_number + part_number_key',   part_number: partNumber, part_number_key: pnk },
  ];
}

function sep(title: string, char = '═') {
  const line = char.repeat(62);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function subSep(title: string) {
  console.log(`\n  ${'─'.repeat(56)}`);
  console.log(`  ${title}`);
  console.log(`  ${'─'.repeat(56)}`);
}

async function main() {
  // ── 1. 选取目标 Shop ───────────────────────────────────────────────
  const shopIdArg = process.argv[2];
  let shopId: number;

  if (shopIdArg && !isNaN(Number(shopIdArg))) {
    shopId = Number(shopIdArg);
    console.log(`使用指定店铺 shopId=${shopId}`);
  } else {
    // 优先取 RO 店铺（佣金 API 在 RO 站可靠性最高）
    const roShop = await prisma.shopAuthorization.findFirst({
      where: {
        platform: { equals: 'emag', mode: 'insensitive' },
        status: 'active',
        region: 'RO',
      },
      select: { id: true, shopName: true },
    });
    const fallbackShop = roShop ?? await prisma.shopAuthorization.findFirst({
      where: { platform: { equals: 'emag', mode: 'insensitive' }, status: 'active' },
      select: { id: true, shopName: true },
    });
    if (!fallbackShop) {
      console.error('❌ 数据库中未找到任何激活的 eMAG 店铺，请先配置店铺凭据。');
      process.exit(1);
    }
    shopId = fallbackShop.id;
    console.log(`自动选取店铺: "${fallbackShop.shopName}" (shopId=${shopId})`);
  }

  // ── 2. 选取目标 StoreProduct ────────────────────────────────────────
  const target = await prisma.storeProduct.findFirst({
    where: {
      shopId,
      vendorSku: { not: null },
      salePrice: { gt: 0 },
    },
    select: {
      id: true, pnk: true, sku: true, vendorSku: true, salePrice: true, currency: true,
    },
    orderBy: { id: 'asc' },
  });

  if (!target) {
    console.error(`❌ 店铺 shopId=${shopId} 中未找到有效的 StoreProduct（需要 vendorSku 不为空且 salePrice > 0）`);
    process.exit(1);
  }

  const partNumber = target.vendorSku ?? target.sku ?? '';
  const pnk = target.pnk ?? '';

  sep('测试目标信息');
  console.log(`  StoreProduct ID : ${target.id}`);
  console.log(`  vendorSku       : ${target.vendorSku ?? '(null)'}`);
  console.log(`  sku             : ${target.sku ?? '(null)'}`);
  console.log(`  PNK             : ${pnk || '(null)'}`);
  console.log(`  售价            : ${target.salePrice} ${target.currency}`);
  console.log(`  使用 part_number: "${partNumber}"`);

  // ── 3. 获取凭据 ────────────────────────────────────────────────────
  const creds = await getEmagCredentials(shopId);
  console.log(`\n  API BaseURL: ${creds.baseUrl}`);
  console.log(`  Region    : ${creds.region}`);

  const payloads = buildPayloads(partNumber, pnk, target.id);

  // ── 4. 逐个端点 × 逐个 Payload 探测 ───────────────────────────────
  for (const endpoint of ENDPOINT_VARIANTS) {
    sep(`探测端点: ${endpoint.label}`);
    console.log(`  POST ${creds.baseUrl}/${endpoint.resource}/${endpoint.action}`);

    for (const payload of payloads) {
      const { _desc, ...data } = payload as any;
      subSep(`Payload: ${_desc}`);

      console.log('  REQUEST DATA:');
      console.log(' ', JSON.stringify(data, null, 2).replace(/\n/g, '\n  '));

      try {
        const res = await emagApiCall(creds, endpoint.resource, endpoint.action, data, { timeout: 10000 });

        console.log('\n  RAW RESPONSE:');
        console.log(`  isError  : ${res.isError}`);
        if (res.messages?.length) {
          console.log(`  messages : ${JSON.stringify(res.messages)}`);
        }
        if (res.errors?.length) {
          console.log(`  errors   : ${JSON.stringify(res.errors)}`);
        }

        if (!res.isError && res.results != null) {
          console.log('\n  ✅ 成功！results 结构:');
          console.log(' ', JSON.stringify(res.results, null, 2).replace(/\n/g, '\n  '));

          // 自动检测疑似佣金字段
          const results = res.results as any;
          const commissionKeys = Object.keys(
            typeof results === 'object' && results !== null ? results : {}
          ).filter((k) =>
            k.toLowerCase().includes('commission') ||
            k.toLowerCase().includes('rate') ||
            k.toLowerCase().includes('percent') ||
            k.toLowerCase().includes('pct') ||
            k.toLowerCase().includes('fee')
          );
          if (commissionKeys.length > 0) {
            console.log('\n  🎯 检测到疑似佣金字段:');
            commissionKeys.forEach((k) => {
              console.log(`     "${k}": ${JSON.stringify((results as any)[k])}`);
            });
          }
        } else if (res.isError) {
          console.log(`  ❌ API 返回错误`);
          // 打印完整原始响应以便分析错误结构
          console.log('  完整响应:', JSON.stringify(res, null, 2).slice(0, 800));
        }
      } catch (err: any) {
        console.log(`  ⚠️  请求异常: ${err.message?.slice(0, 200)}`);
      }

      // 端点探测之间稍作停顿，避免触发频率限制
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // ── 5. 汇总建议 ────────────────────────────────────────────────────
  sep('侦查完毕', '═');
  console.log('  请将以上输出完整粘贴给 AI，AI 将根据 ✅ 成功 的端点和字段名');
  console.log('  精准实现 commissionSync.ts，无任何字段名猜测。');
}

main()
  .catch((e) => {
    console.error('\n脚本异常退出:', e.message ?? e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
