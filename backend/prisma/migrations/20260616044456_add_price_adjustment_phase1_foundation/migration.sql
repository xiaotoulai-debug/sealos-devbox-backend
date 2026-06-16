-- AlterTable
ALTER TABLE "store_products" ADD COLUMN     "last_price_adjusted_at" TIMESTAMP(3),
ADD COLUMN     "last_price_adjustment_mode" VARCHAR(32),
ADD COLUMN     "manual_min_price" DECIMAL(12,4),
ADD COLUMN     "offer_validation_status" JSONB,
ADD COLUMN     "vat_id" INTEGER,
ADD COLUMN     "vat_rate" DECIMAL(8,6);

-- CreateTable
CREATE TABLE "store_product_price_adjustment_logs" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "store_product_id" INTEGER NOT NULL,
    "pnk" TEXT,
    "mode" VARCHAR(32) NOT NULL,
    "old_sale_price_ex_vat" DECIMAL(12,4),
    "new_sale_price_ex_vat" DECIMAL(12,4) NOT NULL,
    "currency" VARCHAR(8),
    "cart_price_raw" JSONB,
    "cart_price_ex_vat" DECIMAL(12,4),
    "vat_rate" DECIMAL(8,6),
    "hard_floor_price" DECIMAL(12,4),
    "suggested_min_price" DECIMAL(12,4),
    "manual_min_price" DECIMAL(12,4),
    "final_min_price" DECIMAL(12,4),
    "estimated_profit_after" DECIMAL(12,4),
    "profit_margin_pct_after" DECIMAL(8,4),
    "reason" TEXT NOT NULL,
    "operator_user_id" INTEGER,
    "emag_request_payload" JSONB,
    "emag_response" JSONB,
    "status" VARCHAR(32) NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_product_price_adjustment_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_price_strategy_configs" (
    "id" SERIAL NOT NULL,
    "shop_id" INTEGER NOT NULL,
    "target_min_margin_pct" DECIMAL(8,6) NOT NULL DEFAULT 0.10,
    "safety_buffer_pct" DECIMAL(8,6) NOT NULL DEFAULT 0.02,
    "grab_step" DECIMAL(12,4) NOT NULL DEFAULT 0.10,
    "default_vat_rate" DECIMAL(8,6),
    "default_commission_rate" DECIMAL(8,6),
    "return_loss_rate" DECIMAL(8,6),
    "manual_price_allow_estimated_cost" BOOLEAN NOT NULL DEFAULT true,
    "grab_cart_allow_estimated_cost" BOOLEAN NOT NULL DEFAULT false,
    "is_price_change_paused" BOOLEAN NOT NULL DEFAULT false,
    "is_grab_cart_paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_price_strategy_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "store_product_price_adjustment_logs_shop_id_created_at_idx" ON "store_product_price_adjustment_logs"("shop_id", "created_at");

-- CreateIndex
CREATE INDEX "store_product_price_adjustment_logs_store_product_id_create_idx" ON "store_product_price_adjustment_logs"("store_product_id", "created_at");

-- CreateIndex
CREATE INDEX "store_product_price_adjustment_logs_mode_created_at_idx" ON "store_product_price_adjustment_logs"("mode", "created_at");

-- CreateIndex
CREATE INDEX "store_product_price_adjustment_logs_status_created_at_idx" ON "store_product_price_adjustment_logs"("status", "created_at");

-- CreateIndex
CREATE INDEX "store_product_price_adjustment_logs_operator_user_id_create_idx" ON "store_product_price_adjustment_logs"("operator_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "store_price_strategy_configs_shop_id_key" ON "store_price_strategy_configs"("shop_id");

-- AddForeignKey
ALTER TABLE "store_product_price_adjustment_logs" ADD CONSTRAINT "store_product_price_adjustment_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_product_price_adjustment_logs" ADD CONSTRAINT "store_product_price_adjustment_logs_store_product_id_fkey" FOREIGN KEY ("store_product_id") REFERENCES "store_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_product_price_adjustment_logs" ADD CONSTRAINT "store_product_price_adjustment_logs_operator_user_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_price_strategy_configs" ADD CONSTRAINT "store_price_strategy_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
