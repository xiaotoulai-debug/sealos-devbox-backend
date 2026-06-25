-- AddColumn: platform diagnostics fields to store_products
ALTER TABLE "store_products" ADD COLUMN "has_platform_attention" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_products" ADD COLUMN "has_blocking_issue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "store_products" ADD COLUMN "platform_diagnostics" JSONB;
ALTER TABLE "store_products" ADD COLUMN "emag_status_snapshot" JSONB;
ALTER TABLE "store_products" ADD COLUMN "diagnostics_updated_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "store_products_shop_id_has_platform_attention_idx" ON "store_products"("shop_id", "has_platform_attention");
CREATE INDEX "store_products_shop_id_has_blocking_issue_idx" ON "store_products"("shop_id", "has_blocking_issue");
