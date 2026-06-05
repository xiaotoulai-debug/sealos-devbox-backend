-- CreateEnum
CREATE TYPE "WorkdayStatus" AS ENUM ('WORKDAY', 'REST', 'PENDING');

-- CreateTable
CREATE TABLE "workday_calendars" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "status" "WorkdayStatus" NOT NULL DEFAULT 'PENDING',
    "remark" TEXT,
    "updated_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workday_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workday_calendars_date_key" ON "workday_calendars"("date");

-- CreateIndex
CREATE INDEX "workday_calendars_date_idx" ON "workday_calendars"("date");

-- AddForeignKey
ALTER TABLE "workday_calendars" ADD CONSTRAINT "workday_calendars_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
