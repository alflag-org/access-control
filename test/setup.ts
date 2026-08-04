import { beforeAll } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';

interface TestEnvironment extends Env {
  TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
}

beforeAll(async () => {
  const testEnvironment = env as TestEnvironment;
  await applyD1Migrations(testEnvironment.DB, testEnvironment.TEST_MIGRATIONS);
});
