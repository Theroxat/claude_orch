-- AlterTable
ALTER TABLE "WebhookDelivery" ADD COLUMN "bodyHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_bodyHash_key" ON "WebhookDelivery"("bodyHash");
