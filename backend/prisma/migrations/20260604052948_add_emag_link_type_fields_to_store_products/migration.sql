-- AlterTable
ALTER TABLE "store_products" ADD COLUMN     "best_offer_sale_price" DECIMAL(10,2),
ADD COLUMN     "buy_button_rank" INTEGER,
ADD COLUMN     "content_permission" TEXT,
ADD COLUMN     "emag_link_type" TEXT,
ADD COLUMN     "emag_link_type_confidence" TEXT,
ADD COLUMN     "emag_link_type_source" TEXT,
ADD COLUMN     "emag_offer_meta" JSONB,
ADD COLUMN     "emag_ownership" JSONB,
ADD COLUMN     "link_action_tips" JSONB,
ADD COLUMN     "main_offer_price" DECIMAL(10,2),
ADD COLUMN     "number_of_offers" INTEGER,
ADD COLUMN     "offer_competition_type" TEXT;
