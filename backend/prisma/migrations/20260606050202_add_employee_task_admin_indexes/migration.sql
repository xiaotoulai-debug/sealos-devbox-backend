-- CreateIndex
CREATE INDEX "employee_tasks_assignee_id_due_date_idx" ON "employee_tasks"("assignee_id", "due_date");

-- CreateIndex
CREATE INDEX "employee_tasks_status_due_date_idx" ON "employee_tasks"("status", "due_date");

-- CreateIndex
CREATE INDEX "employee_tasks_updated_at_idx" ON "employee_tasks"("updated_at");
