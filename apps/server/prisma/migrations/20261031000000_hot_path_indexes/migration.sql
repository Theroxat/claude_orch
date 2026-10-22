-- CreateIndex
CREATE INDEX "Task_status_createdAt_idx" ON "Task"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Assignment_userId_respondedAt_idx" ON "Assignment"("userId", "respondedAt");

-- CreateIndex
CREATE INDEX "Assignment_status_finishedAt_idx" ON "Assignment"("status", "finishedAt");
