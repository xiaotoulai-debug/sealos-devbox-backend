-- CreateEnum
CREATE TYPE "ReminderCategory" AS ENUM ('PLATFORM_MESSAGE', 'QUALIFICATION', 'PRODUCT_REVIEW', 'AD_CHECK', 'SHIPPING_FOLLOW', 'INVENTORY_CHECK', 'AFTER_SALES', 'PRODUCT_SELECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReminderPriority" AS ENUM ('P0', 'P1', 'P2');

-- CreateEnum
CREATE TYPE "ReminderFrequency" AS ENUM ('DAILY', 'WORKDAY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "ReminderCheckStatus" AS ENUM ('PENDING', 'CHECKED', 'ABNORMAL');

-- CreateEnum
CREATE TYPE "ReminderAssignmentTargetType" AS ENUM ('USER', 'ROLE');

-- CreateTable
CREATE TABLE "daily_reminder_templates" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "category" "ReminderCategory" NOT NULL,
    "priority" "ReminderPriority" NOT NULL,
    "frequency" "ReminderFrequency" NOT NULL,
    "weekdays" INTEGER[],
    "suggested_time" TEXT,
    "require_check" BOOLEAN NOT NULL DEFAULT true,
    "platform" "OperationPlatform",
    "shop_id" INTEGER,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" INTEGER NOT NULL,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reminder_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_reminder_template_assignments" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "target_type" "ReminderAssignmentTargetType" NOT NULL,
    "user_id" INTEGER,
    "role_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_reminder_template_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_reminder_checks" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "check_date" DATE NOT NULL,
    "status" "ReminderCheckStatus" NOT NULL,
    "note" TEXT,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reminder_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_reminder_templates_is_active_idx" ON "daily_reminder_templates"("is_active");

-- CreateIndex
CREATE INDEX "daily_reminder_templates_category_idx" ON "daily_reminder_templates"("category");

-- CreateIndex
CREATE INDEX "daily_reminder_templates_priority_idx" ON "daily_reminder_templates"("priority");

-- CreateIndex
CREATE INDEX "daily_reminder_templates_frequency_idx" ON "daily_reminder_templates"("frequency");

-- CreateIndex
CREATE INDEX "daily_reminder_templates_shop_id_idx" ON "daily_reminder_templates"("shop_id");

-- CreateIndex
CREATE INDEX "daily_reminder_templates_created_at_idx" ON "daily_reminder_templates"("created_at");

-- CreateIndex
CREATE INDEX "daily_reminder_template_assignments_template_id_idx" ON "daily_reminder_template_assignments"("template_id");

-- CreateIndex
CREATE INDEX "daily_reminder_template_assignments_target_type_user_id_idx" ON "daily_reminder_template_assignments"("target_type", "user_id");

-- CreateIndex
CREATE INDEX "daily_reminder_template_assignments_target_type_role_id_idx" ON "daily_reminder_template_assignments"("target_type", "role_id");

-- CreateIndex
CREATE INDEX "daily_reminder_checks_user_id_check_date_idx" ON "daily_reminder_checks"("user_id", "check_date");

-- CreateIndex
CREATE INDEX "daily_reminder_checks_template_id_check_date_idx" ON "daily_reminder_checks"("template_id", "check_date");

-- CreateIndex
CREATE INDEX "daily_reminder_checks_status_idx" ON "daily_reminder_checks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "daily_reminder_checks_template_id_user_id_check_date_key" ON "daily_reminder_checks"("template_id", "user_id", "check_date");

-- AddForeignKey
ALTER TABLE "daily_reminder_templates" ADD CONSTRAINT "daily_reminder_templates_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_templates" ADD CONSTRAINT "daily_reminder_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_templates" ADD CONSTRAINT "daily_reminder_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_template_assignments" ADD CONSTRAINT "daily_reminder_template_assignments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "daily_reminder_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_template_assignments" ADD CONSTRAINT "daily_reminder_template_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_template_assignments" ADD CONSTRAINT "daily_reminder_template_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_checks" ADD CONSTRAINT "daily_reminder_checks_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "daily_reminder_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_reminder_checks" ADD CONSTRAINT "daily_reminder_checks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
