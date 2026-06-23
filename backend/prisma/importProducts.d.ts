/**
 * 八爪鱼 eMAG 产品数据批量导入脚本 v2 — 全量扫描 + Upsert + 自动归档
 *
 * 数据库：读取 .env 中 DATABASE_URL（Sealos 外网可设 USE_EXTERNAL_DB=true 使用 DEST_DATABASE_URL）
 *
 * 工作流程：
 *   1. 扫描 data_uploads/ 下所有未处理的 .json 文件
 *   2. 逐文件解析并以 PNK 为唯一键执行 upsert（有则更新，无则新建）
 *   3. 处理完成后将文件移入 data_uploads/processed/ 归档，防止重复处理
 *   4. 打印每文件进度与全局汇总
 *
 * 字段映射：
 *   产品标题 → title       PNK码    → pnk
 *   产品链接 → productUrl  前端价格 → price
 *   PRP原价  → costPrice   产品图片 → imageUrl
 *   品牌     → brand       四级类   → category（逐级回退）
 *   评论分数 → rating      评价数量 → reviewCount
 *
 * 运行命令：
 *   正式导入：npx tsx prisma/importProducts.ts
 *   预检模式：npx tsx prisma/importProducts.ts --dry-run
 */
import 'dotenv/config';
//# sourceMappingURL=importProducts.d.ts.map