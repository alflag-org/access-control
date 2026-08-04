import { describe, expect, it } from 'vitest';
import {
  createDirectorySourceCandidate,
  createEntitlementMappingCandidate,
} from '@access-control/domain';
import {
  createConfigurationPlan,
  runtimeConfigurationManifestSchema,
  type RuntimeConfigurationManifest,
} from '@access-control/config';
import {
  emptyConfigurationManifest as emptyManifest,
  emptyConfigurationSnapshot as emptySnapshot,
} from '../fixtures/config-fixtures';

const time = '2026-01-01T00:00:00.000Z';

describe('Declarative runtime configuration schema and plan', () => {
  it('accepts a valid manifest and rejects unknown fields', () => {
    expect(runtimeConfigurationManifestSchema.parse(emptyManifest())).toEqual(emptyManifest());
    expect(() =>
      runtimeConfigurationManifestSchema.parse({ ...emptyManifest(), unexpected: true }),
    ).toThrow();
  });

  it('rejects duplicate aggregate, application, and entitlement keys', () => {
    const duplicateIds = emptyManifest();
    duplicateIds.directorySources = [
      directoryManifest('directory:google'),
      directoryManifest('directory:google'),
    ];
    expect(() => runtimeConfigurationManifestSchema.parse(duplicateIds)).toThrow(
      /Duplicate stable identifier directory:google/,
    );

    const duplicateApplications = emptyManifest();
    duplicateApplications.applications = [
      applicationManifest('catalog'),
      applicationManifest('catalog'),
    ];
    expect(() => runtimeConfigurationManifestSchema.parse(duplicateApplications)).toThrow(
      /Duplicate stable identifier catalog/,
    );

    const duplicateEntitlements = emptyManifest();
    const application = applicationManifest('catalog');
    application.entitlements.push(structuredClone(application.entitlements[0]!));
    duplicateEntitlements.applications = [application];
    expect(() => runtimeConfigurationManifestSchema.parse(duplicateEntitlements)).toThrow(
      /Duplicate stable identifier reader/,
    );
  });

  it('rejects unresolved references and invalid lifecycle combinations', () => {
    const missingReference = emptyManifest();
    missingReference.provisioningTargets = [
      {
        id: 'target:missing',
        providerConnectionId: 'provider:missing',
        applicationKey: 'catalog',
        entitlementKey: 'reader',
        targetType: 'github_team_membership',
        providerTargetId: 'readers',
        mode: 'observe',
        protected: false,
        configuration: {},
        status: 'active',
      },
    ];
    expect(() => runtimeConfigurationManifestSchema.parse(missingReference)).toThrow(
      /Unknown Provider Connection/,
    );

    const invalidLifecycle = emptyManifest();
    const retiredApplication = applicationManifest('catalog');
    retiredApplication.status = 'retired';
    invalidLifecycle.applications = [retiredApplication];
    expect(() => runtimeConfigurationManifestSchema.parse(invalidLifecycle)).toThrow(
      /Entitlements of a retired application must also be retired/,
    );
  });

  it('rejects secret-like fields and invalid credential binding names', () => {
    const secret = emptyManifest();
    secret.providerConnections = [
      {
        id: 'provider:github',
        provider: 'github',
        name: 'GitHub',
        mode: 'observe',
        configuration: { client_secret: 'must-not-be-here' },
        status: 'active',
      },
    ];
    expect(() => runtimeConfigurationManifestSchema.parse(secret)).toThrow(
      /Credential-like fields are forbidden/,
    );

    for (const configuration of [
      { apiKey: 'literal-secret' },
      { credentialRef: 'literal-secret' },
      { passwordRef: 'literal-secret' },
    ]) {
      const bypass = emptyManifest();
      bypass.providerConnections = [
        {
          id: 'provider:github',
          provider: 'github',
          name: 'GitHub',
          mode: 'observe',
          configuration,
          status: 'active',
        },
      ];
      expect(runtimeConfigurationManifestSchema.safeParse(bypass).success).toBe(false);
    }

    const invalidBinding = emptyManifest();
    invalidBinding.directorySources = [
      {
        id: 'directory:google',
        provider: 'google',
        customerId: 'customer',
        delegatedAdmin: 'admin@example.org',
        credentialRef: 'literal-secret-value',
        accessGroupPrefix: 'access.',
        status: 'active',
      },
    ];
    expect(() => runtimeConfigurationManifestSchema.parse(invalidBinding)).toThrow(
      /runtime binding name/,
    );
  });

  it('produces the same sorted plan hash regardless of input order or generatedAt', async () => {
    const first = emptyManifest();
    first.directorySources = [directoryManifest('directory:z'), directoryManifest('directory:a')];
    const second = emptyManifest();
    second.directorySources = [...first.directorySources].reverse();
    const snapshot = emptySnapshot();

    const firstPlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(first),
      snapshot,
      generatedAt: time,
    });
    const secondPlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(second),
      snapshot,
      generatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(firstPlan.planHash).toBe(secondPlan.planHash);
    expect(firstPlan.changes.map((change) => change.stableKey)).toEqual([
      'directory:a',
      'directory:z',
    ]);
  });

  it('makes the plan hash independent of JSON object key order', async () => {
    const first = emptyManifest();
    first.providerConnections = [
      {
        id: 'provider:github',
        provider: 'github',
        name: 'GitHub',
        mode: 'observe',
        configuration: {
          organization: 'example-organization',
          teamSlugs: ['engineering', 'operations'],
        },
        status: 'active',
      },
    ];
    const second = structuredClone(first);
    second.providerConnections[0]!.configuration = {
      teamSlugs: ['engineering', 'operations'],
      organization: 'example-organization',
    };

    const firstPlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(first),
      snapshot: emptySnapshot(),
      generatedAt: time,
    });
    const secondPlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(second),
      snapshot: emptySnapshot(),
      generatedAt: time,
    });

    expect(firstPlan.planHash).toBe(secondPlan.planHash);
  });

  it('plans ordinary updates and emits a no-op after convergence', async () => {
    const manifest = emptyManifest();
    manifest.directorySources = [
      { ...directoryManifest('directory:google'), delegatedAdmin: 'replacement@example.org' },
    ];
    const snapshot = emptySnapshot();
    snapshot.directorySources = [
      createDirectorySourceCandidate({
        ...directoryManifest('directory:google'),
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];

    const updatePlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(manifest),
      snapshot,
      generatedAt: time,
    });
    expect(updatePlan.blockedChanges).toEqual([]);
    expect(updatePlan.changes).toMatchObject([
      {
        action: 'directory-source.update',
        stableKey: 'directory:google',
        expectedRevision: 1,
      },
    ]);

    snapshot.directorySources = [
      createDirectorySourceCandidate({
        ...directoryManifest('directory:google'),
        delegatedAdmin: 'replacement@example.org',
        revision: 2,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];
    const noOpPlan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(manifest),
      snapshot,
      generatedAt: time,
    });
    expect(noOpPlan.changes).toEqual([]);
    expect(noOpPlan.blockedChanges).toEqual([]);
  });

  it('places protected changes in blockedChanges and never in changes', async () => {
    const manifest = emptyManifest();
    manifest.directorySources = [
      {
        ...directoryManifest('directory:google'),
        customerId: 'replacement-customer',
      },
    ];
    const snapshot = emptySnapshot();
    snapshot.directorySources = [
      createDirectorySourceCandidate({
        ...directoryManifest('directory:google'),
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];
    const plan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(manifest),
      snapshot,
      generatedAt: time,
    });

    expect(plan.changes).toEqual([]);
    expect(plan.blockedChanges).toMatchObject([
      {
        action: 'directory-source.update',
        stableKey: 'directory:google',
        blockedCode: 'protected_directory_source_change',
      },
    ]);
  });

  it('blocks bulk mapping retirement without a bypass action', async () => {
    const snapshot = emptySnapshot();
    snapshot.mappings = ['mapping:one', 'mapping:two'].map((id) =>
      createEntitlementMappingCandidate({
        id,
        sourceGroupId: 'group:readers',
        entitlementIds: ['entitlement:reader'],
        provisioningTargetIds: [],
        status: 'active',
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    );

    const plan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(emptyManifest()),
      snapshot,
      generatedAt: time,
    });

    expect(plan.changes).toEqual([]);
    expect(plan.blockedChanges).toHaveLength(2);
    expect(
      plan.blockedChanges.every((change) => change.blockedCode === 'bulk_retire_protected'),
    ).toBe(true);
  });

  it('blocks Mapping activation until the immutable Source Group ID is observed', async () => {
    const manifest = emptyManifest();
    manifest.applications = [applicationManifest('catalog')];
    manifest.mappings = [
      {
        id: 'mapping:catalog-readers',
        sourceGroup: {
          providerGroupId: 'google-group-readers',
          expectedEmail: 'access.catalog.readers@example.org',
        },
        entitlements: [{ applicationKey: 'catalog', entitlementKey: 'reader' }],
        provisioningTargetIds: [],
        status: 'active',
      },
    ];
    const plan = await createConfigurationPlan({
      environment: 'staging',
      manifest: runtimeConfigurationManifestSchema.parse(manifest),
      snapshot: emptySnapshot(),
      generatedAt: time,
    });

    expect(plan.blockedChanges).toContainEqual(
      expect.objectContaining({
        action: 'mapping.activate',
        blockedCode: 'source_group_not_observed',
      }),
    );
  });
});

function directoryManifest(id: string): RuntimeConfigurationManifest['directorySources'][number] {
  return {
    id,
    provider: 'google',
    customerId: 'customer',
    delegatedAdmin: 'admin@example.org',
    credentialRef: 'GOOGLE_CREDENTIAL',
    accessGroupPrefix: 'access.',
    status: 'active',
  };
}

function applicationManifest(key: string): RuntimeConfigurationManifest['applications'][number] {
  return {
    key,
    name: 'Catalog',
    category: 'Knowledge',
    launchUrl: 'https://catalog.example.org',
    visibility: 'entitled',
    authentication: { type: 'cloudflare_oidc', reference: 'access-catalog' },
    provisioningMode: 'observe',
    status: 'active',
    entitlements: [
      {
        key: 'reader',
        name: 'Reader',
        requiresProvisioning: false,
        status: 'active',
      },
    ],
  };
}
