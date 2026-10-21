-- v0.5.2: result of the agent's real Claude check (`claude.auth`).
ALTER TABLE "Agent" ADD COLUMN "claudeAuthCheckedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "claudeAuthError" TEXT;
