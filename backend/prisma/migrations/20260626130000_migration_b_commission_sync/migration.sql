-- Migration B：佣金同步字段扩展
--
-- 新增四个 nullable 字段，记录佣金 API 同步状态与原始响应
-- 所有字段均为 NULLABLE，不影响现有数据
-- 禁止执行：仅草案，需 DBA/老板审核批准后再 prisma migrate deploy
--
-- 对应 API：GET https://marketplace.emag.{region}/api/v1/commission/estimate/{emagOfferId}

ALTER TABLE "store_products"
  ADD COLUMN IF NOT EXISTS "commission_synced_at"           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "commission_last_attempt_at"     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "commission_api_created_raw"     TEXT,
  ADD COLUMN IF NOT EXISTS "commission_api_priority"        TEXT;

-- 字段说明：
-- commission_synced_at         : 最近一次成功获取 API 佣金率的时间（仅成功时更新）
-- commission_last_attempt_at   : 最近一次请求 API 的时间（成功/失败均更新，防高频重试）
-- commission_api_created_raw   : API 返回 data.created 原字符串，不做时区推断
-- commission_api_priority      : API 返回 data.priority 原值（如 "4"），保留备查
