-- Task templates: reusable task skeletons (personal or shared with a project).
CREATE TYPE "TemplateScope" AS ENUM ('PERSONAL', 'PROJECT');
CREATE TYPE "TemplateDependenciesMode" AS ENUM ('NONE', 'ASK');

CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "scope" "TemplateScope" NOT NULL,
    "projectId" TEXT,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "titleTemplate" TEXT NOT NULL DEFAULT '',
    "bodyTemplate" TEXT NOT NULL,
    "acceptanceCriteria" TEXT[],
    "size" "TaskSize" NOT NULL DEFAULT 'M',
    "model" "Model" NOT NULL DEFAULT 'SONNET',
    "labels" TEXT[],
    "dependenciesMode" "TemplateDependenciesMode" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskTemplate_createdById_scope_idx" ON "TaskTemplate"("createdById", "scope");
CREATE INDEX "TaskTemplate_projectId_idx" ON "TaskTemplate"("projectId");

ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTemplate" ADD CONSTRAINT "TaskTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
