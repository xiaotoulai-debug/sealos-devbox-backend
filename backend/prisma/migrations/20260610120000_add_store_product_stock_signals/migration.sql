-- AlterTable: 首次库存信号时间（平台库存或在途）
ALTER TABLE "store_products" ADD COLUMN "first_stock_signal_at" TIMESTAMP(3),
ADD COLUMN "first_inbound_at" TIMESTAMP(3);

CREATE INDEX "store_products_shop_id_first_stock_signal_at_idx" ON "store_products"("shop_id", "first_stock_signal_at");
CREATE INDEX "store_products_shop_id_first_inbound_at_idx" ON "store_products"("shop_id", "first_inbound_at");
