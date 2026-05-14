-- StoreProduct identity hardening:
-- eMAG may move one Offer/SKU to a new PNK. PNK remains searchable, but
-- the shop-level business identity is now SKU / vendor SKU / Offer ID.

ALTER TABLE "store_products"
  ADD COLUMN IF NOT EXISTS "is_archived" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "store_products_shop_id_sku_key"
  ON "store_products"("shop_id", "sku");

CREATE UNIQUE INDEX IF NOT EXISTS "store_products_shop_id_vendor_sku_key"
  ON "store_products"("shop_id", "vendor_sku");

CREATE UNIQUE INDEX IF NOT EXISTS "store_products_shop_id_emag_offer_id_key"
  ON "store_products"("shop_id", "emag_offer_id");

CREATE INDEX IF NOT EXISTS "store_products_shop_id_ean_idx"
  ON "store_products"("shop_id", "ean");

CREATE INDEX IF NOT EXISTS "store_products_is_archived_idx"
  ON "store_products"("is_archived");
