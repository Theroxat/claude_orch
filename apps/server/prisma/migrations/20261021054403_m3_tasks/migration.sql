-- CreateEnum
CREATE TYPE "TaskSize" AS ENUM ('S', 'M', 'L');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PROPOSED', 'TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE');

-- CreateEnum
CREATE TYPE "TaskOrigin" AS ENUM ('PLATFORM', 'LABEL_IMPORT', 'MCP');

-- CreateEnum
CREATE TYPE "AssignmentKind" AS ENUM ('AUTO_OFFER', 'CONSENT_REQUEST', 'CLAIM');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'RUNNING', 'PUSHED', 'SUCCEEDED', 'FAILED', 'LOST');

-- CreateEnum
CREATE TYPE "ExecMode" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "taskId" TEXT;

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "githubIssueNumber" INTEGER NOT NULL,
    "githubIssueNodeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodySnapshot" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "acceptanceCriteria" TEXT[],
    "size" "TaskSize" NOT NULL DEFAULT 'M',
    "model" "Model" NOT NULL DEFAULT 'SONNET',
    "baseBranch" TEXT NOT NULL,
    "integrationBranch" TEXT,
    "branchName" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "origin" "TaskOrigin" NOT NULL DEFAULT 'PLATFORM',
    "createdById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "assigneeAgentId" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "headSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "taskId" TEXT NOT NULL,
    "dependsOnId" TEXT NOT NULL,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("taskId","dependsOnId")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "kind" "AssignmentKind" NOT NULL,
    "status" "AssignmentStatus" NOT NULL,
    "execMode" "ExecMode",
    "reason" TEXT,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "usageWeighted" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");

-- CreateIndex
CREATE INDEX "Task_createdById_status_idx" ON "Task"("createdById", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Task_projectId_githubIssueNumber_key" ON "Task"("projectId", "githubIssueNumber");

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnId_idx" ON "TaskDependency"("dependsOnId");

-- CreateIndex
CREATE INDEX "Assignment_taskId_status_idx" ON "Assignment"("taskId", "status");

-- CreateIndex
CREATE INDEX "Assignment_userId_status_idx" ON "Assignment"("userId", "status");

-- CreateIndex
CREATE INDEX "Assignment_agentId_status_idx" ON "Assignment"("agentId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_taskId_idx" ON "AuditLog"("taskId");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeAgentId_fkey" FOREIGN KEY ("assigneeAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one live assignment per task: the arbiter of claim races.
CREATE UNIQUE INDEX "one_live_assignment" ON "Assignment"("taskId")
WHERE "status" IN ('ACCEPTED', 'RUNNING', 'PUSHED');
