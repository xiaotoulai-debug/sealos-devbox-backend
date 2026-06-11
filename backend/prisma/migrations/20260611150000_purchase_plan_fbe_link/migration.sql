-- 采购计划（Product）关联平台产品与 FBE 发货单状态回写
ALTER TABLE "products" ADD COLUMN "source_store_product_id" INTEGER;
ALTER TABLE "products" ADD COLUMN "fbe_shipment_id" INTEGER;
ALTER TABLE "products" ADD COLUMN "fbe_created_at" TIMESTAMP(3);
ALTER TABLE "products" ADD COLUMN "fbe_status" TEXT;

ALTER TABLE "products" ADD CONSTRAINT "products_source_store_product_id_fkey"
  FOREIGN KEY ("source_store_product_id") REFERENCES "store_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "products" ADD CONSTRAINT "products_fbe_shipment_id_fkey"
  FOREIGN KEY ("fbe_shipment_id") REFERENCES "fbe_shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "products_source_store_product_id_idx" ON "products"("source_store_product_id");
CREATE INDEX "products_fbe_shipment_id_idx" ON "products"("fbe_shipment_id");
