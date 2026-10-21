import { execSync } from 'node:child_process';

/**
 * Integration tests run against the `orch_test` database of the compose postgres.
 * DATABASE_URL_TEST is provided by the tools service. The DB is reset (dropped and re-migrated) once before each run so it never accumulates rows.
 */
export default function setup(): void {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set (run tests through ./dev test)');
  process.env.DATABASE_URL = url;
  execSync('pnpm exec prisma migrate reset --force --skip-seed --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
