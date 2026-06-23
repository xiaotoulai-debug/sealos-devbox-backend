/**
 * 公海产品 JSON 导入脚本 — Phase 1（独立命令行入口）
 *
 * 从 backend/prisma/data_uploads/public_sea_raw/*.json 批量导入公海产品。
 *
 * 业务规则（核心铁律）：
 *   - 新产品 (create)：status 固定为 PENDING，进入公海
 *   - 已有产品 (update)：只刷新价格、评分、类目等可变字段；
 *     status / ownerId / collectedAt 等业务字段一律保持原值，
 *     不允许将 SELECTED / PURCHASING / ORDERED 产品打回公海！
 *
 * 执行方式：
 *   cd /home/devbox/project/backend
 *   npx tsx scripts/import-public-sea.ts
 *   # 或通过 npm script：
 *   npm run ops:import-public-sea
 *
 * 重跑安全：upsert 以 pnk 为唯一键，幂等操作，可安全重复执行。
 */

import 'dotenv/config';
import { importPublicSeaFromDisk } from '../src/services/importPublicSea';

async function main(): Promise<void> {
  const start = Date.now();

  console.log('='.repeat(64));
  console.log(' 公海产品导入 — Phase 1：DB Upsert');
  console.log(`  启动：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('  ⚠️  status 保护已启用：update 不覆盖已有产品的业务状态');
  console.log('='.repeat(64) + '\n');

  let result: Awaited<ReturnType<typeof importPublicSeaFromDisk>>;
  try {
    result = await importPublicSeaFromDisk();
  } catch (fatal) {
    console.error('\n[FATAL] 导入过程发生不可恢复的错误：');
    console.error(fatal instanceof Error ? fatal.message : fatal);
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(64));
  console.log(' 导入完成');
  console.log(`  文件数：  ${result.totalFiles}`);
  console.log(`  总记录：  ${result.totalRecords}`);
  console.log(`  ✅ 新增：  ${result.inserted}`);
  console.log(`  🔄 更新：  ${result.updated}`);
  console.log(`  ⏭️  跳过：  ${result.skipped} （PNK 为空）`);
  console.log(`  ❌ 错误：  ${result.errors}`);
  console.log(`  ⏱  耗时：  ${elapsed}s`);
  console.log('='.repeat(64));

  if (result.errors > 0) {
    console.warn(`\n⚠️  有 ${result.errors} 条记录写入失败，请检查上方日志。`);
    console.warn('   可安全重跑本脚本，已成功的记录不会重复插入。');
  } else {
    console.log('\n✅ 全部完成，无错误。可继续执行 Phase 2 图片 OSS 迁移：');
    console.log('   npm run ops:migrate-sea-images');
  }

  process.exit(result.errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[FATAL] 未捕获异常:', e);
  process.exit(1);
});
