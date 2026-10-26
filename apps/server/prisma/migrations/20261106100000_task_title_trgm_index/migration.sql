-- History search (`q`) runs `title ILIKE '%…%'`: a trigram GIN index lets Postgres answer it without
-- scanning the whole Task table. pg_trgm ships with the official postgres image (contrib) and is a
-- "trusted" extension since PG13, so the database owner can create it without being superuser.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Task_title_trgm_idx" ON "Task" USING GIN ("title" gin_trgm_ops);

-- Numeric searches (`42` / `#42`) OR the title match with the issue and PR number: each branch needs
-- its own index for Postgres to combine them (BitmapOr) instead of scanning the visible projects.
CREATE INDEX "Task_githubIssueNumber_idx" ON "Task"("githubIssueNumber");

CREATE INDEX "Task_prNumber_idx" ON "Task"("prNumber");
