-- CreateEnum
CREATE TYPE "AccessGrantStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "githubUserId" BIGINT,
    "avatarUrl" TEXT,
    "status" "AccessGrantStatus" NOT NULL,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessInvite" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "multiUse" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "AccessInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_githubLogin_key" ON "AccessGrant"("githubLogin");

-- CreateIndex
CREATE INDEX "AccessGrant_status_idx" ON "AccessGrant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AccessInvite_tokenHash_key" ON "AccessInvite"("tokenHash");
