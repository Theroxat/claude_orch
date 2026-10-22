/**
 * Characterization of the per-tick snapshot: over many seeded random scenarios, the dispatcher
 * creates exactly the offers (and sends exactly the messages) the previous query-per-member
 * implementation did, and a tick's query count no longer grows with tasks x members.
 */
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

// More with DISPATCH_SCENARIOS=500 (and another range with DISPATCH_SEED).
const SCENARIOS = Number(process.env.DISPATCH_SCENARIOS ?? 40);
const SEED = Number(process.env.DISPATCH_SEED ?? 1000);
const config = dispatcherConfig({ DISPATCHER_ENABLED: 'true' });

/** Runs one tick and returns the assignments it created and the messages it sent. */
async function runTick(
  s: Scenario,
  make: (deps: ConstructorParameters<typeof Dispatcher>[0]) => {
    tick(now: Date): Promise<void>;
  },
) {
  const before = new Set((await assignmentKeys(prisma, s)).map((a) => a.id));
  s.gateway.sent.length = 0;
  const { log, errors } = captureLog();
  await make({ prisma, config, gateway: s.gateway.asGateway(), log }).tick(s.now);
  expect(errors).toEqual([]);
  const created = (await assignmentKeys(prisma, s)).filter((a) => !before.has(a.id));
  return { created, sent: [...s.gateway.sent] };
}

describe('dispatcher tick snapshot', () => {
  it(`makes the same offers as the per-member queries (${SCENARIOS} random scenarios)`, async () => {
    const totals = { auto: 0, requests: 0, cancelled: 0 };
    for (let i = 0; i < SCENARIOS; i++) {
      const seed = SEED + i;
      const r = rng(seed);
      const s = await seedScenario(
        prisma,
        r,
        {
          projects: r.int(1, 3),
          members: r.int(2, 7),
          tasksPerProject: r.int(2, 8),
          participation: 0.75,
        },
        { wild: true },
      );
      try {
        const legacy = await runTick(s, (deps) => new LegacyDispatcher(deps));
        // Back to the seeded state: the new dispatcher decides from the same rows.
        await prisma.assignment.deleteMany({
          where: { id: { in: legacy.created.map((a) => a.id) } },
        });
        const next = await runTick(s, (deps) => new Dispatcher(deps));
        const keys = (x: typeof legacy) => x.created.map((a) => a.key).sort();
        expect(keys(next), `seed ${seed}`).toEqual(keys(legacy));
        expect(next.sent, `seed ${seed}`).toEqual(legacy.sent);
        for (const a of next.created) {
          if (a.key.includes('CANCELLED')) totals.cancelled++;
          else if (a.key.includes('AUTO_OFFER')) totals.auto++;
          else totals.requests++;
        }
      } finally {
        await dropScenario(prisma, s);
      }
    }
    // The scenarios exercise every path, not just "nobody is eligible".
    expect(totals.auto, JSON.stringify(totals)).toBeGreaterThan(SCENARIOS / 2);
    expect(totals.requests, JSON.stringify(totals)).toBeGreaterThan(SCENARIOS / 8);
    expect(totals.cancelled, JSON.stringify(totals)).toBeGreaterThan(0);
    if (process.env.DISPATCH_TOTALS) {
      (await import('node:fs')).writeFileSync(process.env.DISPATCH_TOTALS, JSON.stringify(totals));
    }
  });

  it('keeps maxConcurrent and budgets across the offers of one tick', async () => {
    // One member, one agent able to take 2 tasks, 6 open tasks: exactly 2 auto offers.
    const r = rng(7);
    const s = await seedScenario(
      prisma,
      r,
      { projects: 1, members: 1, tasksPerProject: 6, participation: 1 },
      { wild: false },
    );
    try {
      const busy = await prisma.assignment.count({
        where: { userId: s.userIds[0], status: { in: ['ACCEPTED', 'RUNNING'] } },
      });
      const next = await runTick(s, (deps) => new Dispatcher(deps));
      expect(next.created).toHaveLength(Math.max(0, 2 - busy));
      // A second tick adds nothing: the live offers hold the slots.
      const again = await runTick(s, (deps) => new Dispatcher(deps));
      expect(again.created).toHaveLength(0);
    } finally {
      await dropScenario(prisma, s);
    }
  });

  it('reads with a fixed number of queries, whatever the number of tasks and members', async () => {
    const url = process.env.DATABASE_URL_TEST!;
    const counts: number[] = [];
    for (const shape of [
      { projects: 1, members: 3, tasksPerProject: 3, participation: 1 },
      { projects: 4, members: 12, tasksPerProject: 10, participation: 1 },
    ]) {
      const s = await seedScenario(prisma, rng(42), shape, { wild: false });
      try {
        // Every member is busy (maxConcurrent reached): the tick reads but makes no offer.
        await prisma.user.updateMany({
          where: { id: { in: s.userIds } },
          data: { maxConcurrent: 0 },
        });
        const { prisma: counted, counter } = countingPrisma(url);
        const { log, errors } = captureLog();
        const d = new Dispatcher({ prisma: counted, config, gateway: s.gateway.asGateway(), log });
        await d.tick(s.now);
        expect(errors).toEqual([]);
        counts.push(counter.n);
        if (process.env.DISPATCH_LOG_QUERIES) console.log(counter.log.join('\n'));
        await counted.$disconnect();
      } finally {
        await dropScenario(prisma, s);
      }
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(25);
  });
});
