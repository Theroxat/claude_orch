-- States the HTTP API cannot reach. Run by stack.sh after seed.mjs phase2.
BEGIN;

-- Extra users: a pending and a rejected participant of acme/widgets (they never log in).
INSERT INTO "User" (id, "githubId", login, name, "updatedAt") VALUES
  ('u_dana', 9001, 'dana', 'Dana Pending', now()),
  ('u_erin', 9002, 'erin', 'Erin Rejected', now())
ON CONFLICT DO NOTHING;
INSERT INTO "ProjectPermission" (id, "projectId", "userId", "githubRole", "syncedAt", "updatedAt")
SELECT 'pp_' || u.id, p.id, u.id, 'WRITE', now(), now()
FROM "User" u, "Project" p WHERE u.id IN ('u_dana','u_erin') AND p."fullName" = 'acme/widgets'
ON CONFLICT DO NOTHING;
INSERT INTO "Participation" (id, "userId", "projectId", active, percent, mode, "updatedAt")
SELECT 'pa_dana', 'u_dana', p.id, true, 20, 'APPROVAL', now() FROM "Project" p WHERE p."fullName" = 'acme/widgets'
ON CONFLICT DO NOTHING;
INSERT INTO "Participation" (id, "userId", "projectId", active, percent, mode, "rejectedAt", "lastRejectedAt", "rejectionReason", "updatedAt")
SELECT 'pa_erin', 'u_erin', p.id, false, 40, 'AUTO', now(), now(), 'Not enough capacity right now', now() FROM "Project" p WHERE p."fullName" = 'acme/widgets'
ON CONFLICT DO NOTHING;

-- Agents: alice's real agent reports an old version (one-click update available); a second, older
-- one is offline; bob has an agent whose Claude login expired.
UPDATE "Agent" SET "agentVersion" = '0.5.2' WHERE name = 'alice-laptop';
INSERT INTO "Agent" (id, "userId", name, hostname, os, arch, "agentVersion", "secretHash", "secretPrefix", "lastSeenAt", "claudeTokenPresent", "updatedAt")
SELECT 'agt_old_nas', u.id, 'old-nas', 'old-nas', 'linux', 'arm64', '0.4.2', 'x', 'abcdef', now() - interval '3 hours', true, now()
FROM "User" u WHERE u.login = 'alice' ON CONFLICT DO NOTHING;
INSERT INTO "Agent" (id, "userId", name, hostname, os, arch, "agentVersion", "secretHash", "secretPrefix", "lastSeenAt", "claudeTokenPresent",
  "claudeAuthValid", "claudeAuthInvalidAt", "claudeAuthCheckedAt", "claudeAuthError", "updatedAt")
SELECT 'agt_bob_desktop', u.id, 'bob-desktop', 'bob-desktop', 'linux', 'x64', '__ORCH_VERSION__', 'y', 'ghijkl', now() - interval '10 minutes', true,
  false, now() - interval '5 minutes', now() - interval '5 minutes', 'unauthorized', now()
FROM "User" u WHERE u.login = 'bob' ON CONFLICT DO NOTHING;

-- Task states.
UPDATE "Task" SET status = 'IN_PROGRESS', "assigneeId" = (SELECT id FROM "User" WHERE login='alice'),
  "assigneeAgentId" = (SELECT id FROM "Agent" WHERE name='alice-laptop'), "branchName" = 'orch/issue-3-ui-in-progress' WHERE title = 'UI in progress task';
UPDATE "Task" SET status = 'IN_REVIEW', "assigneeId" = (SELECT id FROM "User" WHERE login='alice'),
  "prNumber" = 12, "prUrl" = 'http://fake-github:8080/acme/widgets/pull/12', "branchName" = 'orch/issue-4-ui-in-review' WHERE title = 'UI in review task';
UPDATE "Task" SET status = 'DONE', "assigneeId" = (SELECT id FROM "User" WHERE login='alice'),
  "prNumber" = 11, "prUrl" = 'http://fake-github:8080/acme/widgets/pull/11' WHERE title = 'UI done task';
UPDATE "Task" SET status = 'TODO', "needsAttention" = true, "needsAttentionReason" = 'Repository setup failed 3 times: docker compose build exited with 1',
  "needsAttentionAt" = now() WHERE title = 'UI failed task';
UPDATE "Task" SET status = 'PROPOSED' WHERE title = 'UI proposed task';

INSERT INTO "Assignment" (id, "taskId", "userId", "agentId", kind, status, "execMode", "startedAt", "updatedAt")
SELECT 'as_prog', t.id, t."assigneeId", t."assigneeAgentId", 'AUTO_OFFER', 'RUNNING', 'AUTO', now() - interval '4 minutes', now()
FROM "Task" t WHERE t.title = 'UI in progress task' ON CONFLICT DO NOTHING;
INSERT INTO "Assignment" (id, "taskId", "userId", "agentId", kind, status, "execMode", "failureClass", "reason", "finishedAt", "updatedAt")
SELECT 'as_fail' || g, t.id, (SELECT id FROM "User" WHERE login='alice'), (SELECT id FROM "Agent" WHERE name='alice-laptop'),
  'AUTO_OFFER', 'FAILED', 'AUTO', 'env', 'docker compose build exited with 1', now() - interval '1 hour', now()
FROM "Task" t, generate_series(1,3) g WHERE t.title = 'UI failed task' ON CONFLICT DO NOTHING;

-- A pending approval request for bob (consent request on the members-only task).
INSERT INTO "Assignment" (id, "taskId", "userId", "agentId", kind, status, "expiresAt", "updatedAt")
SELECT 'as_consent', t.id, (SELECT id FROM "User" WHERE login='bob'), 'agt_bob_desktop', 'CONSENT_REQUEST', 'PENDING', now() + interval '7 days', now()
FROM "Task" t WHERE t.title = 'UI members-only task'
  AND NOT EXISTS (SELECT 1 FROM "Assignment" a WHERE a."taskId" = t.id AND a."userId" = (SELECT id FROM "User" WHERE login='bob') AND a.status = 'PENDING')
ON CONFLICT DO NOTHING;

-- Two pending access requests for the admin page (strangers that never sign in again).
INSERT INTO "AccessGrant" (id, "githubLogin", status, note, "requestedAt", "updatedAt") VALUES
  ('ag_zoe', 'zoe', 'PENDING', 'Hi, I am on the platform team and would like to lend my Claude capacity.', now() - interval '2 hours', now()),
  ('ag_yan', 'yan', 'PENDING', NULL, now() - interval '5 minutes', now())
ON CONFLICT DO NOTHING;

COMMIT;
