-- M4: dispatcher, targeting, offer expiry, execution leases, webhook dedupe.

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('POOL', 'MEMBERS', 'BROADCAST');

-- AlterEnum
ALTER TYPE "TaskStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "dispatchMode" "DispatchMode" NOT NULL DEFAULT 'POOL';

-- AlterTable
ALTER TABLE "Assignment" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "cleanupPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TaskTarget" (
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "TaskTarget_pkey" PRIMARY KEY ("taskId","userId")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateIndex
CREATE INDEX "TaskTarget_userId_idx" ON "TaskTarget"("userId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");

-- CreateIndex
CREATE INDEX "Assignment_status_expiresAt_idx" ON "Assignment"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "TaskTarget" ADD CONSTRAINT "TaskTarget_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskTarget" ADD CONSTRAINT "TaskTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one pending AUTO offer per task: one execution, offered to one auto member at a time.
CREATE UNIQUE INDEX "one_pending_auto_offer" ON "Assignment"("taskId")
WHERE "status" = 'PENDING' AND "kind" = 'AUTO_OFFER';
