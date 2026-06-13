-- CreateTable
CREATE TABLE "employee_weekly_plans" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "week_start" DATE NOT NULL,
    "next_week_plan" TEXT NOT NULL DEFAULT '',
    "problems" TEXT NOT NULL DEFAULT '',
    "support_needed" TEXT NOT NULL DEFAULT '',
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_weekly_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_weekly_plans_week_start_idx" ON "employee_weekly_plans"("week_start");

-- CreateIndex
CREATE UNIQUE INDEX "employee_weekly_plans_user_id_week_start_key" ON "employee_weekly_plans"("user_id", "week_start");

-- AddForeignKey
ALTER TABLE "employee_weekly_plans" ADD CONSTRAINT "employee_weekly_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
