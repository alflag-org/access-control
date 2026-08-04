import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogService,
  DirectorySyncService,
  type BootstrapResult,
  type AccessControlRepositories,
} from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import type { DirectoryAdapter, DirectorySnapshot } from '@access-control/contracts';
import { fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator, insertDirectorySource } from '../fixtures/persistence-fixtures';

const observedAt = '2026-01-02T00:00:00.000Z';
const snapshot: DirectorySnapshot = {
  directorySourceId: 'directory:google',
  observedAt,
  snapshotVersion: `sha256:${'1'.repeat(64)}`,
  users: [
    {
      immutableId: 'google-user-1',
      primaryEmail: 'ada@example.org',
      aliases: ['ada.alias@example.org'],
      displayName: 'Ada Example',
      suspended: false,
      lifecycle: 'active',
    },
  ],
  groups: [
    {
      immutableId: 'google-group-1',
      email: 'access.github.member@example.org',
      aliases: [],
      name: 'Source Control Members',
      lifecycle: 'active',
    },
  ],
  memberships: [
    {
      immutableId: 'google-membership-user',
      groupImmutableId: 'google-group-1',
      memberImmutableId: 'google-user-1',
      memberEmail: 'ada@example.org',
      memberType: 'user',
      role: 'MEMBER',
    },
    {
      immutableId: 'google-membership-nested',
      groupImmutableId: 'google-group-1',
      memberImmutableId: 'nested-group-1',
      memberEmail: 'nested@example.org',
      memberType: 'group',
      role: 'MEMBER',
    },
  ],
};
const integrationRuntime = fixtureRuntime(observedAt);
let bootstrap: BootstrapResult;
let repositories: AccessControlRepositories;
let currentSnapshot = snapshot;
let dependencyFailure = false;
let sync: DirectorySyncService;

beforeAll(async () => {
  bootstrap = await bootstrapAdministrator(env.DB);
  await insertDirectorySource(env.DB, bootstrap.subject.id);
  repositories = createD1Repositories(env.DB);
  const adapter: DirectoryAdapter = {
    observeDirectory: async () => {
      if (dependencyFailure) throw new Error('page two unavailable');
      return currentSnapshot;
    },
  };
  sync = new DirectorySyncService(repositories, adapter, integrationRuntime);
});

describe('Directory snapshot publication and mapping activation', () => {
  it('publishes complete snapshots, records nested groups, and activates a previewed mapping', async () => {
    const context = {
      actorSubjectId: bootstrap.subject.id,
      requestId: 'request:sync',
    };
    const first = await sync.synchronize('directory:google', context);
    expect(first.status).toBe('completed');
    expect(first.violationCount).toBe(1);
    expect((await repositories.directory.listDirectorySyncViolations(first.id))[0]?.code).toBe(
      'nested_access_group',
    );

    const identity = await repositories.identities.findExternalIdentity(
      'google',
      'urn:google-directory:customer:example-customer',
      'google-user-1',
    );
    expect(identity).not.toBeNull();
    const catalog = new CatalogService(
      repositories.catalog,
      repositories.identities,
      integrationRuntime,
      repositories.provisioning,
    );
    const application = await catalog.createApplication(
      {
        key: 'source-control',
        name: 'Source Control',
        category: 'Engineering',
        launchUrl: 'https://source.example.org',
        status: 'active',
        visibility: 'entitled',
        authentication: { type: 'cloudflare_oidc', reference: 'example-reference' },
        provisioningMode: 'plan',
      },
      context,
    );
    const entitlement = await catalog.createEntitlement(
      {
        applicationId: application.id,
        key: 'member',
        name: 'Member',
        requiresProvisioning: true,
      },
      context,
    );
    const group = (await repositories.catalog.listSourceGroups())[0];
    if (group === undefined || identity === null)
      throw new Error('Published entities are missing.');
    const mapping = await catalog.createMapping(
      { sourceGroupId: group.id, entitlementIds: [entitlement.id] },
      context,
    );
    const preview = await catalog.previewMapping(mapping.id, 1);
    expect(preview.affectedSubjectIds).toEqual([identity.subjectId]);
    const racingCatalogRepository = new Proxy(repositories.catalog, {
      get(target, property) {
        if (property === 'activateEntitlementMapping') {
          return async (...arguments_: Parameters<typeof target.activateEntitlementMapping>) => {
            await env.DB.prepare(
              `UPDATE grant_input_versions
               SET revision = revision + 1 WHERE name = 'effective_grants'`,
            ).run();
            return target.activateEntitlementMapping(...arguments_);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const racingCatalog = new CatalogService(
      racingCatalogRepository,
      repositories.identities,
      integrationRuntime,
      repositories.provisioning,
    );
    await expect(
      racingCatalog.activateMapping(
        mapping.id,
        { expectedRevision: 1, confirmedAffectedSubjectIds: preview.affectedSubjectIds },
        context,
      ),
    ).rejects.toMatchObject({ code: 'persistence_conflict' });
    expect(await repositories.catalog.listEffectiveGrants(identity.subjectId)).toEqual([]);
    await catalog.activateMapping(
      mapping.id,
      { expectedRevision: 1, confirmedAffectedSubjectIds: preview.affectedSubjectIds },
      context,
    );
    const grants = await repositories.catalog.listEffectiveGrants(identity.subjectId);
    expect(grants).toEqual([
      expect.objectContaining({
        sourceGroupMembershipId: expect.any(String),
        mappingId: mapping.id,
        entitlementId: entitlement.id,
        status: 'active',
      }),
    ]);

    const second = await sync.synchronize('directory:google', {
      ...context,
      requestId: 'request:sync-again',
    });
    expect(second.status).toBe('completed');
    expect(await repositories.catalog.listSourceGroupMemberships(group.id)).toHaveLength(2);
    expect(await repositories.identities.listExternalIdentities()).toHaveLength(2);
  });

  it('marks a missing user and expires active grants without hard-deleting provenance', async () => {
    const context = {
      actorSubjectId: bootstrap.subject.id,
      requestId: 'request:missing-sync',
    };
    const identity = await repositories.identities.findExternalIdentity(
      'google',
      'urn:google-directory:customer:example-customer',
      'google-user-1',
    );
    if (identity === null) throw new Error('Google identity was not published.');
    currentSnapshot = {
      ...snapshot,
      observedAt: '2026-01-03T00:00:00.000Z',
      snapshotVersion: `sha256:${'2'.repeat(64)}`,
      users: [],
      memberships: [],
    };
    await sync.synchronize('directory:google', context);
    expect((await repositories.identities.getSubject(identity.subjectId))?.directoryState).toBe(
      'missing',
    );
    expect(
      (await repositories.identities.listExternalIdentities(identity.subjectId))[0]?.status,
    ).toBe('missing');
  });

  it('marks a failed run and never publishes a partial authoritative snapshot', async () => {
    const groupCount = (await repositories.catalog.listSourceGroups()).length;
    dependencyFailure = true;
    await expect(
      sync.synchronize('directory:google', {
        actorSubjectId: bootstrap.subject.id,
        requestId: 'request:failed-sync',
      }),
    ).rejects.toMatchObject({ code: 'directory_sync_failed' });
    expect(
      (await repositories.directory.listDirectorySyncRuns()).some((run) => run.status === 'failed'),
    ).toBe(true);
    expect(await repositories.catalog.listSourceGroups()).toHaveLength(groupCount);
  });
});
