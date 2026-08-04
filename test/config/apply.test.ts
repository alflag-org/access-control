import { describe, expect, it } from 'vitest';
import {
  createDirectorySourceCandidate,
  createEntitlementMappingCandidate,
  createProviderConnectionCandidate,
  createProvisioningTargetCandidate,
  type JsonObject,
} from '@access-control/domain';
import {
  applyRuntimeConfiguration,
  createConfigurationPlan,
  runtimeConfigurationManifestSchema,
  type ConfigurationApi,
  type RuntimeConfigurationManifest,
  type RuntimeConfigurationSnapshot,
} from '@access-control/config';
import {
  emptyConfigurationManifest as emptyManifest,
  emptyConfigurationSnapshot as emptySnapshot,
} from '../fixtures/config-fixtures';
import { application, entitlement, sourceGroup } from '../fixtures/domain-fixtures';

const time = '2026-01-01T00:00:00.000Z';

describe('Declarative runtime configuration apply', () => {
  it('applies each change once, verifies it, and converges', async () => {
    const manifest = withSources('directory:one');
    const client = new DirectoryConfigurationApi(emptySnapshot());
    const plan = await planFor(manifest, client.snapshot);

    const finalPlan = await applyRuntimeConfiguration({
      environment: 'staging',
      manifest,
      client,
      planHash: plan.planHash,
      now: () => time,
    });

    expect(client.createdIds).toEqual(['directory:one']);
    expect(finalPlan.changes).toEqual([]);
    expect(finalPlan.blockedChanges).toEqual([]);
  });

  it('is idempotent when applied again with the current no-op plan', async () => {
    const manifest = withSources('directory:one');
    const client = new DirectoryConfigurationApi(emptySnapshot());
    const firstPlan = await planFor(manifest, client.snapshot);
    await applyRuntimeConfiguration({
      environment: 'staging',
      manifest,
      client,
      planHash: firstPlan.planHash,
      now: () => time,
    });

    const secondPlan = await planFor(manifest, client.snapshot);
    expect(secondPlan.changes).toEqual([]);
    await applyRuntimeConfiguration({
      environment: 'staging',
      manifest,
      client,
      planHash: secondPlan.planHash,
      now: () => time,
    });

    expect(client.createdIds).toEqual(['directory:one']);
  });

  it('rejects a stale plan hash before changing state', async () => {
    const manifest = withSources('directory:one');
    const client = new DirectoryConfigurationApi(emptySnapshot());

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest,
        client,
        planHash: `sha256:${'0'.repeat(64)}`,
        now: () => time,
      }),
    ).rejects.toMatchObject({ code: 'plan_hash_mismatch' });
    expect(client.createdIds).toEqual([]);
  });

  it('never applies protected changes', async () => {
    const manifest = withSources('directory:one');
    manifest.directorySources[0]!.customerId = 'new-customer';
    const snapshot = emptySnapshot();
    snapshot.directorySources = [directoryRecord('directory:one', 'old-customer')];
    const client = new DirectoryConfigurationApi(snapshot);
    const plan = await planFor(manifest, snapshot);

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest,
        client,
        planHash: plan.planHash,
        now: () => time,
      }),
    ).rejects.toMatchObject({ code: 'blocked_changes_present' });
    expect(client.createdIds).toEqual([]);
  });

  it('does not duplicate completed changes after a partial failure', async () => {
    const manifest = withSources('directory:a', 'directory:b');
    const client = new DirectoryConfigurationApi(emptySnapshot(), 'directory:b');
    const firstPlan = await planFor(manifest, client.snapshot);

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest,
        client,
        planHash: firstPlan.planHash,
        now: () => time,
      }),
    ).rejects.toThrow('simulated apply failure');
    expect(client.createdIds).toEqual(['directory:a']);

    const retryPlan = await planFor(manifest, client.snapshot);
    await applyRuntimeConfiguration({
      environment: 'staging',
      manifest,
      client,
      planHash: retryPlan.planHash,
      now: () => time,
    });
    expect(client.createdIds).toEqual(['directory:a', 'directory:b']);
  });

  it('disables dependent targets before their Provider Connection', async () => {
    const manifest = emptyManifest();
    manifest.applications = [
      {
        key: 'source-control',
        name: 'Source Control',
        description: 'Fictional source control service.',
        category: 'Engineering',
        launchUrl: 'https://source.example.org',
        visibility: 'entitled',
        authentication: { type: 'cloudflare_oidc', reference: 'example-reference' },
        provisioningMode: 'plan',
        status: 'active',
        entitlements: [
          {
            key: 'member',
            name: 'Member',
            requiresProvisioning: true,
            status: 'active',
          },
        ],
      },
    ];
    manifest.providerConnections = [
      {
        id: 'provider:github',
        provider: 'github',
        name: 'GitHub',
        mode: 'observe',
        configuration: { organization: 'example-organization', teamSlugs: ['readers'] },
        status: 'disabled',
      },
    ];
    manifest.provisioningTargets = [
      {
        id: 'target:github-readers',
        providerConnectionId: 'provider:github',
        applicationKey: 'source-control',
        entitlementKey: 'member',
        targetType: 'github_team_membership',
        providerTargetId: 'readers',
        mode: 'observe',
        protected: false,
        configuration: {},
        status: 'disabled',
      },
    ];
    const parsedManifest = runtimeConfigurationManifestSchema.parse(manifest);
    const snapshot = emptySnapshot();
    snapshot.applications = [application()];
    snapshot.entitlements = [entitlement()];
    snapshot.providerConnections = [
      createProviderConnectionCandidate({
        id: 'provider:github',
        provider: 'github',
        name: 'GitHub',
        mode: 'observe',
        configuration: { organization: 'example-organization', teamSlugs: ['readers'] },
        status: 'active',
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];
    snapshot.provisioningTargets = [
      createProvisioningTargetCandidate({
        id: 'target:github-readers',
        providerConnectionId: 'provider:github',
        applicationEntitlementId: 'entitlement:source-control-member',
        targetType: 'github_team_membership',
        providerTargetId: 'readers',
        mode: 'observe',
        protected: false,
        configuration: {},
        status: 'active',
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];
    const appliedPaths: string[] = [];
    const client: ConfigurationApi = {
      loadSnapshot: async () => structuredClone(snapshot),
      create: async () => {
        throw new Error('unexpected create');
      },
      update: async (path) => {
        appliedPaths.push(path);
        if (path.includes('/provisioning-targets/')) {
          snapshot.provisioningTargets = [
            { ...snapshot.provisioningTargets[0]!, status: 'disabled', revision: 2 },
          ];
          return {};
        }
        expect(snapshot.provisioningTargets[0]?.status).toBe('disabled');
        snapshot.providerConnections = [
          { ...snapshot.providerConnections[0]!, status: 'disabled', revision: 2 },
        ];
        return {};
      },
      invoke: async () => {
        throw new Error('unexpected invoke');
      },
    };
    const plan = await planFor(parsedManifest, snapshot);

    await applyRuntimeConfiguration({
      environment: 'staging',
      manifest: parsedManifest,
      client,
      planHash: plan.planHash,
      now: () => time,
    });
    expect(appliedPaths).toEqual([
      '/api/v1/provisioning-targets/target%3Agithub-readers',
      '/api/v1/provider-connections/provider%3Agithub',
    ]);
  });

  it('propagates revision conflicts without retrying a stale update', async () => {
    const manifest = withSources('directory:one');
    manifest.directorySources[0]!.delegatedAdmin = 'replacement@example.org';
    const snapshot = emptySnapshot();
    snapshot.directorySources = [directoryRecord('directory:one', 'customer')];
    let updates = 0;
    const client: ConfigurationApi = {
      loadSnapshot: async () => structuredClone(snapshot),
      create: async () => {
        throw new Error('unexpected create');
      },
      update: async () => {
        updates += 1;
        throw new Error('Access Control API request failed with HTTP 409 (revision_conflict).');
      },
      invoke: async () => {
        throw new Error('unexpected invoke');
      },
    };
    const plan = await planFor(manifest, snapshot);

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest,
        client,
        planHash: plan.planHash,
        now: () => time,
      }),
    ).rejects.toThrow('HTTP 409 (revision_conflict)');
    expect(updates).toBe(1);
  });

  it('fails when a successful API response does not change the reloaded state', async () => {
    const manifest = withSources('directory:one');
    const snapshot = emptySnapshot();
    const client: ConfigurationApi = {
      loadSnapshot: async () => structuredClone(snapshot),
      create: async () => ({ data: directoryRecord('directory:one', 'customer') }),
      update: async () => {
        throw new Error('unexpected update');
      },
      invoke: async () => {
        throw new Error('unexpected invoke');
      },
    };
    const plan = await planFor(manifest, snapshot);

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest,
        client,
        planHash: plan.planHash,
        now: () => time,
      }),
    ).rejects.toMatchObject({ code: 'change_verification_failed' });
  });

  it('stops when the mapping preview differs from the planned Subject set or counts', async () => {
    const manifest = emptyManifest();
    manifest.applications = [
      {
        key: 'source-control',
        name: 'Source Control',
        description: 'Fictional source control service.',
        category: 'Engineering',
        launchUrl: 'https://source.example.org',
        visibility: 'entitled',
        authentication: { type: 'cloudflare_oidc', reference: 'example-reference' },
        provisioningMode: 'plan',
        status: 'active',
        entitlements: [
          {
            key: 'member',
            name: 'Member',
            requiresProvisioning: true,
            status: 'active',
          },
        ],
      },
    ];
    manifest.mappings = [
      {
        id: 'mapping:preview',
        sourceGroup: {
          providerGroupId: 'google-group-1',
          expectedEmail: 'access.github.member@example.org',
        },
        entitlements: [{ applicationKey: 'source-control', entitlementKey: 'member' }],
        provisioningTargetIds: [],
        status: 'active',
      },
    ];
    const snapshot = emptySnapshot();
    snapshot.applications = [application()];
    snapshot.entitlements = [entitlement()];
    snapshot.sourceGroups = [sourceGroup()];
    snapshot.mappings = [
      createEntitlementMappingCandidate({
        id: 'mapping:preview',
        sourceGroupId: 'group:source-control',
        entitlementIds: ['entitlement:source-control-member'],
        provisioningTargetIds: [],
        status: 'draft',
        revision: 1,
        createdAt: time,
        updatedAt: time,
        createdBy: 'subject:admin',
        updatedBy: 'subject:admin',
      }),
    ];
    const parsedManifest = runtimeConfigurationManifestSchema.parse(manifest);
    const plan = await planFor(parsedManifest, snapshot);
    expect(plan.changes.map((change) => change.action)).toEqual([
      'mapping.activate',
      'mapping.preview',
    ]);
    const client: ConfigurationApi = {
      loadSnapshot: async () => structuredClone(snapshot),
      create: async () => {
        throw new Error('unexpected create');
      },
      update: async () => {
        throw new Error('unexpected update');
      },
      invoke: async (path) => {
        expect(path).toContain('/preview');
        return {
          data: {
            mappingId: 'mapping:preview',
            expectedRevision: 1,
            affectedSubjectIds: ['subject:unexpected'],
            grantCountBefore: 0,
            grantCountAfter: 1,
            calculatedAt: time,
          },
        };
      },
    };

    await expect(
      applyRuntimeConfiguration({
        environment: 'staging',
        manifest: parsedManifest,
        client,
        planHash: plan.planHash,
        now: () => time,
      }),
    ).rejects.toMatchObject({ code: 'mapping_preview_changed' });
  });
});

class DirectoryConfigurationApi implements ConfigurationApi {
  public readonly createdIds: string[] = [];
  public constructor(
    public snapshot: RuntimeConfigurationSnapshot,
    private failOnceForId?: string,
  ) {}

  public async loadSnapshot(): Promise<RuntimeConfigurationSnapshot> {
    return structuredClone(this.snapshot);
  }

  public async create(path: string, body: JsonObject): Promise<unknown> {
    expect(path).toBe('/api/v1/directory-sources');
    const id = String(body.id);
    if (this.failOnceForId === id) {
      this.failOnceForId = undefined;
      throw new Error('simulated apply failure');
    }
    this.createdIds.push(id);
    this.snapshot.directorySources.push(directoryRecord(id, String(body.customerId)));
    return { data: this.snapshot.directorySources.at(-1) };
  }

  public async update(): Promise<unknown> {
    throw new Error('unexpected update');
  }

  public async invoke(): Promise<unknown> {
    throw new Error('unexpected invoke');
  }
}

function withSources(...ids: string[]): RuntimeConfigurationManifest {
  const manifest = emptyManifest();
  manifest.directorySources = ids.map((id) => ({
    id,
    provider: 'google',
    customerId: 'customer',
    delegatedAdmin: 'admin@example.org',
    credentialRef: 'GOOGLE_CREDENTIAL',
    accessGroupPrefix: 'access.',
    status: 'active',
  }));
  return runtimeConfigurationManifestSchema.parse(manifest);
}

function directoryRecord(id: string, customerId: string) {
  return createDirectorySourceCandidate({
    id,
    provider: 'google',
    customerId,
    delegatedAdmin: 'admin@example.org',
    credentialRef: 'GOOGLE_CREDENTIAL',
    accessGroupPrefix: 'access.',
    status: 'active',
    revision: 1,
    createdAt: time,
    updatedAt: time,
    createdBy: 'subject:admin',
    updatedBy: 'subject:admin',
  });
}

async function planFor(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
) {
  return createConfigurationPlan({
    environment: 'staging',
    manifest,
    snapshot: structuredClone(snapshot),
    generatedAt: time,
  });
}
