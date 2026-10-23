/**
 * Characterization of the per-tick snapshot: over many seeded random scenarios, the dispatcher
 * creates exactly the offers (and sends exactly the messages) the previous query-per-member
 * implementation did, and a tick's query count no longer grows with tasks x members.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Dispatcher, dispatchTaskInclude } from '../src/dispatch/dispatcher';
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
  }, 300_000);

  it('explains (why-not-running) and computes margins (Offers page) like the old queries', async () => {
    const n = Math.max(10, Math.floor(SCENARIOS / 3));
    let candidates = 0;
    let margins = 0;
    for (let i = 0; i < n; i++) {
      const seed = SEED + 7000 + i;
      const r = rng(seed);
      const s = await seedScenario(
        prisma,
        r,
        {
          projects: r.int(1, 3),
          members: r.int(2, 6),
          tasksPerProject: r.int(2, 6),
          participation: 0.75,
        },
        { wild: true },
      );
      try {
        const { log } = captureLog();
        const deps = { prisma, config, gateway: s.gateway.asGateway(), log };
        const legacy = new LegacyDispatcher(deps);
        const next = new Dispatcher(deps);
        const tasks = await prisma.task.findMany({
          where: { id: { in: s.taskIds }, status: 'TODO' },
          include: dispatchTaskInclude,
          orderBy: { createdAt: 'asc' },
        });
        const tick = await next.snapshot(tasks, s.now);
        for (const t of tasks) {
          const want = await legacy.evaluateMembers(t, s.now);
          // whyNotRunning: a snapshot of this task only; the tick: one snapshot for all.
          const alone = await next.evaluateMembers(t, await next.snapshot([t], s.now), s.now);
          expect(alone, `seed ${seed} task ${t.id}`).toEqual(want);
          expect(await next.evaluateMembers(t, tick, s.now), `seed ${seed}`).toEqual(want);
          candidates += want.filter((m) => m.candidate).length;
        }
        for (const userId of s.userIds) {
          const usage = await next.latestUsage(userId);
          if (!usage) continue;
          const ledger = await next.budgetLedger(userId, usage, s.now);
          for (const projectId of s.projectIds) {
            const want = await legacy.marginOf(userId, projectId, 40, usage, s.now);
            expect(await next.marginOf(userId, projectId, 40, usage, s.now)).toEqual(want);
            expect(ledger.marginOf(userId, projectId, 40, usage)).toEqual(want);
            if (want) margins++;
          }
        }
      } finally {
        await dropScenario(prisma, s);
      }
    }
    expect(candidates).toBeGreaterThan(n);
    expect(margins).toBeGreaterThan(n);
  }, 300_000);

  it('re-checks slots under a member lock: a concurrent accept cannot share the last slot', async () => {
    // One member, maxConcurrent 1, one free agent, one open task.
    const s = await seedScenario(
      prisma,
      rng(11),
      { projects: 1, members: 1, tasksPerProject: 1, participation: 1 },
      { wild: false },
    );
    try {
      const userId = s.userIds[0]!;
      await prisma.assignment.deleteMany({ where: { userId } });
      await prisma.user.update({ where: { id: userId }, data: { maxConcurrent: 1 } });
      const [agentId] = [...s.gateway.connected.keys()];
      const other = await prisma.task.findFirstOrThrow({
        where: { projectId: s.projectIds[0], status: { not: 'TODO' } },
      });
      // Another transaction (an accept on another task) holds the member's row and takes the
      // slot; it commits while the tick's offer transaction is waiting.
      let release!: () => void;
      const held = new Promise<void>((res) => (release = res));
      let locked!: () => void;
      const lockTaken = new Promise<void>((res) => (locked = res));
      const accept = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
          await tx.assignment.create({
            data: { taskId: other.id, userId, agentId, kind: 'CLAIM', status: 'ACCEPTED' },
          });
          locked();
          await held;
        },
        { timeout: 20_000 },
      );
      await lockTaken;
      const { log, errors } = captureLog();
      const d = new Dispatcher({ prisma, config, gateway: s.gateway.asGateway(), log });
      // The tick has read its snapshot (ownerAllowed is the last check before the offer): let
      // the accept commit a little later, while the offer transaction runs.
      const gw = s.gateway;
      const orig = gw.ownerAllowed.bind(gw);
      gw.ownerAllowed = async (u: { id: string }) => {
        setTimeout(release, 300);
        return orig(u);
      };
      await d.tick(s.now);
      await accept;
      expect(errors).toEqual([]);
      const pendingOffers = () =>
        prisma.assignment.count({ where: { userId, kind: 'AUTO_OFFER', status: 'PENDING' } });
      expect(await pendingOffers()).toBe(0);
      // Once the slot is free again the offer goes out (the setup does offer).
      await prisma.assignment.deleteMany({ where: { userId } });
      gw.ownerAllowed = orig;
      await d.tick(s.now);
      expect(await pendingOffers()).toBe(1);
    } finally {
      await dropScenario(prisma, s);
    }
  }, 60_000);

  it('re-checks the budget against runs accepted after the snapshot was read', async () => {
    // One member who can run 3 tasks, with budget for exactly one more S task. A run accepted
    // while the tick is deciding (after its snapshot) uses that budget: no auto offer.
    const s = await seedScenario(
      prisma,
      rng(12),
      { projects: 1, members: 1, tasksPerProject: 1, participation: 1 },
      { wild: false },
    );
    try {
      const userId = s.userIds[0]!;
      const projectId = s.projectIds[0]!;
      await prisma.assignment.deleteMany({ where: { userId } });
      await prisma.user.update({ where: { id: userId }, data: { maxConcurrent: 3 } });
      for (const [, c] of s.gateway.connected) c.max = 3;
      const [todo] = await prisma.task.findMany({
        where: { projectId, status: 'TODO' },
        include: dispatchTaskInclude,
      });
      await prisma.task.update({ where: { id: todo!.id }, data: { size: 'S', model: 'SONNET' } });
      const other = await prisma.task.findFirstOrThrow({
        where: { projectId, status: { not: 'TODO' } },
      });
      await prisma.task.update({ where: { id: other.id }, data: { size: 'S', model: 'SONNET' } });
      const { log, errors } = captureLog();
      const d = new Dispatcher({ prisma, config, gateway: s.gateway.asGateway(), log });
      const usage = (await d.latestUsage(userId))!;
      const t = await prisma.task.findUniqueOrThrow({
        where: { id: todo!.id },
        include: dispatchTaskInclude,
      });
      const estimate = (await d.budgetLedger(userId, usage, s.now)).estimate(
        t,
        t.project.sizeBudgets,
      );
      // Capacity such that the margin (project and global) is between one and two estimates.
      await prisma.participation.update({
        where: { userId_projectId: { userId, projectId } },
        data: { percent: 100 },
      });
      const scale =
        usage.capacity! / (await d.marginOf(userId, projectId, 100, usage, s.now))!.budget;
      const report = await prisma.usageReport.findFirstOrThrow({
        where: { userId },
        orderBy: { reportedAt: 'desc' },
      });
      await prisma.usageReport.update({
        where: { id: report.id },
        data: {
          weightedTokens: 0n,
          byProject: {},
          capacityEstimate: BigInt(Math.round(1.6 * estimate * scale)),
        },
      });
      const fresh = (await d.latestUsage(userId))!;
      const m = (await d.marginOf(userId, projectId, 100, fresh, s.now, t.id))!;
      expect(Math.min(m.margin, m.globalMargin)).toBeGreaterThanOrEqual(estimate);
      expect(Math.min(m.margin, m.globalMargin)).toBeLessThan(2 * estimate);
      // The accept happens after the snapshot (the first ownerAllowed call is mid-tick).
      const gw = s.gateway;
      const orig = gw.ownerAllowed.bind(gw);
      let once = false;
      gw.ownerAllowed = async (u: { id: string }) => {
        if (!once) {
          once = true;
          const [agentId] = [...gw.connected.keys()];
          await prisma.assignment.create({
            data: { taskId: other.id, userId, agentId, kind: 'CLAIM', status: 'ACCEPTED' },
          });
        }
        return orig(u);
      };
      await d.tick(s.now);
      expect(errors).toEqual([]);
      expect(once).toBe(true);
      expect(
        await prisma.assignment.count({ where: { userId, kind: 'AUTO_OFFER', status: 'PENDING' } }),
      ).toBe(0);
      // Without that run the offer goes out (the setup is not simply over budget).
      await prisma.assignment.deleteMany({ where: { userId } });
      await d.tick(s.now);
      expect(
        await prisma.assignment.count({ where: { userId, kind: 'AUTO_OFFER', status: 'PENDING' } }),
      ).toBe(1);
    } finally {
      await dropScenario(prisma, s);
    }
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);
});
