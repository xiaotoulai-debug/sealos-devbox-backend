-- AlterTable: 平台产品首次有货时间（新品观察期基准）
ALTER TABLE "store_products" ADD COLUMN "first_available_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "store_products_shop_id_first_available_at_idx" ON "store_products"("shop_id", "first_available_at");
