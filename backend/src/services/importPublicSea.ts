import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { prisma } from '../lib/prisma';

const DATA_DIR      = path.resolve(__dirname, '../../prisma/data_uploads/public_sea_raw');
const PROCESSED_DIR = path.resolve(__dirname, '../../prisma/data_uploads/processed');

interface RawItem {
  '产品图片'?: string;
  '产品标题'?: string;
  'PRP原价'?: string;
  '前端价格'?: string;
  '前端折扣'?: string;
  '星级值'?: string;
  '链接打标'?: string;
  '评论分数'?: string;
  '评价数量'?: string;
  'PNK码'?: string;
  '产品链接'?: string;
  '一级类'?: string;
  '二级类'?: string;
  '三级类'?: string;
  '四级类'?: string;
  '品牌'?: string;
  '好评率'?: string;
  '详情描述'?: string;
  '规格详情'?: string;
}

function parseDecimal(val: string | undefined | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val.replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function parseInt10(val: string | undefined | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseInt(val.replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

function parseRating(val: string | undefined | null): number | null {
  if (!val || val.trim() === '') return null;
  const n = parseFloat(val.replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function cleanStr(val: string | undefined | null): string | null {
  if (!val) return null;
  return val.trim().replace(/^\n+|\n+$/g, '').trim() || null;
}

/** 确保目标目录存在（不存在则自动创建，recursive 模式安全幂等） */
async function ensureDir(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true });
}

/**
 * 将处理完成的文件移动到 processed/ 目录，文件名追加 Unix 秒时间戳防止同名覆盖。
 * 示例：Componente PC.json → processed/Componente PC_1744113600.json
 *
 * 跨挂载卷兜底（EXDEV）：
 *   rename() 在源/目标不在同一 inode 设备时会抛 EXDEV，此时降级为 copyFile + unlink。
 */
async function archiveFile(srcPath: string, filename: string): Promise<void> {
  const ts       = Math.floor(Date.now() / 1000);
  const ext      = path.extname(filename);
  const stem     = path.basename(filename, ext);
  const newName  = `${stem}_${ts}${ext}`;
  const destPath = path.join(PROCESSED_DIR, newName);

  await ensureDir(PROCESSED_DIR);

  try {
    await fsPromises.rename(srcPath, destPath);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // 跨设备/挂载卷：降级为 copy + delete
      await fsPromises.copyFile(srcPath, destPath);
      await fsPromises.unlink(srcPath);
    } else {
      throw err;
    }
  }

  console.log(`  ✅ 已归档: ${filename} → processed/${newName}`);
}

/** 从 RawItem 提取"只在更新时写入"的可变字段（不含 status / pnk） */
function buildUpdateData(item: RawItem, pnk: string) {
  return {
    title:       item['产品标题']?.trim() || `Product ${pnk}`,
    imageUrl:    item['产品图片']?.trim()  || null,
    productUrl:  item['产品链接']?.trim()  || null,
    price:       parseDecimal(item['前端价格']),
    rating:      parseRating(item['评论分数']),
    reviewCount: parseInt10(item['评价数量']),
    categoryL1:  cleanStr(item['一级类']),
    categoryL2:  cleanStr(item['二级类']),
    categoryL3:  cleanStr(item['三级类']),
    categoryL4:  cleanStr(item['四级类']),
    // 三级优先、二级兜底、一级兜底：确保只有 L1/L2 的产品 category 不为空
    category:    cleanStr(item['三级类']) || cleanStr(item['二级类']) || cleanStr(item['一级类']) || null,
    brand:       cleanStr(item['品牌']),
    linkTag:     cleanStr(item['链接打标']),
  };
}

export async function importPublicSeaFromDisk(): Promise<{
  totalFiles: number;
  totalRecords: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}> {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`数据目录不存在: ${DATA_DIR}`);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error('数据目录下没有 JSON 文件');
  }

  let totalRecords = 0;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    console.log(`[importPublicSea] 处理文件: ${file}`);

    // ── 阶段 A：解析 JSON ──────────────────────────────────────────
    // fileParseOk 标记：只有解析成功且全部批次入库完毕后才为 true。
    // 阶段 C 凭此决定是否归档——解析或入库中途抛出异常执行 continue，
    // 永远不会到达阶段 C，文件绝对保留在 public_sea_raw/。
    let items: RawItem[];
    let fileParseOk = false;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      items = JSON.parse(raw);
      if (!Array.isArray(items)) {
        console.error(`  非数组格式，跳过（文件保留在 public_sea_raw/）`);
        errors++;
        continue;
      }
      fileParseOk = true;
    } catch (e) {
      console.error(`  解析 JSON 失败（文件保留在 public_sea_raw/）:`, e);
      errors++;
      continue;
    }

    // ── 阶段 B：批量入库 ────────────────────────────────────────────
    console.log(`  共 ${items!.length} 条记录`);
    totalRecords += items!.length;

    const BATCH_SIZE = 100;
    for (let i = 0; i < items!.length; i += BATCH_SIZE) {
      const batch = items!.slice(i, i + BATCH_SIZE);

      const ops = batch.map((item) => {
        const pnk = item['PNK码']?.trim();
        if (!pnk) return null;

        const updateData = buildUpdateData(item, pnk);

        // ★ 业务铁律：update 块绝对不含 status 字段
        //   - create：新产品默认进公海（status = PENDING）
        //   - update：已有产品只刷新价格/评分等可变字段，
        //             status/ownerId/collectedAt 等业务状态保持不变，
        //             防止 SELECTED/PURCHASING/ORDERED 产品被打回公海
        return prisma.product.upsert({
          where:  { pnk },
          create: { pnk, ...updateData, status: 'PENDING' },
          update: updateData,
        });
      }).filter(Boolean);

      if (ops.length === 0) {
        skipped += batch.length;
        continue;
      }

      try {
        const results = await prisma.$transaction(ops as any[]);
        for (const r of results) {
          const rec = r as { createdAt: Date; updatedAt: Date };
          // createdAt ≈ updatedAt（误差 < 100ms）说明是本次新增
          if (Math.abs(rec.createdAt.getTime() - rec.updatedAt.getTime()) < 100) {
            inserted++;
          } else {
            updated++;
          }
        }
      } catch (batchErr) {
        console.error(`  ⚠️  批次 [${i}~${i + batch.length - 1}] 事务失败，逐条回退重试...`);

        for (const item of batch) {
          const pnk = item['PNK码']?.trim();
          if (!pnk) { skipped++; continue; }

          try {
            const updateData = buildUpdateData(item, pnk);
            const r = await prisma.product.upsert({
              where:  { pnk },
              create: { pnk, ...updateData, status: 'PENDING' },
              update: updateData,
            });
            if (Math.abs(r.createdAt.getTime() - r.updatedAt.getTime()) < 100) {
              inserted++;
            } else {
              updated++;
            }
          } catch {
            errors++;
          }
        }
      }

      if ((i + BATCH_SIZE) % 500 === 0 || i + BATCH_SIZE >= items!.length) {
        console.log(`  进度: ${Math.min(i + BATCH_SIZE, items!.length)}/${items!.length}`);
      }
    }

    // ── 阶段 C：归档 ───────────────────────────────────────────────
    // 事务安全性保证：走到此处意味着阶段 A+B 已完整执行完毕。
    // 若 A 或 B 中任何 throw 触发了 continue，此块永远不会被执行。
    if (fileParseOk) {
      try {
        await archiveFile(filePath, file);
      } catch (archiveErr) {
        // 归档失败不影响已入库的业务数据，仅打印警告，不计入 errors
        console.warn(`  ⚠️  归档失败（数据已安全入库，请手动移动文件）:`, archiveErr);
      }
    }
  }

  console.log(
    `[importPublicSea] 完成！文件=${files.length}, 总记录=${totalRecords}, ` +
    `新增=${inserted}, 更新=${updated}, 跳过=${skipped}, 错误=${errors}`,
  );

  return { totalFiles: files.length, totalRecords, inserted, updated, skipped, errors };
}
