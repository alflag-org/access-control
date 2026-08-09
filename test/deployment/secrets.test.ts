import { describe, expect, it } from 'vitest';
import { credentialReferences, parseWorkerSecretValues } from '@access-control/deployment';
import { runtimeConfigurationManifestSchema } from '@access-control/config';

const manifest = runtimeConfigurationManifestSchema.parse({
  schemaVersion: 1,
  organization: { name: 'Example', title: 'Access Control', maxPlanChanges: 20 },
  directorySources: [
    {
      id: 'directory:example',
      provider: 'google',
      customerId: 'customer',
      delegatedAdmin: 'admin@example.com',
      credentialRef: 'GOOGLE_DIRECTORY_CREDENTIAL',
      accessGroupPrefix: 'access-',
      status: 'active',
    },
  ],
  applications: [],
  providerConnections: [
    {
      id: 'provider:github',
      provider: 'github',
      name: 'GitHub',
      mode: 'observe',
      credentialRef: 'GITHUB_CREDENTIAL',
      configuration: { organization: 'example' },
      status: 'active',
    },
  ],
  provisioningTargets: [],
  mappings: [],
});

describe('deployment Worker secrets', () => {
  it('derives stable required secret names from credentialRef values', () => {
    expect(credentialReferences(manifest)).toEqual([
      'GITHUB_CREDENTIAL',
      'GOOGLE_DIRECTORY_CREDENTIAL',
    ]);
  });

  it('accepts exactly one value for each credentialRef', () => {
    expect(
      parseWorkerSecretValues(
        JSON.stringify({
          GITHUB_CREDENTIAL: 'github-secret',
          GOOGLE_DIRECTORY_CREDENTIAL: 'google-secret',
        }),
        manifest,
      ),
    ).toEqual({
      GITHUB_CREDENTIAL: 'github-secret',
      GOOGLE_DIRECTORY_CREDENTIAL: 'google-secret',
    });
  });

  it('rejects missing and unrelated secret entries', () => {
    expect(() =>
      parseWorkerSecretValues(
        JSON.stringify({
          GOOGLE_DIRECTORY_CREDENTIAL: 'google-secret',
          UNRELATED_SECRET: 'unrelated',
        }),
        manifest,
      ),
    ).toThrow(/missing GITHUB_CREDENTIAL; unexpected UNRELATED_SECRET/);
  });
});
