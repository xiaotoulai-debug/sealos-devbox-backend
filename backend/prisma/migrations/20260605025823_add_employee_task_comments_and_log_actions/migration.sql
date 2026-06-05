-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmployeeTaskLogAction" ADD VALUE 'DUE_DATE_UPDATED';
ALTER TYPE "EmployeeTaskLogAction" ADD VALUE 'COMMENTED';

-- CreateTable
CREATE TABLE "employee_task_comments" (
    "id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "author_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "mentioned_user_ids" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_task_comments_task_id_idx" ON "employee_task_comments"("task_id");

-- CreateIndex
CREATE INDEX "employee_task_comments_author_id_idx" ON "employee_task_comments"("author_id");

-- AddForeignKey
ALTER TABLE "employee_task_comments" ADD CONSTRAINT "employee_task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "employee_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_task_comments" ADD CONSTRAINT "employee_task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
