-- AlterTable
ALTER TABLE "Participation" ADD COLUMN     "lastRejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT;
