-- Retention purge (createdAt < cutoff, all users): the (userId, createdAt) index cannot serve it.
-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");
