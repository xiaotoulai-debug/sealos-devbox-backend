-- ============================================================
-- Migration A：利润准确化第一阶段数据模型基础
-- 生成时间：2026-06-25
-- 状态：【草案，仅供审阅，未执行，禁止直接运行】
-- ============================================================
-- 执行前必须确认：
--   1. 当前数据库中 store_products.vat_id / vat_rate 已存在（影子列）
--      → ② 中 vat_id / vat_rate 的 ADD COLUMN 已注释
--   2. vat_mappings 表不存在（下方 CREATE TABLE 安全）
--   3. 执行前请在测试环境验证，再由老板批准后在生产执行
-- ============================================================

-- ① 新建 VatMapping 表
-- （全新表，无冲突）
CREATE TABLE "vat_mappings" (
    "id"         SERIAL,
    "shop_id"    INTEGER       NOT NULL,
    "region"     TEXT,
    "vat_id"     INTEGER       NOT NULL,
    "vat_rate"   DECIMAL(8,6),
    "synced_at"  TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT "vat_mappings_pkey" PRIMARY KEY ("id")
);

-- VatMapping 唯一约束
ALTER TABLE "vat_mappings"
    ADD CONSTRAINT "vat_mappings_shop_id_vat_id_key"
    UNIQUE ("shop_id", "vat_id");

-- VatMapping 外键
ALTER TABLE "vat_mappings"
    ADD CONSTRAINT "vat_mappings_shop_id_fkey"
    FOREIGN KEY ("shop_id")
    REFERENCES "shop_authorizations"("id")
    ON DELETE CASCADE;

-- VatMapping 索引
CREATE INDEX "vat_mappings_shop_id_synced_at_idx"
    ON "vat_mappings"("shop_id", "synced_at");

-- ② StoreProduct 新增字段
-- 注意：vat_id / vat_rate 为影子列，已存在，禁止重复 ADD COLUMN
-- （以下注释行仅作说明，实际 vat_id/vat_rate 已在数据库中）
-- ALTER TABLE "store_products" ADD COLUMN "vat_id"   INTEGER;     ← 已存在，跳过
-- ALTER TABLE "store_products" ADD COLUMN "vat_rate" DECIMAL(8,6); ← 已存在，跳过

ALTER TABLE "store_products"
    ADD COLUMN "vat_synced_at"          TIMESTAMPTZ,
    ADD COLUMN "fbe_fee"                DECIMAL(10, 2),
    ADD COLUMN "fbe_currency"           TEXT,
    ADD COLUMN "fbe_source"             TEXT,
    ADD COLUMN "fbe_updated_at"         TIMESTAMPTZ,
    ADD COLUMN "commission_rate_source" TEXT;

-- ③ 历史佣金来源安全回填
-- 规则：commission_rate 非空 且 commission_rate_source 为空 → 标记为 LEGACY_DICTIONARY
-- 禁止使用：exact / EMAG_API_ESTIMATE
-- 影响行数预估：约 48 条（当前 commissionRate 非空记录）
UPDATE "store_products"
    SET "commission_rate_source" = 'LEGACY_DICTIONARY'
    WHERE "commission_rate" IS NOT NULL
      AND "commission_rate_source" IS NULL;
