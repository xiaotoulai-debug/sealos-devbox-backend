-- CreateEnum
CREATE TYPE "OperationReportStatus" AS ENUM ('SUBMITTED');

-- AlterTable
ALTER TABLE "operation_daily_logs" ADD COLUMN     "report_id" INTEGER;

-- CreateTable
CREATE TABLE "operation_daily_reports" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "status" "OperationReportStatus" NOT NULL DEFAULT 'SUBMITTED',
    "edit_count" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_edited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operation_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_daily_reports_work_date_idx" ON "operation_daily_reports"("work_date");

-- CreateIndex
CREATE INDEX "operation_daily_reports_user_id_work_date_idx" ON "operation_daily_reports"("user_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "operation_daily_reports_user_id_work_date_key" ON "operation_daily_reports"("user_id", "work_date");

-- CreateIndex
CREATE INDEX "operation_daily_logs_report_id_idx" ON "operation_daily_logs"("report_id");

-- AddForeignKey
ALTER TABLE "operation_daily_logs" ADD CONSTRAINT "operation_daily_logs_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "operation_daily_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
