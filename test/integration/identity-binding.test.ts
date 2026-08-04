import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DirectorySyncService, IdentityService } from '@access-control/application';
import type { DirectoryAdapter, DirectorySnapshot } from '@access-control/contracts';
import { createD1Repositories } from '@access-control/d1';
import { FIXTURE_TIME, fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator, insertDirectorySource } from '../fixtures/persistence-fixtures';

const localHeaders = {
  'content-type': 'application/json',
  'x-access-control-dev-identity': 'access:local-admin',
  'x-access-control-reason': 'immutable_identity_confirmation',
};
const googleIssuer = 'urn:google-directory:customer:example-customer';
const googleUserId = 'google-user-guest-001';

describe('Managed Guest immutable identity binding', () => {
  it('binds confirmed provider IDs and lets directory sync reuse the existing Subject', async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    const repositories = createD1Repositories(env.DB);
    const identityService = new IdentityService(
      repositories.identities,
      fixtureRuntime(FIXTURE_TIME, 'identity-binding-guest'),
    );
    const guest = await identityService.createManagedGuest(
      {
        displayName: 'Managed Guest',
        primaryEmail: 'guest@example.org',
        sponsorSubjectId: bootstrap.subject.id,
        externalContactEmail: 'guest.external@example.net',
        externalOrganization: 'Example Partner',
        purpose: 'Time-bounded repository review',
        validFrom: FIXTURE_TIME,
        expiresAt: '2026-02-01T00:00:00.000Z',
      },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:create-binding-guest' },
    );

    const emailBinding = await bindIdentity(guest.subject.id, {
      provider: 'google',
      issuer: googleIssuer,
      providerSubject: 'guest@example.org',
      expectedSubjectRevision: 1,
      confirmed: true,
    });
    expect(emailBinding.status).toBe(400);

    const unconfirmedBinding = await bindIdentity(guest.subject.id, {
      provider: 'google',
      issuer: googleIssuer,
      providerSubject: googleUserId,
      expectedSubjectRevision: 1,
      confirmed: false,
    });
    expect(unconfirmedBinding.status).toBe(400);

    const googleBinding = await bindIdentity(guest.subject.id, {
      provider: 'google',
      issuer: googleIssuer,
      providerSubject: googleUserId,
      expectedSubjectRevision: 1,
      confirmed: true,
    });
    expect(googleBinding.status).toBe(200);
    await expect(googleBinding.json()).resolves.toMatchObject({
      data: {
        subject: { id: guest.subject.id, classification: 'managed_guest', revision: 2 },
        identity: {
          subjectId: guest.subject.id,
          provider: 'google',
          issuer: googleIssuer,
          providerSubject: googleUserId,
          status: 'active',
          revision: 1,
        },
      },
    });

    const duplicateGoogleBinding = await bindIdentity(guest.subject.id, {
      provider: 'google',
      issuer: googleIssuer,
      providerSubject: googleUserId,
      expectedSubjectRevision: 2,
      confirmed: true,
    });
    expect(duplicateGoogleBinding.status).toBe(409);
    await expect(duplicateGoogleBinding.json()).resolves.toMatchObject({
      error: { code: 'identity_binding_conflict' },
    });

    await insertDirectorySource(env.DB, bootstrap.subject.id);
    const snapshot: DirectorySnapshot = {
      directorySourceId: 'directory:google',
      observedAt: '2026-01-02T00:00:00.000Z',
      snapshotVersion: `sha256:${'7'.repeat(64)}`,
      users: [
        {
          immutableId: googleUserId,
          primaryEmail: 'guest@example.org',
          aliases: [],
          displayName: 'Managed Guest',
          suspended: false,
          lifecycle: 'active',
        },
      ],
      groups: [],
      memberships: [],
    };
    const adapter: DirectoryAdapter = { observeDirectory: async () => snapshot };
    const sync = new DirectorySyncService(
      repositories,
      adapter,
      fixtureRuntime(snapshot.observedAt, 'identity-binding-sync'),
    );
    await sync.synchronize('directory:google', {
      actorSubjectId: bootstrap.subject.id,
      requestId: 'request:identity-binding-sync',
    });

    const subjects = await repositories.identities.listSubjects();
    expect(subjects).toHaveLength(2);
    const syncedGuest = await repositories.identities.getSubject(guest.subject.id);
    expect(syncedGuest).toMatchObject({
      classification: 'managed_guest',
      directoryState: 'active',
      revision: 3,
    });
    expect(
      await repositories.identities.findExternalIdentity('google', googleIssuer, googleUserId),
    ).toMatchObject({ subjectId: guest.subject.id });

    const loginBinding = await bindIdentity(guest.subject.id, {
      provider: 'github',
      issuer: 'https://github.com',
      providerSubject: 'octocat',
      expectedSubjectRevision: 3,
      confirmed: true,
    });
    expect(loginBinding.status).toBe(400);

    const githubBinding = await bindIdentity(guest.subject.id, {
      provider: 'github',
      issuer: 'https://github.com',
      providerSubject: '1001',
      expectedSubjectRevision: 3,
      confirmed: true,
    });
    expect(githubBinding.status).toBe(200);
    const githubBindingPayload = (await githubBinding.json()) as {
      data: { identity: Record<string, unknown> };
    };
    expect(githubBindingPayload).toMatchObject({
      data: {
        subject: { id: guest.subject.id, revision: 4 },
        identity: {
          provider: 'github',
          issuer: 'https://github.com',
          providerSubject: '1001',
        },
      },
    });
    expect(githubBindingPayload.data.identity).not.toHaveProperty('email');

    const secondGithubBinding = await bindIdentity(guest.subject.id, {
      provider: 'github',
      issuer: 'https://github.com',
      providerSubject: '1002',
      expectedSubjectRevision: 4,
      confirmed: true,
    });
    expect(secondGithubBinding.status).toBe(409);
    await expect(secondGithubBinding.json()).resolves.toMatchObject({
      error: { code: 'identity_provider_already_bound' },
    });

    const memberBinding = await bindIdentity(bootstrap.subject.id, {
      provider: 'github',
      issuer: 'https://github.com',
      providerSubject: '2001',
      expectedSubjectRevision: 1,
      confirmed: true,
    });
    expect(memberBinding.status).toBe(422);
    await expect(memberBinding.json()).resolves.toMatchObject({
      error: { code: 'managed_guest_required' },
    });

    expect(
      (await repositories.audit.listAuditEvents()).filter(
        (event) => event.eventType === 'access-control.identity.bound',
      ),
    ).toHaveLength(2);
    const identityOutbox = await env.DB.prepare(
      `SELECT status FROM outbox
       WHERE topic = 'access-control.identity.bound'
       ORDER BY id`,
    ).all<{ status: string }>();
    expect(identityOutbox.results).toHaveLength(2);
    expect(
      identityOutbox.results.every((record) =>
        ['dispatching', 'delivered'].includes(record.status),
      ),
    ).toBe(true);
  });
});

async function bindIdentity(subjectId: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`http://localhost/api/v1/subjects/${subjectId}/identities`, {
    method: 'POST',
    headers: localHeaders,
    body: JSON.stringify(body),
  });
}
