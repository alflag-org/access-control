import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './apps/worker/src/index.ts',
      wrangler: {
        configPath: './apps/worker/wrangler.jsonc',
      },
      miniflare: {
        bindings: {
          ENVIRONMENT: 'development',
          ALLOW_LOCAL_AUTH: 'true',
          LOCAL_BOOTSTRAP_IDENTITY: 'access:local-admin',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    })),
  ],
  resolve: {
    alias: {
      '@access-control/domain': repositoryFile('./packages/domain/src/index.ts'),
      '@access-control/application': repositoryFile('./packages/application/src/index.ts'),
      '@access-control/contracts': repositoryFile('./packages/contracts/src/index.ts'),
      '@access-control/config': repositoryFile('./packages/config/src/index.ts'),
      '@access-control/events': repositoryFile('./packages/events/src/index.ts'),
      '@access-control/d1': repositoryFile('./packages/adapters/d1/src/index.ts'),
      '@access-control/google': repositoryFile('./packages/adapters/google/src/index.ts'),
      '@access-control/github': repositoryFile('./packages/adapters/github/src/index.ts'),
      '@access-control/proxmox': repositoryFile('./packages/adapters/proxmox/src/index.ts'),
      '@access-control/zabbix': repositoryFile('./packages/adapters/zabbix/src/index.ts'),
      '@access-control/posix': repositoryFile('./packages/adapters/posix/src/index.ts'),
    },
  },
  test: {
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    // D1 integration files apply migrations independently; serialize files to avoid SQLite contention.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});

function repositoryFile(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}
