ALTER TABLE "store_products"
  ADD COLUMN IF NOT EXISTS "product_class" TEXT,
  ADD COLUMN IF NOT EXISTS "classification_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "classification_metrics" JSONB,
  ADD COLUMN IF NOT EXISTS "classified_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "store_products_shop_id_product_class_idx"
  ON "store_products"("shop_id", "product_class");

CREATE INDEX IF NOT EXISTS "store_products_shop_id_product_class_comprehensive_sales_idx"
  ON "store_products"("shop_id", "product_class", "comprehensive_sales" DESC);
