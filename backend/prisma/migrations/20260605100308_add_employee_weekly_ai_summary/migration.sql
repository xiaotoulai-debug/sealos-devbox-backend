-- CreateEnum
CREATE TYPE "EmployeeWeeklyAiSummaryStatus" AS ENUM ('RULE_ONLY', 'PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "employee_weekly_ai_summaries" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "week_start" DATE NOT NULL,
    "week_end" DATE NOT NULL,
    "source_hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'deepseek',
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "status" "EmployeeWeeklyAiSummaryStatus" NOT NULL DEFAULT 'PENDING',
    "summary_json" JSONB,
    "raw_text" TEXT,
    "error_message" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_estimate" DECIMAL(10,6),
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_weekly_ai_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_weekly_ai_summaries_user_id_week_start_status_idx" ON "employee_weekly_ai_summaries"("user_id", "week_start", "status");

-- CreateIndex
CREATE INDEX "employee_weekly_ai_summaries_status_week_start_idx" ON "employee_weekly_ai_summaries"("status", "week_start");

-- CreateIndex
CREATE UNIQUE INDEX "employee_weekly_ai_summaries_user_id_week_start_key" ON "employee_weekly_ai_summaries"("user_id", "week_start");

-- CreateIndex
CREATE INDEX "employee_tasks_assignee_id_status_completed_at_idx" ON "employee_tasks"("assignee_id", "status", "completed_at");

-- CreateIndex
CREATE INDEX "employee_tasks_assignee_id_status_cancelled_at_idx" ON "employee_tasks"("assignee_id", "status", "cancelled_at");

-- CreateIndex
CREATE INDEX "employee_tasks_creator_id_status_created_at_idx" ON "employee_tasks"("creator_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "employee_tasks_creator_id_status_completed_at_idx" ON "employee_tasks"("creator_id", "status", "completed_at");

-- AddForeignKey
ALTER TABLE "employee_weekly_ai_summaries" ADD CONSTRAINT "employee_weekly_ai_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
