-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "PermissionType" AS ENUM ('MENU', 'BUTTON', 'DATA');
CREATE TYPE "ProductStatus" AS ENUM ('PENDING', 'SELECTED', 'PURCHASING', 'ORDERED');
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'IN_TRANSIT', 'RECEIVED');

-- CreateTable (dependency order)
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PermissionType" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "parent_id" INTEGER,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

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

CREATE TABLE "purchase_orders" (
    "id" SERIAL NOT NULL,
    "order_no" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

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
    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

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
    CONSTRAINT "shop_authorizations_pkey" PRIMARY KEY ("id")
);

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

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");
CREATE UNIQUE INDEX "products_pnk_key" ON "products"("pnk");
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");
CREATE INDEX "products_status_created_at_idx" ON "products"("status", "created_at" DESC);
CREATE INDEX "products_category_idx" ON "products"("category");
CREATE INDEX "products_category_l1_category_l2_category_l3_category_l4_idx" ON "products"("category_l1", "category_l2", "category_l3", "category_l4");
CREATE INDEX "products_title_idx" ON "products"("title");
CREATE INDEX "products_status_owner_id_collected_at_idx" ON "products"("status", "owner_id", "collected_at" DESC);
CREATE INDEX "products_purchase_order_id_idx" ON "products"("purchase_order_id");
CREATE INDEX "products_sku_idx" ON "products"("sku");
CREATE INDEX "products_external_product_id_idx" ON "products"("external_product_id");
CREATE UNIQUE INDEX "purchase_orders_order_no_key" ON "purchase_orders"("order_no");
CREATE INDEX "purchase_orders_created_at_idx" ON "purchase_orders"("created_at" DESC);
CREATE INDEX "purchase_orders_operator_idx" ON "purchase_orders"("operator");
CREATE INDEX "shop_authorizations_platform_idx" ON "shop_authorizations"("platform");
CREATE INDEX "shop_authorizations_status_idx" ON "shop_authorizations"("status");
CREATE INDEX "shop_authorizations_business_model_idx" ON "shop_authorizations"("business_model");

-- AddForeignKey
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "permissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "products" ADD CONSTRAINT "products_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
