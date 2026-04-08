/**
 * 公海产品图片 OSS 迁移脚本 — Phase 2
 *
 * 目标：将公海产品的外部图片链接（eMAG Akamai CDN）下载后转存到 Sealos OSS，
 *       并将数据库中的 imageUrl 更新为 OSS 永久链接，规避防盗链风险。
 *
 * 核心设计：
 *   ① 与 DB Upsert（Phase 1）完全解耦：图片下载失败不影响产品元数据
 *   ② p-limit(5) 并发控制：避免对 Akamai CDN 造成冲击，防内存溢出
 *   ③ UA + Referer 伪装：绕过 Akamai CDN 可能的防爬限制
 *   ④ 指数退避重试（最多 3 次）：网络抖动自动恢复
 *   ⑤ 失败容错：下载失败保留原链接，不回滚，记录到 /tmp/oss-image-errors.jsonl
 *   ⑥ 幂等设计：imageUrl 已是 OSS 域名的产品自动跳过，安全重跑
 *
 * 前置环境变量（需在 .env 中配置，见下方注释）：
 *   OSS_ENDPOINT         Sealos OSS 控制台 → Bucket → 连接信息 → Endpoint
 *   OSS_BUCKET           Bucket 名称
 *   OSS_ACCESS_KEY       AccessKey（访问密钥 ID）
 *   OSS_SECRET_KEY       SecretKey（访问密钥 Secret）
 *   OSS_REGION           区域（如 cn-hangzhou，按 Sealos 控制台填写）
 *   OSS_PUBLIC_BASE_URL  Bucket 公网访问前缀（如 https://<bucket>.<endpoint>）
 *
 * 执行方式：
 *   cd /home/devbox/project/backend
 *   npm run ops:migrate-sea-images          # 标准执行
 *   npm run ops:migrate-sea-images:log      # 输出同时写入日志文件
 *
 * 重跑安全：已迁移的图片（imageUrl 已以 OSS_PUBLIC_BASE_URL 开头）自动跳过。
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import pLimit from 'p-limit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../src/lib/prisma';

// ── 环境变量校验 ─────────────────────────────────────────────────────────────
const OSS_ENDPOINT    = process.env.OSS_ENDPOINT ?? '';
const OSS_BUCKET      = process.env.OSS_BUCKET   ?? '';
const OSS_ACCESS_KEY  = process.env.OSS_ACCESS_KEY ?? '';
const OSS_SECRET_KEY  = process.env.OSS_SECRET_KEY ?? '';
const OSS_REGION      = process.env.OSS_REGION     ?? 'auto';
const OSS_PUBLIC_BASE = (process.env.OSS_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

const missingVars = [
  ['OSS_ENDPOINT',       OSS_ENDPOINT],
  ['OSS_BUCKET',         OSS_BUCKET],
  ['OSS_ACCESS_KEY',     OSS_ACCESS_KEY],
  ['OSS_SECRET_KEY',     OSS_SECRET_KEY],
  ['OSS_PUBLIC_BASE_URL', OSS_PUBLIC_BASE],
].filter(([, v]) => !v).map(([k]) => k);

if (missingVars.length > 0) {
  console.error('[FATAL] 缺少以下 OSS 环境变量，请检查 .env 文件：');
  missingVars.forEach((k) => console.error(`  ✗ ${k}`));
  process.exit(1);
}

// ── S3 客户端（Sealos OSS S3 兼容协议）─────────────────────────────────────
const s3 = new S3Client({
  endpoint:    OSS_ENDPOINT,
  region:      OSS_REGION,
  credentials: {
    accessKeyId:     OSS_ACCESS_KEY,
    secretAccessKey: OSS_SECRET_KEY,
  },
  // forcePathStyle: Sealos / MinIO 兼容模式必须开启
  forcePathStyle: true,
});

// ── 可调参数 ──────────────────────────────────────────────────────────────
const CONCURRENCY    = 5;       // 并发下载上限；网络稳定时可调至 8，不建议超过 10
const TIMEOUT_MS     = 15_000;  // 单图下载超时 15s（高清图体积较大）
const MAX_RETRIES    = 2;       // 失败后最多再重试 2 次（共 3 次尝试）
const PROGRESS_STEP  = 50;      // 每处理 50 张打印一次进度
const OSS_KEY_PREFIX = 'public-sea';  // OSS 存储路径前缀

// 错误日志路径（确保 /tmp 可写）
const ERROR_LOG_PATH = '/tmp/oss-image-errors.jsonl';

// ── 辅助：从 URL 提取文件扩展名 ────────────────────────────────────────────
function extractExt(url: string, contentType: string): string {
  // 优先从 Content-Type 推断（更准确）
  const ctMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg':  'jpg',
    'image/png':  'png',
    'image/webp': 'webp',
    'image/gif':  'gif',
    'image/avif': 'avif',
  };
  const extFromCt = ctMap[contentType.split(';')[0].trim().toLowerCase()];
  if (extFromCt) return extFromCt;

  // 从 URL 路径提取
  const urlPath = url.split('?')[0];
  const dotIdx  = urlPath.lastIndexOf('.');
  if (dotIdx > 0) {
    const ext = urlPath.slice(dotIdx + 1).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'jpg'; // 兜底
}

// ── 核心：下载图片 Buffer（带 UA/Referer 伪装 + 超时）──────────────────────
async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout:      TIMEOUT_MS,
    headers: {
      // eMAG Akamai CDN 可能对无 UA 的请求返回 403；伪装成普通浏览器访问
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                    'Chrome/120.0.0.0 Safari/537.36',
      'Referer':  'https://www.emag.ro/',
      'Accept':   'image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  const ct = (resp.headers['content-type'] as string | undefined) ?? 'image/jpeg';
  return { buffer: Buffer.from(resp.data), contentType: ct };
}

// ── 核心：上传至 Sealos OSS ─────────────────────────────────────────────────
async function uploadToOss(key: string, buffer: Buffer, contentType: string): Promise<string> {
  await s3.send(new PutObjectCommand({
    Bucket:        OSS_BUCKET,
    Key:           key,
    Body:          buffer,
    ContentType:   contentType,
    // ACL: 'public-read',
    // ↑ 若 Sealos Bucket 已设为 Public，注释掉此行；
    //   若需 ACL 控制（私有 Bucket），取消注释并确认 Sealos 是否支持 ACL API
  }));
  return `${OSS_PUBLIC_BASE}/${key}`;
}

// ── 核心：单图迁移（含指数退避重试）──────────────────────────────────────────
async function migrateImage(
  pnk: string,
  originalUrl: string,
  attempt = 0,
): Promise<string | null> {
  try {
    const { buffer, contentType } = await downloadImage(originalUrl);
    const ext = extractExt(originalUrl, contentType);
    const key = `${OSS_KEY_PREFIX}/${pnk}.${ext}`;
    return await uploadToOss(key, buffer, contentType);
  } catch (err: unknown) {
    if (attempt < MAX_RETRIES) {
      // 指数退避：1s → 2s → 4s...
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      return migrateImage(pnk, originalUrl, attempt + 1);
    }
    // 超过重试上限，返回 null（保留原链接，不回滚）
    return null;
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('='.repeat(64));
  console.log(' 公海产品图片 OSS 迁移 — Phase 2');
  console.log(`  启动：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log(`  并发：${CONCURRENCY}  超时：${TIMEOUT_MS}ms  重试：${MAX_RETRIES}次`);
  console.log(`  OSS Endpoint：${OSS_ENDPOINT}`);
  console.log(`  OSS Bucket：  ${OSS_BUCKET}`);
  console.log(`  OSS 前缀：    ${OSS_KEY_PREFIX}/`);
  console.log('='.repeat(64));

  // ── 查询待迁移产品：imageUrl 不以 OSS 域名开头的 PENDING 产品
  //   （幂等：已迁移的自动跳过）
  const pending = await prisma.product.findMany({
    where: {
      status:   'PENDING',
      imageUrl: {
        not:         null,
        not:         undefined,
      },
      NOT: {
        imageUrl: { startsWith: OSS_PUBLIC_BASE },
      },
    } as Parameters<typeof prisma.product.findMany>[0]['where'],
    select: { id: true, pnk: true, imageUrl: true },
    orderBy: { id: 'asc' },
  });

  console.log(`\n待迁移图片：${pending.length} 张`);

  if (pending.length === 0) {
    console.log('✅ 所有产品图片已迁移至 OSS，无需操作。');
    await prisma.$disconnect();
    process.exit(0);
  }

  // ── 准备统计 & 错误收集
  let done    = 0;
  let success = 0;
  let failed  = 0;
  let skipped = 0;  // imageUrl 为空
  const errorRecords: Array<{
    pnk: string; originalUrl: string; error: string; ts: string;
  }> = [];

  const limit = pLimit(CONCURRENCY);

  // ── 构建并发任务列表
  const tasks = pending.map((product) =>
    limit(async () => {
      const { id, pnk, imageUrl } = product;

      if (!imageUrl) {
        skipped++;
        done++;
        return;
      }

      const ossUrl = await migrateImage(pnk, imageUrl);

      if (ossUrl) {
        // 成功：更新 DB
        try {
          await prisma.product.update({
            where: { id },
            data:  { imageUrl: ossUrl },
          });
          success++;
        } catch (dbErr: unknown) {
          // DB 更新失败（极少见，如主键冲突）：图片已在 OSS，下次重跑可恢复
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          errorRecords.push({ pnk, originalUrl: imageUrl, error: `DB_UPDATE: ${msg}`, ts: new Date().toISOString() });
          failed++;
        }
      } else {
        // 下载/上传失败：保留原链接，记录错误，不回滚
        errorRecords.push({
          pnk,
          originalUrl: imageUrl,
          error:       `DOWNLOAD_FAILED after ${MAX_RETRIES + 1} attempts`,
          ts:          new Date().toISOString(),
        });
        failed++;
      }

      done++;

      // 进度打印
      if (done % PROGRESS_STEP === 0 || done === pending.length) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate    = (done / (Number(elapsed) || 1)).toFixed(2);
        const eta     = Number(elapsed) > 0
          ? Math.round((pending.length - done) / (done / Number(elapsed)))
          : '?';
        console.log(
          `[${String(done).padStart(5)}/${pending.length}]` +
          `  ✅ ${success}  ❌ ${failed}  ⏭️ ${skipped}` +
          `  | ${elapsed}s 已过  速率 ${rate}/s  预计剩余 ${eta}s`,
        );
      }
    }),
  );

  // ── 并发执行全部任务
  await Promise.all(tasks);

  // ── 写入错误日志（JSONL 格式，每行一条，方便 grep 过滤）
  if (errorRecords.length > 0) {
    const lines = errorRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
    try {
      fs.writeFileSync(ERROR_LOG_PATH, lines, { encoding: 'utf8', flag: 'w' });
      console.log(`\n❌ 失败记录已写入：${ERROR_LOG_PATH}`);
      console.log('   重跑命令（可自动跳过已成功的图片）：');
      console.log('   npm run ops:migrate-sea-images');
    } catch {
      console.error('写入错误日志失败，直接输出：');
      console.error(lines);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(64));
  console.log(' 迁移完成');
  console.log(`  总计：    ${pending.length}`);
  console.log(`  ✅ 成功：  ${success}`);
  console.log(`  ❌ 失败：  ${failed}（原链接已保留，可重跑恢复）`);
  console.log(`  ⏭️  跳过：  ${skipped}（imageUrl 为空）`);
  console.log(`  ⏱  总耗时：${totalElapsed}s`);
  if (success > 0 && Number(totalElapsed) > 0) {
    console.log(`  平均速率：${(success / Number(totalElapsed)).toFixed(2)} 张/s`);
  }
  console.log('='.repeat(64));

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[FATAL] 未捕获异常:', e);
  prisma.$disconnect().catch(() => {});
  process.exit(1);
});
