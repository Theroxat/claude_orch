/**
 * Tick benchmark (opt-in: DISPATCH_BENCH=1): 10 projects x 20 TODO tasks (200), 30 members in
 * every project. Counts the SQL statements of one tick and times it, for the previous
 * query-per-member dispatcher and the snapshot one, in two states:
 *   - saturated: every member is at maxConcurrent, the tick only reads;
 *   - fresh: every member has free slots, the tick creates offers.
 * Writes a Markdown table to DISPATCH_BENCH_OUT when set.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatch/dispatcher';
import { prisma } from './harness';
import { LegacyDispatcher } from './support/legacy-dispatcher';
import {
  assignmentKeys,
  captureLog,
  countingPrisma,
  dispatcherConfig,
  dropScenario,
  rng,
  seedScenario,
  type Scenario,
} from './support/dispatch-scenario';

afterAll(async () => {
  await prisma.$disconnect();
});

const config = dispatcherConfig({ DISPATCHER_ENABLED: 'true' });
const SHAPE = { projects: 10, members: 30, tasksPerProject: 20, participation: 1 };
const RUNS = 3;

type Impl = 'legacy' | 'snapshot';

async function measure(s: Scenario, impl: Impl) {
  const url = process.env.DATABASE_URL_TEST!;
  const before = new Set((await assignmentKeys(prisma, s)).map((a) => a.id));
  const { prisma: counted, counter } = countingPrisma(url);
  const { log, errors } = captureLog();
  const deps = { prisma: counted, config, gateway: s.gateway.asGateway(), log };
  const d = impl === 'legacy' ? new LegacyDispatcher(deps) : new Dispatcher(deps);
  await counted.$connect();
  const t0 = performance.now();
  await d.tick(s.now);
  const ms = performance.now() - t0;
  await counted.$disconnect();
  expect(errors).toEqual([]);
  const created = (await assignmentKeys(prisma, s)).filter((a) => !before.has(a.id));
  // Back to the seeded state for the next run.
  await prisma.assignment.deleteMany({ where: { id: { in: created.map((a) => a.id) } } });
  return { queries: counter.n, ms, offers: created.length, keys: created.map((a) => a.key).sort() };
}

describe.skipIf(!process.env.DISPATCH_BENCH)('dispatcher tick benchmark', () => {
  it('200 tasks x 30 members x 10 projects', async () => {
    const s = await seedScenario(prisma, rng(2026), SHAPE, { wild: false });
    const rows: string[] = [];
    try {
      for (const state of ['saturated', 'fresh'] as const) {
        await prisma.user.updateMany({
          where: { id: { in: s.userIds } },
          data: { maxConcurrent: state === 'saturated' ? 0 : 2 },
        });
        const res: Record<Impl, { queries: number; ms: number[]; offers: number; keys: string[] }> =
          {} as never;
        for (const impl of ['legacy', 'snapshot'] as const) {
          const ms: number[] = [];
          let last: Awaited<ReturnType<typeof measure>> | undefined;
          for (let i = 0; i < RUNS; i++) {
            last = await measure(s, impl);
            ms.push(last.ms);
          }
          res[impl] = { queries: last!.queries, ms, offers: last!.offers, keys: last!.keys };
        }
        expect(res.snapshot.keys).toEqual(res.legacy.keys);
        const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
        for (const impl of ['legacy', 'snapshot'] as const) {
          const r = res[impl];
          rows.push(
            `| ${state} | ${impl} | ${r.queries} | ${Math.round(med(r.ms))} ms | ${r.offers} |`,
          );
        }
      }
    } finally {
      await dropScenario(prisma, s);
    }
    const table = [
      '| state | dispatcher | SQL statements / tick | duration (median of 3) | offers |',
      '|---|---|---|---|---|',
      ...rows,
    ].join('\n');
    console.log(table);
    if (process.env.DISPATCH_BENCH_OUT) writeFileSync(process.env.DISPATCH_BENCH_OUT, table + '\n');
  }, 1_800_000);
});
