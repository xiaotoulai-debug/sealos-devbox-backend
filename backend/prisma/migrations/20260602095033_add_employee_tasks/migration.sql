-- CreateEnum
CREATE TYPE "EmployeeTaskType" AS ENUM ('PRODUCT_LISTING', 'QUALIFICATION', 'AD_OPTIMIZATION', 'MARKETING_STRATEGY', 'SHIPPING', 'PURCHASE', 'OTHER');

-- CreateEnum
CREATE TYPE "EmployeeTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmployeeTaskPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "EmployeeTaskLogAction" AS ENUM ('CREATED', 'STATUS_CHANGED', 'UPDATED', 'CANCELLED');

-- CreateTable
CREATE TABLE "employee_tasks" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "task_type" "EmployeeTaskType" NOT NULL,
    "platform" "OperationPlatform",
    "shop_id" INTEGER,
    "priority" "EmployeeTaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "EmployeeTaskStatus" NOT NULL DEFAULT 'TODO',
    "creator_id" INTEGER NOT NULL,
    "assignee_id" INTEGER NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "related_sku_text" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_task_logs" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "operator_id" INTEGER NOT NULL,
    "action" "EmployeeTaskLogAction" NOT NULL,
    "from_status" "EmployeeTaskStatus",
    "to_status" "EmployeeTaskStatus",
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_task_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_tasks_assignee_id_status_due_date_idx" ON "employee_tasks"("assignee_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "employee_tasks_creator_id_status_due_date_idx" ON "employee_tasks"("creator_id", "status", "due_date");

-- CreateIndex
CREATE INDEX "employee_tasks_due_date_idx" ON "employee_tasks"("due_date");

-- CreateIndex
CREATE INDEX "employee_tasks_status_idx" ON "employee_tasks"("status");

-- CreateIndex
CREATE INDEX "employee_tasks_task_type_idx" ON "employee_tasks"("task_type");

-- CreateIndex
CREATE INDEX "employee_tasks_platform_idx" ON "employee_tasks"("platform");

-- CreateIndex
CREATE INDEX "employee_tasks_created_at_idx" ON "employee_tasks"("created_at");

-- CreateIndex
CREATE INDEX "employee_task_logs_task_id_idx" ON "employee_task_logs"("task_id");

-- CreateIndex
CREATE INDEX "employee_task_logs_operator_id_idx" ON "employee_task_logs"("operator_id");

-- CreateIndex
CREATE INDEX "employee_task_logs_created_at_idx" ON "employee_task_logs"("created_at");

-- AddForeignKey
ALTER TABLE "employee_tasks" ADD CONSTRAINT "employee_tasks_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tasks" ADD CONSTRAINT "employee_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_tasks" ADD CONSTRAINT "employee_tasks_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shop_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_logs" ADD CONSTRAINT "employee_task_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "employee_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_logs" ADD CONSTRAINT "employee_task_logs_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
