-- CreateEnum
CREATE TYPE "EmagRegion" AS ENUM ('RO', 'BG', 'HU');

-- CreateEnum
CREATE TYPE "FbeShipmentStatus" AS ENUM ('PENDING', 'SHIPPED', 'ARRIVED', 'CANCELLED', 'ALLOCATING');

-- CreateEnum
CREATE TYPE "InventoryLogType" AS ENUM ('PURCHASE_IN', 'FBE_OUT', 'MANUAL_ADJUST');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'IN_TRANSIT', 'RECEIVED', 'PENDING', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PermissionType" AS ENUM ('MENU', 'BUTTON', 'DATA');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('PENDING', 'SELECTED', 'PURCHASING', 'ORDERED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('LOCAL', 'THIRD_PARTY');

-- CreateTable
CREATE TABLE "alibaba_auth" (
    "id" SERIAL NOT NULL,
    "app_key" TEXT NOT NULL,
    "app_secret" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_expires_at" TIMESTAMP(3),
    "member_id" TEXT,
    "ali_id" TEXT,
    "login_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alibaba_auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fbe_shipment_items" (
    "id" SERIAL NOT NULL,
    "shipment_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "fbe_shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fbe_shipments" (
    "id" SERIAL NOT NULL,
    "shipment_number" TEXT NOT NULL,
    "status" "FbeShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "remark" TEXT,
    "owner_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "shop_id" INTEGER,
    "warehouse_id" INTEGER,
    "domestic_freight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overseas_freight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total_product_value" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "fbe_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory" (
    "id" SERIAL NOT NULL,
    "sku" TEXT NOT NULL,
    "local_image" TEXT,
    "purchase_cost" DECIMAL(10,2),
    "weight" DECIMAL(10,3),
    "length" DECIMAL(10,2),
    "width" DECIMAL(10,2),
    "height" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_logs" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "type" "InventoryLogType" NOT NULL,
    "change_quantity" DOUBLE PRECISION NOT NULL,
    "before_quantity" DOUBLE PRECISION NOT NULL,
    "after_quantity" DOUBLE PRECISION NOT NULL,
    "reference_id" TEXT,
    "remark" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warehouse_id" INTEGER,

    CONSTRAINT "inventory_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PermissionType" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "parent_id" INTEGER,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_orders" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "emag_order_id" BIGINT NOT NULL,
    "status" INTEGER NOT NULL,
    "status_text" TEXT NOT NULL,
    "order_time" TIMESTAMP(3) NOT NULL,
    "order_type" INTEGER,
    "payment_mode" TEXT,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT DEFAULT 'RON',
    "customer_json" TEXT,
    "products_json" TEXT,
    "raw_json" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "postgres_log" (
    "log_time" TIMESTAMPTZ(3),
    "user_name" TEXT,
    "database_name" TEXT,
    "process_id" INTEGER,
    "connection_from" TEXT,
    "session_id" TEXT NOT NULL,
    "session_line_num" BIGINT NOT NULL,
    "command_tag" TEXT,
    "session_start_time" TIMESTAMPTZ(6),
    "virtual_transaction_id" TEXT,
    "transaction_id" BIGINT,
    "error_severity" TEXT,
    "sql_state_code" TEXT,
    "message" TEXT,
    "detail" TEXT,
    "hint" TEXT,
    "internal_query" TEXT,
    "internal_query_pos" INTEGER,
    "context" TEXT,
    "query" TEXT,
    "query_pos" INTEGER,
    "location" TEXT,
    "application_name" TEXT,
    "backend_type" TEXT,
    "leader_pid" INTEGER,
    "query_id" BIGINT
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "pnk" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brand" TEXT,
    "price" DECIMAL(10,2),
    "tags" TEXT[],
    "rating" DECIMAL(3,2),
    "review_count" INTEGER,
    "category" TEXT,
    "category_l1" TEXT,
    "category_l2" TEXT,
    "category_l3" TEXT,
    "category_l4" TEXT,
    "image_url" TEXT,
    "product_url" TEXT,
    "cost_price" DECIMAL(10,2),
    "stock" INTEGER NOT NULL DEFAULT 0,
    "link_tag" TEXT,
    "purchase_price" DECIMAL(10,2),
    "purchase_url" TEXT,
    "actual_weight" DECIMAL(10,3),
    "freight_cost" DECIMAL(10,2),
    "fbe_fee" DECIMAL(10,2),
    "margin" DECIMAL(6,2),
    "collected_at" TIMESTAMP(3),
    "length" DECIMAL(10,2),
    "width" DECIMAL(10,2),
    "height" DECIMAL(10,2),
    "sku" TEXT,
    "chinese_name" TEXT,
    "developer" TEXT,
    "purchase_quantity" INTEGER,
    "purchase_type" TEXT,
    "purchase_period" INTEGER,
    "handling_time" INTEGER NOT NULL DEFAULT 2,
    "vat" INTEGER NOT NULL DEFAULT 19,
    "publish_status" TEXT NOT NULL DEFAULT 'UNPUBLISHED',
    "external_product_id" TEXT,
    "external_sku_id" TEXT,
    "external_synced" BOOLEAN NOT NULL DEFAULT false,
    "external_order_id" TEXT,
    "stock_actual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stock_in_transit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sales_1d" INTEGER NOT NULL DEFAULT 0,
    "sales_7d" INTEGER NOT NULL DEFAULT 0,
    "sales_14d" INTEGER NOT NULL DEFAULT 0,
    "sales_30d" INTEGER NOT NULL DEFAULT 0,
    "status" "ProductStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "owner_id" INTEGER,
    "purchase_order_id" INTEGER,
    "external_sku_id_num" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "in_transit_quantity" INTEGER NOT NULL DEFAULT 0,
    "return_loss_rate" DOUBLE PRECISION DEFAULT 0,
    "shop_id" INTEGER,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" SERIAL NOT NULL,
    "purchase_order_id" INTEGER NOT NULL,
    "offer_id" TEXT,
    "product_ids" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alibaba_order_id" TEXT,
    "alibaba_order_status" TEXT,
    "alibaba_total_amount" DECIMAL(12,2),
    "shipping_fee" DECIMAL(10,2),
    "logistics_company" TEXT,
    "logistics_no" TEXT,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remark" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warehouse_id" INTEGER,
    "alibaba_order_id" TEXT,
    "logistics_company" TEXT,
    "logistics_status" TEXT,
    "supplier_name" TEXT,
    "tracking_number" TEXT,
    "shop_id" INTEGER,
    "shop_name_snapshot" TEXT,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_authorizations" (
    "id" SERIAL NOT NULL,
    "platform" TEXT NOT NULL,
    "shop_name" TEXT NOT NULL,
    "business_model" TEXT NOT NULL DEFAULT 'TRADITIONAL',
    "api_key" TEXT NOT NULL,
    "api_secret" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "supplier_id" TEXT,
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_sandbox" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" INTEGER,
    "region" "EmagRegion",

    CONSTRAINT "shop_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_product_inventory_snapshots" (
    "id" SERIAL NOT NULL,
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

    CONSTRAINT "store_product_inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_products" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "pnk" TEXT NOT NULL,
    "emag_offer_id" TEXT,
    "name" TEXT NOT NULL,
    "sale_price" DECIMAL(10,2) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 1,
    "category_id" INTEGER,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "image_url" TEXT,
    "validation_status" TEXT,
    "doc_errors" TEXT,
    "rejection_reason" TEXT,
    "main_image" TEXT,
    "vendor_sku" TEXT,
    "ean" TEXT,
    "sku" TEXT,
    "currency" TEXT DEFAULT 'RON',
    "mapped_inventory_sku" TEXT,
    "product_url" TEXT,
    "comprehensive_sales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commission_rate" DOUBLE PRECISION,
    "estimated_profit" DECIMAL(12,2),
    "estimated_profit_cny" DECIMAL(12,2),
    "profit_calculated_at" TIMESTAMP(3),
    "profit_margin_pct" DOUBLE PRECISION,
    "profit_breakdown" JSONB,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "product_class" TEXT,
    "classification_reason" TEXT,
    "classification_metrics" JSONB,
    "classified_at" TIMESTAMP(3),

    CONSTRAINT "store_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" SERIAL NOT NULL,
    "sync_type" TEXT NOT NULL,
    "updated_count" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role_id" INTEGER NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stocks" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "stock_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "locked_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "in_transit_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sales_14" INTEGER NOT NULL DEFAULT 0,
    "sales_30" INTEGER NOT NULL DEFAULT 0,
    "sales_7" INTEGER NOT NULL DEFAULT 0,
    "unit_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "warehouse_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WarehouseType" NOT NULL DEFAULT 'LOCAL',
    "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rates_source_target_idx" ON "exchange_rates"("source" ASC, "target" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_source_target_key" ON "exchange_rates"("source" ASC, "target" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipment_items_product_id_idx" ON "fbe_shipment_items"("product_id" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipment_items_shipment_id_idx" ON "fbe_shipment_items"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipments_created_at_idx" ON "fbe_shipments"("created_at" DESC);

-- CreateIndex
CREATE INDEX "fbe_shipments_owner_id_idx" ON "fbe_shipments"("owner_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "fbe_shipments_shipment_number_key" ON "fbe_shipments"("shipment_number" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipments_shop_id_idx" ON "fbe_shipments"("shop_id" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipments_status_idx" ON "fbe_shipments"("status" ASC);

-- CreateIndex
CREATE INDEX "fbe_shipments_warehouse_id_idx" ON "fbe_shipments"("warehouse_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_sku_idx" ON "inventory"("sku" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_sku_key" ON "inventory"("sku" ASC);

-- CreateIndex
CREATE INDEX "inventory_logs_created_at_idx" ON "inventory_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_logs_product_id_idx" ON "inventory_logs"("product_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_logs_reference_id_idx" ON "inventory_logs"("reference_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_logs_type_idx" ON "inventory_logs"("type" ASC);

-- CreateIndex
CREATE INDEX "inventory_logs_warehouse_id_idx" ON "inventory_logs"("warehouse_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "platform_orders_shop_id_emag_order_id_key" ON "platform_orders"("shop_id" ASC, "emag_order_id" ASC);

-- CreateIndex
CREATE INDEX "platform_orders_shop_id_idx" ON "platform_orders"("shop_id" ASC);

-- CreateIndex
CREATE INDEX "platform_orders_shop_id_order_time_idx" ON "platform_orders"("shop_id" ASC, "order_time" DESC);

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category" ASC);

-- CreateIndex
CREATE INDEX "products_category_l1_category_l2_category_l3_category_l4_idx" ON "products"("category_l1" ASC, "category_l2" ASC, "category_l3" ASC, "category_l4" ASC);

-- CreateIndex
CREATE INDEX "products_external_product_id_idx" ON "products"("external_product_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "products_pnk_key" ON "products"("pnk" ASC);

-- CreateIndex
CREATE INDEX "products_purchase_order_id_idx" ON "products"("purchase_order_id" ASC);

-- CreateIndex
CREATE INDEX "products_shop_id_idx" ON "products"("shop_id" ASC);

-- CreateIndex
CREATE INDEX "products_sku_idx" ON "products"("sku" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku" ASC);

-- CreateIndex
CREATE INDEX "products_status_created_at_idx" ON "products"("status" ASC, "created_at" DESC);

-- CreateIndex
CREATE INDEX "products_status_owner_id_collected_at_idx" ON "products"("status" ASC, "owner_id" ASC, "collected_at" DESC);

-- CreateIndex
CREATE INDEX "products_title_idx" ON "products"("title" ASC);

-- CreateIndex
CREATE INDEX "purchase_order_items_alibaba_order_id_idx" ON "purchase_order_items"("alibaba_order_id" ASC);

-- CreateIndex
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id" ASC);

-- CreateIndex
CREATE INDEX "purchase_orders_alibaba_order_id_idx" ON "purchase_orders"("alibaba_order_id" ASC);

-- CreateIndex
CREATE INDEX "purchase_orders_created_at_idx" ON "purchase_orders"("created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_orders_operator_idx" ON "purchase_orders"("operator" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_no_key" ON "purchase_orders"("order_no" ASC);

-- CreateIndex
CREATE INDEX "purchase_orders_shop_id_idx" ON "purchase_orders"("shop_id" ASC);

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status" ASC);

-- CreateIndex
CREATE INDEX "purchase_orders_warehouse_id_idx" ON "purchase_orders"("warehouse_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name" ASC);

-- CreateIndex
CREATE INDEX "shop_authorizations_business_model_idx" ON "shop_authorizations"("business_model" ASC);

-- CreateIndex
CREATE INDEX "shop_authorizations_platform_idx" ON "shop_authorizations"("platform" ASC);

-- CreateIndex
CREATE INDEX "shop_authorizations_status_idx" ON "shop_authorizations"("status" ASC);

-- CreateIndex
CREATE INDEX "store_product_inventory_snapshots_shop_id_sku_snapshot_date_idx" ON "store_product_inventory_snapshots"("shop_id" ASC, "sku" ASC, "snapshot_date" ASC);

-- CreateIndex
CREATE INDEX "store_product_inventory_snapshots_shop_id_snapshot_date_idx" ON "store_product_inventory_snapshots"("shop_id" ASC, "snapshot_date" ASC);

-- CreateIndex
CREATE INDEX "store_product_inventory_snapshots_store_product_id_idx" ON "store_product_inventory_snapshots"("store_product_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "store_product_inventory_snapshots_store_product_id_snapshot_dat" ON "store_product_inventory_snapshots"("store_product_id" ASC, "snapshot_date" ASC);

-- CreateIndex
CREATE INDEX "store_products_ean_idx" ON "store_products"("ean" ASC);

-- CreateIndex
CREATE INDEX "store_products_is_archived_idx" ON "store_products"("is_archived" ASC);

-- CreateIndex
CREATE INDEX "store_products_pnk_idx" ON "store_products"("pnk" ASC);

-- CreateIndex
CREATE INDEX "store_products_shop_id_comprehensive_sales_idx" ON "store_products"("shop_id" ASC, "comprehensive_sales" DESC);

-- CreateIndex
CREATE INDEX "store_products_shop_id_ean_idx" ON "store_products"("shop_id" ASC, "ean" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "store_products_shop_id_emag_offer_id_key" ON "store_products"("shop_id" ASC, "emag_offer_id" ASC);

-- CreateIndex
CREATE INDEX "store_products_shop_id_idx" ON "store_products"("shop_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "store_products_shop_id_pnk_key" ON "store_products"("shop_id" ASC, "pnk" ASC);

-- CreateIndex
CREATE INDEX "store_products_shop_id_product_class_comprehensive_sales_idx" ON "store_products"("shop_id" ASC, "product_class" ASC, "comprehensive_sales" DESC);

-- CreateIndex
CREATE INDEX "store_products_shop_id_product_class_idx" ON "store_products"("shop_id" ASC, "product_class" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "store_products_shop_id_sku_key" ON "store_products"("shop_id" ASC, "sku" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "store_products_shop_id_vendor_sku_key" ON "store_products"("shop_id" ASC, "vendor_sku" ASC);

-- CreateIndex
CREATE INDEX "store_products_vendor_sku_idx" ON "store_products"("vendor_sku" ASC);

-- CreateIndex
CREATE INDEX "sync_logs_created_at_idx" ON "sync_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "sync_logs_sync_type_idx" ON "sync_logs"("sync_type" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username" ASC);

-- CreateIndex
CREATE INDEX "warehouse_stocks_product_id_idx" ON "warehouse_stocks"("product_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stocks_product_id_warehouse_id_key" ON "warehouse_stocks"("product_id" ASC, "warehouse_id" ASC);

-- CreateIndex
CREATE INDEX "warehouse_stocks_warehouse_id_idx" ON "warehouse_stocks"("warehouse_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_name_key" ON "warehouses"("name" ASC);

-- CreateIndex
CREATE INDEX "warehouses_status_idx" ON "warehouses"("status" ASC);

-- AddForeignKey
ALTER TABLE "fbe_shipment_items" ADD CONSTRAINT "fbe_shipment_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_shipment_items" ADD CONSTRAINT "fbe_shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "fbe_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_shipments" ADD CONSTRAINT "fbe_shipments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_shipments" ADD CONSTRAINT "fbe_shipments_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fbe_shipments" ADD CONSTRAINT "fbe_shipments_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_logs" ADD CONSTRAINT "inventory_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_logs" ADD CONSTRAINT "inventory_logs_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "permissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_orders" ADD CONSTRAINT "platform_orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_product_inventory_snapshots" ADD CONSTRAINT "store_product_inventory_snapshots_store_product_id_fkey" FOREIGN KEY ("store_product_id") REFERENCES "store_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocks" ADD CONSTRAINT "warehouse_stocks_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stocks" ADD CONSTRAINT "warehouse_stocks_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

