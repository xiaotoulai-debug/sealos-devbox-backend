-- AlterTable
ALTER TABLE "fbe_shipment_items" ADD COLUMN     "store_product_id" INTEGER;

-- CreateIndex
CREATE INDEX "fbe_shipment_items_store_product_id_idx" ON "fbe_shipment_items"("store_product_id");

-- AddForeignKey
ALTER TABLE "fbe_shipment_items" ADD CONSTRAINT "fbe_shipment_items_store_product_id_fkey" FOREIGN KEY ("store_product_id") REFERENCES "store_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
