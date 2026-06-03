-- CreateEnum
CREATE TYPE "OperationTaskType" AS ENUM ('PRODUCT_SELECTION', 'PRODUCT_LISTING', 'QUALIFICATION', 'ADJUSTMENT', 'REVIEW_FIX', 'AFTER_SALES', 'OTHER');

-- CreateEnum
CREATE TYPE "OperationPlatform" AS ENUM ('SHEIN', 'TEMU', 'ALIEXPRESS', 'EMAG', 'AMAZON', 'OTHER');

-- CreateEnum
CREATE TYPE "OperationLogStatus" AS ENUM ('DONE', 'IN_PROGRESS', 'BLOCKED');

-- AlterTable
ALTER TABLE "store_product_inventory_snapshots" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "operation_daily_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "task_type" "OperationTaskType" NOT NULL,
    "platform" "OperationPlatform",
    "shop_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "status" "OperationLogStatus" NOT NULL DEFAULT 'DONE',
    "detail" TEXT,
    "links_json" JSONB,
    "blocker_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operation_daily_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_daily_logs_user_id_work_date_idx" ON "operation_daily_logs"("user_id", "work_date");

-- CreateIndex
CREATE INDEX "operation_daily_logs_work_date_idx" ON "operation_daily_logs"("work_date");

-- CreateIndex
CREATE INDEX "operation_daily_logs_task_type_work_date_idx" ON "operation_daily_logs"("task_type", "work_date");

-- CreateIndex
CREATE INDEX "operation_daily_logs_status_work_date_idx" ON "operation_daily_logs"("status", "work_date");

-- CreateIndex
CREATE INDEX "operation_daily_logs_work_date_user_id_idx" ON "operation_daily_logs"("work_date", "user_id");

-- AddForeignKey
ALTER TABLE "operation_daily_logs" ADD CONSTRAINT "operation_daily_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_daily_logs" ADD CONSTRAINT "operation_daily_logs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "store_product_inventory_snapshots_store_product_id_snapshot_dat" RENAME TO "store_product_inventory_snapshots_store_product_id_snapshot_key";
