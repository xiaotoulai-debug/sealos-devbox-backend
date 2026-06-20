-- AlterTable
ALTER TABLE "products" ADD COLUMN     "fbe_fee_note" TEXT,
ADD COLUMN     "fbe_fee_source" VARCHAR(32),
ADD COLUMN     "fbe_fee_updated_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "store_products" ADD COLUMN     "fbe_fee_override_cny" DECIMAL(10,2),
ADD COLUMN     "fbe_fee_override_note" TEXT,
ADD COLUMN     "fbe_fee_override_source" VARCHAR(32),
ADD COLUMN     "fbe_fee_override_updated_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "fbe_fee_change_logs" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER,
    "store_product_id" INTEGER,
    "shop_id" INTEGER,
    "sku" TEXT,
    "pnk" TEXT,
    "scope" VARCHAR(32) NOT NULL,
    "old_fee_cny" DECIMAL(10,2),
    "new_fee_cny" DECIMAL(10,2) NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "note" TEXT,
    "operator_user_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fbe_fee_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fbe_fee_change_logs_product_id_created_at_idx" ON "fbe_fee_change_logs"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "fbe_fee_change_logs_store_product_id_created_at_idx" ON "fbe_fee_change_logs"("store_product_id", "created_at");

-- CreateIndex
CREATE INDEX "fbe_fee_change_logs_shop_id_created_at_idx" ON "fbe_fee_change_logs"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "fbe_fee_change_logs_sku_created_at_idx" ON "fbe_fee_change_logs"("sku", "created_at");

-- CreateIndex
CREATE INDEX "fbe_fee_change_logs_scope_created_at_idx" ON "fbe_fee_change_logs"("scope", "created_at");

-- AddForeignKey
ALTER TABLE "fbe_fee_change_logs" ADD CONSTRAINT "fbe_fee_change_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_fee_change_logs" ADD CONSTRAINT "fbe_fee_change_logs_store_product_id_fkey" FOREIGN KEY ("store_product_id") REFERENCES "store_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_fee_change_logs" ADD CONSTRAINT "fbe_fee_change_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_fee_change_logs" ADD CONSTRAINT "fbe_fee_change_logs_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill legacy SKU default FBE metadata without changing fee values
UPDATE "products"
SET
  "fbe_fee_source" = 'LEGACY_PRODUCT_DEFAULT',
  "fbe_fee_updated_at" = CURRENT_TIMESTAMP
WHERE "fbe_fee" IS NOT NULL
  AND "fbe_fee_source" IS NULL;
