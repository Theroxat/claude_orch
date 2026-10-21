-- v0.5.1: failed-run classes, Claude login state, task retry and "needs attention".
ALTER TABLE "Agent" ADD COLUMN "claudeAuthValid" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Agent" ADD COLUMN "claudeAuthInvalidAt" TIMESTAMP(3);

ALTER TABLE "Task" ADD COLUMN "retryResetAt" TIMESTAMP(3);
ALTER TABLE "Task" ADD COLUMN "needsAttention" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "needsAttentionReason" TEXT;
ALTER TABLE "Task" ADD COLUMN "needsAttentionAt" TIMESTAMP(3);

ALTER TABLE "Assignment" ADD COLUMN "failureClass" TEXT;
