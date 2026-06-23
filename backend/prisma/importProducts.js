"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
// Sealos 外网开发：内网 DATABASE_URL 不可达时，使用 DEST_DATABASE_URL
if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
    process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');
const UPLOAD_DIR = path_1.default.join(__dirname, 'data_uploads');
const ARCHIVE_DIR = path_1.default.join(UPLOAD_DIR, 'processed'); // 归档目录
const BATCH_SIZE = 50; // upsert 无法批量，改小批次并发控制
// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────
/**
 * 解析价格字符串，兼容以下格式：
 *   "de la 499.99"   →  499.99
 *   "195,49"         →  195.49
 *   "1.036,07"       →  1036.07   （点=千分符，逗号=小数点）
 *   "1.036.07"       →  1036.07   （最后一个点=小数点，前面的点=千分符）
 *   "1.200.500,00"   →  1200500.0
 *   "1,299.99"       →  1299.99   （逗号=千分符，点=小数点）
 *   "5.490 Lei"      →  5490      （无小数，点=千分符）
 */
function parsePrice(val) {
    if (!val || String(val).trim() === '')
        return 0;
    let s = String(val)
        .trim()
        .replace(/de\s+la/gi, '') // 去掉 "de la" 前缀
        .replace(/[A-Za-z€$£¥₹]/g, '') // 去掉货币单位
        .replace(/\s/g, ''); // 去掉所有空格
    if (!s)
        return 0;
    const dotCount = (s.match(/\./g) ?? []).length;
    const commaCount = (s.match(/,/g) ?? []).length;
    if (commaCount === 1 && dotCount === 0) {
        // "195,49" —— 逗号是小数点
        s = s.replace(',', '.');
    }
    else if (commaCount === 1 && dotCount >= 1) {
        // "1.036,07" / "1.200.500,07" —— 点是千分符，逗号是小数点
        s = s.replace(/\./g, '').replace(',', '.');
    }
    else if (commaCount === 0 && dotCount > 1) {
        // "1.036.07" —— 多个点：最后一个是小数点，前面的是千分符
        const lastDot = s.lastIndexOf('.');
        s = s.slice(0, lastDot).replace(/\./g, '') + '.' + s.slice(lastDot + 1);
    }
    else if (commaCount === 0 && dotCount === 1) {
        // "499.99" 或 "5.490"（无小数的千分符）——直接用，parseFloat 能处理
        // 区分不了 "5.490"(千分) vs "5.490"(小数)，保留原样让后续解析
    }
    else if (commaCount > 1) {
        // "1,200,500" —— 逗号是千分符，去掉即可
        s = s.replace(/,/g, '');
    }
    const match = s.match(/-?\d+(\.\d+)?/);
    if (!match)
        return 0;
    const n = parseFloat(match[0]);
    return isNaN(n) ? 0 : n;
}
function parseRating(val) {
    if (!val || String(val).trim() === '')
        return null;
    const n = parseFloat(String(val));
    if (isNaN(n))
        return null;
    return parseFloat(Math.min(5, Math.max(0, n)).toFixed(2));
}
function parseIntOrNull(val) {
    if (!val || String(val).trim() === '')
        return null;
    const n = parseInt(String(val).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
}
function resolveCategory(row) {
    return row['四级类']?.trim() || row['三级类']?.trim()
        || row['二级类']?.trim() || row['一级类']?.trim() || null;
}
// ─────────────────────────────────────────────────────────────
// 智能兜底：从标题推断品牌
// ─────────────────────────────────────────────────────────────
let _cachedBrands = null;
function buildBrandList(allRows) {
    if (_cachedBrands)
        return _cachedBrands;
    const set = new Set();
    for (const r of allRows) {
        const b = r['品牌']?.trim();
        if (b)
            set.add(b);
    }
    _cachedBrands = [...set].sort((a, b) => b.length - a.length);
    return _cachedBrands;
}
function inferBrandFromTitle(title, allRows) {
    const brands = buildBrandList(allRows);
    const tLow = title.toLowerCase();
    for (const b of brands) {
        if (tLow.includes(b.toLowerCase()))
            return b;
    }
    return null;
}
const PHONE_L1 = 'Laptop, Tablete & Telefoane';
const PHONE_L2 = 'Telefoane mobile & accesorii';
const TITLE_CAT_RULES = [
    { test: t => /^telefon\s+mobil\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Telefoane Mobile' } }, // l4 会拼上品牌
    { test: t => /\bhus[aă]\b/i.test(t) || /\bcarcas[aă]\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Huse telefoane' } },
    { test: t => /\bfoli[ei]\b.*\bprotec[tț]ie\b/i.test(t) || /\bfoli[ei]\b.*\bsticl[aă]\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Folii protectie telefoane' } },
    { test: t => /\b[iî]nc[aă]rc[aă]tor\b/i.test(t) && !/\bwireless\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Incarcatoare telefoane' } },
    { test: t => /\b[iî]nc[aă]rc[aă]tor\b.*\bwireless\b/i.test(t) || /\bwireless\b.*\bcharger\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Incarcatoare telefoane' } },
    { test: t => /\bcablu\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Cabluri de date telefoane' } },
    { test: t => /\bpower\s*bank\b/i.test(t) || /\bbaterie\s+extern[aă]\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Power bank telefoane' } },
    { test: t => /\bacumulator\b/i.test(t) || (/\bbaterie\b/i.test(t) && /\b(telefon|iphone|galaxy|samsung|compatibil)\b/i.test(t)),
        cat: { l3: 'Piese si componente telefoane', l4: 'Baterii telefoane' } },
    { test: t => /\bdisplay\b/i.test(t) || /\btouchscreen\b/i.test(t),
        cat: { l3: 'Piese si componente telefoane', l4: 'Display-uri si touchscreen telefoane' } },
    { test: t => /\bselfie\s+stick\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Selfie stick-uri' } },
    { test: t => /\bcard\s+(de\s+)?memorie\b/i.test(t) || /\bmemory\s+card\b/i.test(t) || /\bmicrosd\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Carduri memorie' } },
    { test: t => /\bcititor\s+(de\s+)?carduri\b/i.test(t) || /\bcard\s+reader\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Card reader' } },
    { test: t => /\badapt[oa][ro]\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Adaptoare telefoane mobile' } },
    { test: t => /\bsuport\b/i.test(t) || /\bdocking\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Suport si docking telefoane' } },
    { test: t => /\bmemorie\s+extern[aă]\b/i.test(t) || /\busb\s+flash\b/i.test(t),
        cat: { l3: 'Accesorii Telefoane', l4: 'Memorie externa telefon mobil' } },
    { test: t => /\btelefon\s+f[aă]r[aă]\s+fir\b/i.test(t),
        cat: { l3: 'Telefoane fixe & Sisteme teleconferinta', l4: 'Telefoane fara fir' } },
    { test: t => /\btelefon\s+cu\s+fir\b/i.test(t) || /\btelefon\s+fix\b/i.test(t),
        cat: { l3: 'Telefoane fixe & Sisteme teleconferinta', l4: 'Telefoane cu fir' } },
];
function inferCategories(title, brand) {
    for (const rule of TITLE_CAT_RULES) {
        if (rule.test(title)) {
            let l4 = rule.cat.l4;
            if (l4 === 'Telefoane Mobile' && brand) {
                l4 = `Telefoane Mobile ${brand}`;
            }
            return { l1: PHONE_L1, l2: PHONE_L2, l3: rule.cat.l3, l4 };
        }
    }
    return { l1: PHONE_L1, l2: PHONE_L2, l3: 'Accesorii Telefoane', l4: 'Alte accesorii telefoane' };
}
// ─────────────────────────────────────────────────────────────
// 解析单行
// ─────────────────────────────────────────────────────────────
function parseRow(row, idx, fileName, allRows) {
    const pnk = row['PNK码']?.trim();
    const title = row['产品标题']?.trim();
    if (!pnk || !title) {
        console.warn(`     ⚠️  第 ${idx + 1} 行缺少 PNK码 或 产品标题，跳过`);
        return null;
    }
    const costRaw = row['PRP原价']?.trim() ? parsePrice(row['PRP原价']) : null;
    let brand = row['品牌']?.trim() || null;
    let l1 = row['一级类']?.trim() || null;
    let l2 = row['二级类']?.trim() || null;
    let l3 = row['三级类']?.trim() || null;
    let l4 = row['四级类']?.trim() || null;
    if (!brand) {
        brand = inferBrandFromTitle(title, allRows);
    }
    if (!l1) {
        const inferred = inferCategories(title, brand);
        if (inferred) {
            l1 = inferred.l1;
            l2 = inferred.l2;
            l3 = inferred.l3;
            l4 = inferred.l4;
        }
    }
    return {
        pnk,
        title,
        brand,
        category: l4 || l3 || l2 || l1 || resolveCategory(row),
        categoryL1: l1,
        categoryL2: l2,
        categoryL3: l3,
        categoryL4: l4,
        price: parsePrice(row['前端价格']),
        costPrice: costRaw != null && costRaw > 0 ? costRaw : null,
        imageUrl: row['产品图片']?.trim() || null,
        productUrl: row['产品链接']?.trim() || null,
        rating: parseRating(row['评论分数']),
        reviewCount: parseIntOrNull(row['评价数量']),
        linkTag: row['链接打标']?.trim().replace(/\s+/g, ' ') || null,
        tags: [],
        stock: 0,
        status: 'PENDING',
    };
}
async function processFile(filePath) {
    const fileName = path_1.default.basename(filePath);
    const result = { file: fileName, total: 0, upserted: 0, created: 0, updated: 0, skipped: 0 };
    console.log(`\n┌─ 正在处理：${fileName}`);
    // 读取 & 解析 JSON
    let rows = [];
    try {
        const raw = JSON.parse(fs_1.default.readFileSync(filePath, 'utf-8'));
        rows = Array.isArray(raw)
            ? raw
            : Array.isArray(raw.data)
                ? (raw.data)
                : [];
    }
    catch {
        console.error(`│  ❌ JSON 解析失败，跳过该文件`);
        return result;
    }
    result.total = rows.length;
    console.log(`│  原始数据：${result.total} 条`);
    if (rows.length === 0) {
        console.warn(`│  ⚠️  无数据行`);
        archiveFile(filePath);
        return result;
    }
    // 解析行
    const parsed = [];
    for (let i = 0; i < rows.length; i++) {
        const p = parseRow(rows[i], i, fileName, rows);
        if (p)
            parsed.push(p);
        else
            result.skipped++;
    }
    console.log(`│  解析成功：${parsed.length} 条${result.skipped > 0 ? `（跳过 ${result.skipped} 条字段缺失）` : ''}`);
    if (DRY_RUN) {
        console.log(`│  🔍 预检模式，不写入数据库`);
        if (parsed[0]) {
            const s = parsed[0];
            console.log(`│  首条预览：pnk=${s.pnk} | price=${s.price} | category=${s.category}`);
            console.log(`│           title=${s.title.slice(0, 50)}`);
        }
        console.log(`└─ 预检完毕（文件未归档）`);
        return result;
    }
    // 分批 upsert（并发控制，每批 BATCH_SIZE 条串行执行）
    console.log(`│  开始 upsert（${parsed.length} 条）...`);
    for (let start = 0; start < parsed.length; start += BATCH_SIZE) {
        const batch = parsed.slice(start, start + BATCH_SIZE);
        // 并发执行一批 upsert
        const outcomes = await Promise.allSettled(batch.map((p) => prisma.product.upsert({
            where: { pnk: p.pnk },
            create: p,
            update: {
                title: p.title,
                brand: p.brand,
                category: p.category,
                categoryL1: p.categoryL1,
                categoryL2: p.categoryL2,
                categoryL3: p.categoryL3,
                categoryL4: p.categoryL4,
                price: p.price,
                costPrice: p.costPrice,
                imageUrl: p.imageUrl,
                productUrl: p.productUrl,
                rating: p.rating,
                reviewCount: p.reviewCount,
                linkTag: p.linkTag,
                // status / stock / ownerId 不覆盖（保留人工调整值）
            },
        }).then((rec) => ({ pnk: rec.pnk, isNew: rec.createdAt.getTime() === rec.updatedAt.getTime() }))));
        for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled') {
                result.upserted++;
                // createdAt ≈ updatedAt → 新建；否则 → 更新
                if (outcome.value.isNew)
                    result.created++;
                else
                    result.updated++;
            }
            else {
                console.error(`│  ❌ upsert 失败：`, outcome.reason);
            }
        }
        const progress = Math.min(start + BATCH_SIZE, parsed.length);
        process.stdout.write(`\r│  进度：${progress}/${parsed.length}`);
    }
    process.stdout.write('\n');
    console.log(`│  ✅ 完成：新建 ${result.created} 条，更新 ${result.updated} 条`);
    // 归档文件
    archiveFile(filePath);
    return result;
}
/** 将已处理文件移入 processed/ 归档目录 */
function archiveFile(filePath) {
    if (DRY_RUN)
        return; // 预检模式不归档
    const dest = path_1.default.join(ARCHIVE_DIR, path_1.default.basename(filePath));
    try {
        fs_1.default.renameSync(filePath, dest);
        console.log(`└─ ✅ 已归档至 processed/${path_1.default.basename(filePath)}`);
    }
    catch (e) {
        console.error(`└─ ⚠️  归档失败（文件仍在原位置）:`, e);
    }
}
// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────
async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   eMAG 八爪鱼产品数据导入 v2（Upsert + 归档）    ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`  模式：${DRY_RUN ? '🔍 预检（不写入 / 不归档）' : '🚀 正式导入'}`);
    console.log(`  目录：${UPLOAD_DIR}\n`);
    // 确保目录存在
    if (!fs_1.default.existsSync(UPLOAD_DIR)) {
        fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
        console.error('❌ data_uploads/ 目录不存在，已自动创建，请放入 .json 文件后重新运行\n');
        process.exit(1);
    }
    if (!fs_1.default.existsSync(ARCHIVE_DIR)) {
        fs_1.default.mkdirSync(ARCHIVE_DIR, { recursive: true });
        console.log(`📁 已自动创建归档目录：processed/\n`);
    }
    // 扫描待处理文件：data_uploads/ 根目录 + public_sea_raw/ + processed/（全量导入）
    const rootFiles = (fs_1.default.readdirSync(UPLOAD_DIR, { withFileTypes: true }) || [])
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'))
        .map((e) => path_1.default.join(UPLOAD_DIR, e.name));
    const rawDir = path_1.default.join(UPLOAD_DIR, 'public_sea_raw');
    const rawFiles = fs_1.default.existsSync(rawDir)
        ? fs_1.default.readdirSync(rawDir).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => path_1.default.join(rawDir, f))
        : [];
    const procFiles = fs_1.default.existsSync(ARCHIVE_DIR)
        ? fs_1.default.readdirSync(ARCHIVE_DIR).filter((f) => f.toLowerCase().endsWith('.json')).map((f) => path_1.default.join(ARCHIVE_DIR, f))
        : [];
    const files = [...rootFiles, ...rawFiles, ...procFiles].sort();
    if (files.length === 0) {
        console.log('ℹ️  data_uploads/ 下没有待处理的 .json 文件。');
        console.log('   已归档的历史文件在 data_uploads/processed/ 中。\n');
        return;
    }
    console.log(`📂 发现 ${files.length} 个待处理文件：`);
    files.forEach((f, i) => console.log(`   ${i + 1}. ${path_1.default.basename(f)}`));
    // 逐文件处理
    const results = [];
    for (let i = 0; i < files.length; i++) {
        const r = await processFile(files[i]);
        results.push(r);
    }
    // 全局汇总
    const totRaw = results.reduce((s, r) => s + r.total, 0);
    const totUpserted = results.reduce((s, r) => s + r.upserted, 0);
    const totCreated = results.reduce((s, r) => s + r.created, 0);
    const totUpdated = results.reduce((s, r) => s + r.updated, 0);
    const totSkipped = results.reduce((s, r) => s + r.skipped, 0);
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(DRY_RUN
        ? '║  预检完成，未写入数据库，文件未归档              ║'
        : '║  全部文件处理完毕！                              ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`  文件数     : ${files.length} 个`);
    console.log(`  原始总行数 : ${totRaw} 条`);
    if (!DRY_RUN) {
        console.log(`  ✅ upsert  : ${totUpserted} 条（新建 ${totCreated} + 更新 ${totUpdated}）`);
        if (totSkipped > 0)
            console.log(`  ⚠️  跳过    : ${totSkipped} 条（字段缺失）`);
    }
    console.log('\n  各文件明细：');
    results.forEach((r) => {
        const detail = DRY_RUN
            ? `可导入 ${r.total - r.skipped}`
            : `新建 ${r.created} | 更新 ${r.updated}`;
        console.log(`    ${r.file.padEnd(28)} 原始 ${String(r.total).padStart(5)} | ${detail}`);
    });
    console.log('╚══════════════════════════════════════════════════╝\n');
}
main()
    .catch((e) => { console.error('\n❌ 脚本异常:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=importProducts.js.map