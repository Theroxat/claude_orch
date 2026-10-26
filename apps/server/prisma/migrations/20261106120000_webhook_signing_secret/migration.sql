-- AlterTable
ALTER TABLE "NotificationSettings"
    ADD COLUMN "webhookSecretEnc" BYTEA,
    ADD COLUMN "webhookSecretHint" TEXT,
    ADD COLUMN "webhookPrevSecretEnc" BYTEA,
    ADD COLUMN "webhookPrevSecretExpiresAt" TIMESTAMP(3);
