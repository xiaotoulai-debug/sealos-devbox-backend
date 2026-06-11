-- CreateEnum
CREATE TYPE "AlibabaTokenType" AS ENUM ('oauth', 'enterprise_static');

-- AlterTable: alibaba_auth 多账号字段
ALTER TABLE "alibaba_auth" ADD COLUMN "account_name" TEXT;
UPDATE "alibaba_auth" SET "account_name" = COALESCE(NULLIF(TRIM("login_id"), ''), '默认1688账号');
ALTER TABLE "alibaba_auth" ALTER COLUMN "account_name" SET NOT NULL;

ALTER TABLE "alibaba_auth" ADD COLUMN "token_type" "AlibabaTokenType" NOT NULL DEFAULT 'oauth';
ALTER TABLE "alibaba_auth" ADD COLUMN "is_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "alibaba_auth" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "alibaba_auth" ADD COLUMN "remark" TEXT;
ALTER TABLE "alibaba_auth" ADD COLUMN "last_validated_at" TIMESTAMP(3);

-- 保留的唯一旧 OAuth 记录设为默认账号
UPDATE "alibaba_auth"
SET "is_default" = true
WHERE "id" = (
  SELECT "id" FROM "alibaba_auth" ORDER BY "updated_at" DESC NULLS LAST, "id" DESC LIMIT 1
);

ALTER TABLE "alibaba_auth" ALTER COLUMN "refresh_token" DROP NOT NULL;

CREATE INDEX "alibaba_auth_is_enabled_idx" ON "alibaba_auth"("is_enabled");
CREATE INDEX "alibaba_auth_is_default_idx" ON "alibaba_auth"("is_default");

-- AlterTable: purchase_orders 关联 1688 账号
ALTER TABLE "purchase_orders" ADD COLUMN "alibaba_auth_id" INTEGER;

ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_alibaba_auth_id_fkey"
  FOREIGN KEY ("alibaba_auth_id") REFERENCES "alibaba_auth"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "purchase_orders_alibaba_auth_id_idx" ON "purchase_orders"("alibaba_auth_id");
