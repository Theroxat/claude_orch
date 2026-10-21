import { afterAll, describe, expect, it } from 'vitest';
import { testPrisma } from './db';

const prisma = testPrisma();

afterAll(async () => {
  await prisma.$disconnect();
});

describe('test database', () => {
  it('has the migrated schema and enforces unique logins', async () => {
    const login = `vitest-${Date.now()}`;
    const user = await prisma.user.create({ data: { githubId: BigInt(Date.now()), login } });
    await expect(
      prisma.user.create({ data: { githubId: BigInt(Date.now() + 1), login } }),
    ).rejects.toThrow();
    await prisma.user.delete({ where: { id: user.id } });
  });
});
