CREATE TABLE IF NOT EXISTS "store_product_inventory_snapshots" (
  "id" SERIAL PRIMARY KEY,
  "shop_id" INTEGER NOT NULL,
  "store_product_id" INTEGER NOT NULL,
  "sku" TEXT,
  "snapshot_date" DATE NOT NULL,
  "platform_stock" INTEGER NOT NULL DEFAULT 0,
  "in_transit_stock" INTEGER NOT NULL DEFAULT 0,
  "sales_7" INTEGER NOT NULL DEFAULT 0,
  "sales_14" INTEGER NOT NULL DEFAULT 0,
  "sales_30" INTEGER NOT NULL DEFAULT 0,
  "comprehensive_sales" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "store_product_inventory_snapshots_store_product_id_fkey"
    FOREIGN KEY ("store_product_id") REFERENCES "store_products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "store_product_inventory_snapshots_store_product_id_snapshot_date_key"
  ON "store_product_inventory_snapshots"("store_product_id", "snapshot_date");

CREATE INDEX IF NOT EXISTS "store_product_inventory_snapshots_shop_id_snapshot_date_idx"
  ON "store_product_inventory_snapshots"("shop_id", "snapshot_date");

CREATE INDEX IF NOT EXISTS "store_product_inventory_snapshots_shop_id_sku_snapshot_date_idx"
  ON "store_product_inventory_snapshots"("shop_id", "sku", "snapshot_date");

CREATE INDEX IF NOT EXISTS "store_product_inventory_snapshots_store_product_id_idx"
  ON "store_product_inventory_snapshots"("store_product_id");
