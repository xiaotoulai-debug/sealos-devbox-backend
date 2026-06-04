-- AlterTable
ALTER TABLE "store_products" ADD COLUMN     "buy_box_action_tips" JSONB,
ADD COLUMN     "buy_box_meta" JSONB,
ADD COLUMN     "buy_box_rank" INTEGER,
ADD COLUMN     "buy_box_status" TEXT,
ADD COLUMN     "buy_box_status_confidence" TEXT,
ADD COLUMN     "buy_box_status_source" TEXT;
