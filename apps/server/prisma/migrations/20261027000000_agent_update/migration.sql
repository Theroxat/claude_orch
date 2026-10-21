ALTER TABLE "Agent" ADD COLUMN "updateId" TEXT;
ALTER TABLE "Agent" ADD COLUMN "updateStatus" TEXT;
ALTER TABLE "Agent" ADD COLUMN "updateTargetVersion" TEXT;
ALTER TABLE "Agent" ADD COLUMN "updateCode" TEXT;
ALTER TABLE "Agent" ADD COLUMN "updateDetail" TEXT;
ALTER TABLE "Agent" ADD COLUMN "updateRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "updateUpdatedAt" TIMESTAMP(3);
