-- AlterTable
ALTER TABLE "NotificationSettings"
    ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
    ADD COLUMN "emailTokenHash" TEXT,
    ADD COLUMN "emailTokenExpiresAt" TIMESTAMP(3),
    ADD COLUMN "emailSendLog" TIMESTAMP(3)[];
