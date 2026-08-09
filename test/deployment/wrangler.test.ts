import { describe, expect, it } from 'vitest';
import { buildWranglerConfiguration, deploymentManifestSchema } from '@access-control/deployment';

describe('generated Wrangler configuration', () => {
  it('combines the public base with one environment deployment manifest', () => {
    const deployment = deploymentManifestSchema.parse({
      schemaVersion: 1,
      environment: 'production',
      worker: {
        name: 'access-control-prod',
        baseUrl: 'https://access.example.com',
        routes: [{ pattern: 'access.example.com', customDomain: true }],
      },
      resources: {
        database: {
          name: 'access-control-prod',
          id: '11111111-1111-4111-8111-111111111111',
        },
        exportsBucket: 'access-control-prod-exports',
        outboxQueue: 'access-control-prod-outbox',
        deadLetterQueue: 'access-control-prod-dead-letter',
      },
      access: {
        teamDomain: 'example.cloudflareaccess.com',
        audience: 'production-access-audience',
      },
      features: { providerWritesEnabled: false },
      observability: { tracesHeadSamplingRate: 0.05 },
      crons: ['0 */6 * * *'],
    });
    const config = buildWranglerConfiguration({
      baseConfig: publicBase,
      baseConfigPath: '/source/apps/worker/wrangler.json',
      outputPath: '/source/.wrangler/test-deployment/wrangler.json',
      deployment,
      requiredSecrets: ['GOOGLE_DIRECTORY_CREDENTIAL'],
    });

    expect(config).not.toHaveProperty('env');
    expect(config).not.toHaveProperty('keep_vars');
    expect(config).toMatchObject({
      name: 'access-control-prod',
      workers_dev: false,
      preview_urls: false,
      vars: {
        ENVIRONMENT: 'production',
        ALLOW_LOCAL_AUTH: 'false',
        ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
        ACCESS_AUD: 'production-access-audience',
        PROVIDER_WRITES_ENABLED: 'false',
      },
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'access-control-prod',
          database_id: '11111111-1111-4111-8111-111111111111',
        },
      ],
      r2_buckets: [{ binding: 'EXPORTS_BUCKET', bucket_name: 'access-control-prod-exports' }],
      queues: {
        producers: [{ binding: 'OUTBOX_QUEUE', queue: 'access-control-prod-outbox' }],
        consumers: [
          {
            queue: 'access-control-prod-outbox',
            dead_letter_queue: 'access-control-prod-dead-letter',
            max_batch_size: 10,
            max_batch_timeout: 10,
            max_retries: 3,
          },
        ],
      },
      routes: [{ pattern: 'access.example.com', custom_domain: true }],
      observability: { traces: { enabled: true, head_sampling_rate: 0.05 } },
      triggers: { crons: ['0 */6 * * *'] },
      secrets: { required: ['GOOGLE_DIRECTORY_CREDENTIAL'] },
    });
    expect(String(config.main)).toMatch(/apps\/worker\/src\/index\.ts$/);
    expect(String(config.$schema)).toMatch(/node_modules\/wrangler\/config-schema\.json$/);
  });
});

const publicBase = {
  $schema: '../../node_modules/wrangler/config-schema.json',
  name: 'access-control',
  main: 'src/index.ts',
  compatibility_date: '2026-07-30',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  preview_urls: false,
  vars: {
    ENVIRONMENT: 'production',
    ALLOW_LOCAL_AUTH: 'false',
    ACCESS_TEAM_DOMAIN: 'unset',
    ACCESS_AUD: 'unset',
    LOCAL_BOOTSTRAP_IDENTITY: 'unset',
    PROVIDER_WRITES_ENABLED: 'false',
  },
  d1_databases: [{ binding: 'DB', migrations_dir: '../../migrations' }],
  r2_buckets: [{ binding: 'EXPORTS_BUCKET' }],
  queues: {
    producers: [{ binding: 'OUTBOX_QUEUE', queue: 'access-control-outbox' }],
    consumers: [
      {
        queue: 'access-control-outbox',
        max_batch_size: 10,
        max_batch_timeout: 10,
        max_retries: 3,
        dead_letter_queue: 'access-control-dead-letter',
      },
    ],
  },
  observability: {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1 },
    traces: { enabled: true, head_sampling_rate: 0.01 },
  },
};
