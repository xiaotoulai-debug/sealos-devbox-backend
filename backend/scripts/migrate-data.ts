#!/usr/bin/env npx tsx
/**
 * 数据库迁移脚本：Supabase → Sealos
 *
 * 环境变量：
 *   SOURCE_DATABASE_URL  - 源库（Supabase DIRECT_URL，需直连非 pgBouncer）
 *   DEST_DATABASE_URL    - 目标库（Sealos 公网，如 postgresql://user:pass@dbconn.sealoszh.site:46096/postgres）
 *
 * 执行：cd backend && npm run migrate:data
 * 需在 backend/.env 中配置 SOURCE_DATABASE_URL(DIRECT_URL) 和 DEST_DATABASE_URL
 *
 * 迁移完成后请到 Sealos 后台关闭数据库「外网地址」开关！
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { Client } from 'pg';
import { execSync } from 'child_process';
import * as fs from 'fs';

const SOURCE = process.env.SOURCE_DATABASE_URL || process.env.DIRECT_URL;
const DEST = process.env.DEST_DATABASE_URL;

if (!SOURCE) {
  console.error('❌ 缺少 SOURCE_DATABASE_URL 或 DIRECT_URL');
  process.exit(1);
}
if (!DEST) {
  console.error('❌ 缺少 DEST_DATABASE_URL');
  process.exit(1);
}

// Prisma 表名及依赖顺序（父表在前）
const TABLES = [
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'purchase_orders',
  'products',
  'alibaba_auth',
  'shop_authorizations',
  '_prisma_migrations', // 迁移记录（可选）
];

async function run() {
  console.log('📦 开始迁移: Supabase → Sealos');
  console.log('   源:', SOURCE.replace(/:[^:@]+@/, ':****@'));
  console.log('   目标:', DEST.replace(/:[^:@]+@/, ':****@'));
  console.log('');

  const sourceClient = new Client({ connectionString: SOURCE });
  const destClient = new Client({ connectionString: DEST });

  try {
    await sourceClient.connect();
    await destClient.connect();
    console.log('✅ 两端数据库连接成功\n');

    // 1. 目标库先执行 Prisma schema（确保表结构存在）
    console.log('📐 步骤 1/2: 在目标库创建/更新表结构...');
    const backendDir = path.resolve(__dirname, '..');
    const prismaSchema = path.join(backendDir, 'prisma/schema.prisma');
    if (!fs.existsSync(prismaSchema)) {
      throw new Error(`未找到 ${prismaSchema}`);
    }
    const origUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = DEST;
    process.env.DIRECT_URL = DEST;
    try {
      execSync('npx prisma db push --accept-data-loss', {
        cwd: backendDir,
        stdio: 'inherit',
      });
    } catch (e) {
      console.warn('⚠️  prisma db push 失败，尝试用 SQL 初始化表结构...');
      try {
        const schemaPath = path.join(backendDir, 'schema-init.sql');
        if (fs.existsSync(schemaPath)) {
          const raw = fs.readFileSync(schemaPath, 'utf8').replace(/^\uFEFF/, '').replace(/--[^\n]*\n/g, '\n');
          const stmts = raw.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && (s.startsWith('CREATE') || s.startsWith('ALTER')));
          for (const stmt of stmts) {
            try {
              await destClient.query(stmt + ';');
            } catch (e: any) {
              if (!e.message?.includes('already exists')) throw e;
            }
          }
          console.log('   表结构就绪');
        }
      } catch (sqlErr: any) {
        if (sqlErr.message?.includes('already exists')) {
          console.log('   表已存在，继续复制数据');
        } else {
          throw sqlErr;
        }
      }
    } finally {
      process.env.DATABASE_URL = origUrl;
      process.env.DIRECT_URL = origUrl;
    }
    console.log('');

    // 2. 按表复制数据
    console.log('📋 步骤 2/2: 复制数据...');
    for (const table of TABLES) {
      let res;
      try {
        res = await sourceClient.query(`SELECT COUNT(*) FROM "${table}"`);
      } catch (_) {
        console.log(`   ${table}: 源库不存在 (跳过)`);
        continue;
      }
      const count = parseInt(res.rows[0].count, 10);
      if (count === 0) {
        console.log(`   ${table}: 0 行 (跳过)`);
        continue;
      }

      try {
        await destClient.query(`TRUNCATE TABLE "${table}" CASCADE`);
      } catch (e) {
        console.log(`   ${table}: 目标表不存在或无法清空，跳过`);
        continue;
      }
      const colsRes = await sourceClient.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      const cols = colsRes.rows.map((r) => r.column_name);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      const rows = await sourceClient.query(`SELECT ${colList} FROM "${table}"`);
      let inserted = 0;
      for (const row of rows.rows) {
        const values = cols.map((c) => row[c]);
        await destClient.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
          values,
        );
        inserted++;
        if (inserted % 500 === 0) process.stdout.write(`  ${table}: ${inserted}/${count}\r`);
      }
      // 重置自增序列（仅对有 id 序列的表）
      if (cols.includes('id')) {
        try {
          await destClient.query(
            `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`,
          );
        } catch (_) {
          /* 无序列则忽略 */
        }
      }
      console.log(`   ${table}: ${inserted} 行 ✓`);
    }

    console.log('\n✅ 迁移完成');
    console.log('\n⚠️  安全提醒：请立即到 Sealos 后台关闭数据库「外网地址」开关！');
  } catch (e) {
    console.error('\n❌ 迁移失败:', e);
    process.exit(1);
  } finally {
    await sourceClient.end();
    await destClient.end();
  }
}

run();
