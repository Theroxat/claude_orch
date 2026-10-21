-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorAgentId" TEXT,
ADD COLUMN     "agentId" TEXT;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "os" TEXT,
    "arch" TEXT,
    "agentVersion" TEXT,
    "secretHash" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "lastUsageAt" TIMESTAMP(3),
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" TIMESTAMP(3),
    "pauseSource" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrollmentToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedByAgentId" TEXT,
    "createdIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnrollmentToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReport" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL,
    "windowStart" TIMESTAMP(3),
    "windowResetAt" TIMESTAMP(3),
    "inputTokens" BIGINT NOT NULL,
    "outputTokens" BIGINT NOT NULL,
    "cacheWriteTokens" BIGINT NOT NULL,
    "cacheReadTokens" BIGINT NOT NULL,
    "weightedTokens" BIGINT NOT NULL,
    "byProject" JSONB NOT NULL,
    "byModel" JSONB NOT NULL,
    "capacityEstimate" BIGINT,
    "rateLimitedUntil" TIMESTAMP(3),
    "source" TEXT NOT NULL,

    CONSTRAINT "UsageReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMessageSeen" (
    "agentId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessageSeen_pkey" PRIMARY KEY ("agentId","messageId")
);

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EnrollmentToken_tokenHash_key" ON "EnrollmentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EnrollmentToken_userId_expiresAt_idx" ON "EnrollmentToken"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "UsageReport_agentId_reportedAt_idx" ON "UsageReport"("agentId", "reportedAt" DESC);

-- CreateIndex
CREATE INDEX "UsageReport_userId_reportedAt_idx" ON "UsageReport"("userId", "reportedAt" DESC);

-- CreateIndex
CREATE INDEX "UsageReport_reportedAt_idx" ON "UsageReport"("reportedAt");

-- CreateIndex
CREATE INDEX "AgentMessageSeen_seenAt_idx" ON "AgentMessageSeen"("seenAt");

-- CreateIndex
CREATE INDEX "AuditLog_agentId_at_idx" ON "AuditLog"("agentId", "at");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrollmentToken" ADD CONSTRAINT "EnrollmentToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReport" ADD CONSTRAINT "UsageReport_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMessageSeen" ADD CONSTRAINT "AgentMessageSeen_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
