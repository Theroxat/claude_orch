import { PrismaClient } from '@prisma/client';

export function testPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set');
  return new PrismaClient({ datasourceUrl: url });
}
