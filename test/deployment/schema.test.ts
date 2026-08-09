import { describe, expect, it } from 'vitest';
import {
  deploymentManifestSchema,
  environmentManifestsSchema,
  releaseManifestSchema,
} from '@access-control/deployment';

const deployment = {
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
  crons: ['0 */6 * * *'],
} as const;

const runtime = {
  schemaVersion: 1,
  organization: { name: 'Example', title: 'Example', maxPlanChanges: 20 },
  directorySources: [],
  applications: [],
  providerConnections: [],
  provisioningTargets: [],
  mappings: [],
} as const;

describe('deployment manifest schemas', () => {
  it('accepts one complete environment manifest set', () => {
    expect(
      environmentManifestsSchema.parse({
        release: {
          repository: 'example/access-control',
          commit: '0123456789abcdef0123456789abcdef01234567',
        },
        deployment,
        runtime,
      }),
    ).toMatchObject({ deployment: { environment: 'production' } });
  });

  it('requires an immutable full commit SHA', () => {
    expect(
      releaseManifestSchema.safeParse({
        repository: 'example/access-control',
        commit: 'master',
      }).success,
    ).toBe(false);
  });

  it('requires the service URL to be an explicitly managed custom domain', () => {
    expect(
      deploymentManifestSchema.safeParse({
        ...deployment,
        worker: { ...deployment.worker, baseUrl: 'https://other.example.com' },
      }).success,
    ).toBe(false);
  });

  it('requires the service URL to be a root origin', () => {
    expect(
      deploymentManifestSchema.safeParse({
        ...deployment,
        worker: { ...deployment.worker, baseUrl: 'https://access.example.com/api' },
      }).success,
    ).toBe(false);
  });

  it('rejects credential-like deployment fields', () => {
    expect(
      deploymentManifestSchema.safeParse({
        ...deployment,
        resources: { ...deployment.resources, apiToken: 'plaintext-token' },
      }).success,
    ).toBe(false);
  });
});
