import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogService,
  GuestExpirationService,
  IdentityService,
  createMutationRecords,
  type BootstrapResult,
} from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import { createPlatformRoleGrantCandidate, createSubjectCandidate } from '@access-control/domain';
import { FIXTURE_TIME, fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

let bootstrap: BootstrapResult;

beforeAll(async () => {
  bootstrap = await bootstrapAdministrator(env.DB);
});

describe('D1 mutation and administrator safety', () => {
  it('bootstraps state, audit, and outbox atomically and refuses repetition', async () => {
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM subjects) AS subjects,
        (SELECT count(*) FROM external_identities) AS identities,
        (SELECT count(*) FROM platform_role_grants) AS grants,
        (SELECT count(*) FROM audit_events) AS audits,
        (SELECT count(*) FROM outbox) AS outbox`,
    ).first<Record<string, number>>();
    expect(counts).toEqual({ subjects: 1, identities: 1, grants: 1, audits: 1, outbox: 1 });
    expect(bootstrap.platformRoleGrant.role).toBe('admin');
    await expect(bootstrapAdministrator(env.DB)).rejects.toMatchObject({
      code: 'administrator_already_bootstrapped',
    });
  });

  it('allows only one of two concurrent final-admin demotions', async () => {
    const repositories = createD1Repositories(env.DB);
    const secondSubject = createSubjectCandidate({
      ...bootstrap.subject,
      id: 'subject:second-admin',
      displayName: 'Second Administrator',
      protected: false,
      createdBy: bootstrap.subject.id,
      updatedBy: bootstrap.subject.id,
    });
    const secondGrant = createPlatformRoleGrantCandidate({
      ...bootstrap.platformRoleGrant,
      id: 'role-grant:second-admin',
      subjectId: secondSubject.id,
      protected: false,
      createdBy: bootstrap.subject.id,
      updatedBy: bootstrap.subject.id,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO subjects (
            id, kind, classification, display_name, primary_email, status, directory_state,
            protected, revision, created_at, updated_at, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        secondSubject.id,
        secondSubject.kind,
        secondSubject.classification,
        secondSubject.displayName,
        null,
        secondSubject.status,
        secondSubject.directoryState,
        0,
        1,
        secondSubject.createdAt,
        secondSubject.updatedAt,
        secondSubject.createdBy,
        secondSubject.updatedBy,
      ),
      env.DB.prepare(
        `INSERT INTO platform_role_grants (
            id, subject_id, role, active, protected, revision,
            created_at, updated_at, created_by, updated_by
          ) VALUES (?, ?, 'admin', 1, 0, 1, ?, ?, ?, ?)`,
      ).bind(
        secondGrant.id,
        secondGrant.subjectId,
        secondGrant.createdAt,
        secondGrant.updatedAt,
        secondGrant.createdBy,
        secondGrant.updatedBy,
      ),
    ]);
    const service = new IdentityService(repositories.identities, fixtureRuntime());
    const results = await Promise.allSettled([
      service.deactivateAdministrationRole(
        bootstrap.platformRoleGrant.id,
        { expectedRevision: 1, confirmed: true },
        { actorSubjectId: secondSubject.id, requestId: 'request:demote-one' },
      ),
      service.deactivateAdministrationRole(
        secondGrant.id,
        { expectedRevision: 1, confirmed: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:demote-two' },
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = await env.DB.prepare(
      `SELECT count(*) AS count FROM platform_role_grants grants
       JOIN subjects ON subjects.id = grants.subject_id
       WHERE grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'`,
    ).first<{ count: number }>();
    expect(active?.count).toBe(1);
  });

  it('does not append audit or outbox when revision validation fails', async () => {
    const repositories = createD1Repositories(env.DB);
    const service = new CatalogService(
      repositories.catalog,
      repositories.identities,
      fixtureRuntime(),
      repositories.provisioning,
    );
    const context = {
      actorSubjectId: bootstrap.subject.id,
      requestId: 'request:application',
    };
    const application = await service.createApplication(
      {
        key: 'documentation',
        name: 'Documentation',
        category: 'Knowledge',
        launchUrl: 'https://docs.example.org',
        status: 'active',
        visibility: 'all_active_subjects',
        authentication: { type: 'direct_google' },
        provisioningMode: 'none',
      },
      context,
    );
    const before = await countAuditAndOutbox();
    await expect(
      service.updateApplication(
        application.id,
        {
          expectedRevision: 99,
          name: application.name,
          category: application.category,
          launchUrl: application.launchUrl,
          status: application.status,
          visibility: application.visibility,
          authentication: application.authentication,
          provisioningMode: application.provisioningMode,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await countAuditAndOutbox()).toEqual(before);
  });

  it('claims one dispatch and records duplicate Queue delivery by Outbox ID once', async () => {
    const repositories = createD1Repositories(env.DB);
    const outbox = (await repositories.audit.listPendingOutboxRecords(10))[0];
    expect(outbox).toBeDefined();
    if (outbox === undefined) throw new Error('Bootstrap outbox record is missing.');
    const dispatchClaims = await Promise.all([
      repositories.audit.claimOutboxRecord(outbox.id, FIXTURE_TIME),
      repositories.audit.claimOutboxRecord(outbox.id, FIXTURE_TIME),
    ]);
    expect(dispatchClaims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(dispatchClaims.find((claim) => claim !== null)).toMatchObject({
      status: 'dispatching',
      attempts: 1,
    });
    await repositories.audit.markOutboxDispatched(outbox.id, FIXTURE_TIME);
    expect(
      await repositories.audit.claimOutboxDelivery(
        outbox.id,
        'message:1',
        FIXTURE_TIME,
        '2026-01-01T00:05:00.000Z',
      ),
    ).toBe('claimed');
    expect(
      await repositories.audit.claimOutboxDelivery(
        outbox.id,
        'message:2',
        FIXTURE_TIME,
        '2026-01-01T00:05:00.000Z',
      ),
    ).toBe('processing');
    await repositories.audit.completeOutboxDelivery(outbox.id, 'message:1', FIXTURE_TIME);
    expect(
      await repositories.audit.claimOutboxDelivery(
        outbox.id,
        'message:2',
        FIXTURE_TIME,
        '2026-01-01T00:05:00.000Z',
      ),
    ).toBe('delivered');
    const row = await env.DB.prepare(
      `SELECT status, attempts,
        (SELECT count(*) FROM outbox_delivery_receipts WHERE outbox_id = ?) AS receipts
       FROM outbox WHERE id = ?`,
    )
      .bind(outbox.id, outbox.id)
      .first<{ status: string; attempts: number; receipts: number }>();
    expect(row).toEqual({ status: 'delivered', attempts: 1, receipts: 1 });
    expect(bootstrap.subject.status).toBe('active');
  });

  it('rolls back a state mutation when its audit record cannot be inserted', async () => {
    const repositories = createD1Repositories(env.DB);
    const current = bootstrap.subject;
    const updated = createSubjectCandidate({
      ...current,
      displayName: 'Changed Name',
      revision: 2,
      updatedAt: FIXTURE_TIME,
    });
    const runtime = fixtureRuntime();
    const generatedMutation = createMutationRecords(
      runtime,
      { actorSubjectId: current.id, requestId: 'request:duplicate-audit' },
      {
        eventType: 'access-control.subject.updated',
        topic: 'access-control.subject.updated',
        targetType: 'subject',
        targetId: current.id,
        action: 'update',
        payload: {},
      },
    );
    const existingAudit = await env.DB.prepare(
      'SELECT id FROM audit_events ORDER BY id LIMIT 1',
    ).first<{ id: string }>();
    if (existingAudit === null) throw new Error('Expected an existing audit event.');
    const mutation = {
      auditEvent: { ...generatedMutation.auditEvent, id: existingAudit.id },
      outboxRecord: {
        ...generatedMutation.outboxRecord,
        auditEventId: existingAudit.id,
      },
    };
    await expect(repositories.identities.updateSubject(updated, mutation, 1)).rejects.toBeDefined();
    expect((await repositories.identities.getSubject(current.id))?.revision).toBe(1);
  });

  it('expires managed Guest access through one audited persistence operation', async () => {
    const repositories = createD1Repositories(env.DB);
    const identityService = new IdentityService(
      repositories.identities,
      fixtureRuntime(FIXTURE_TIME, 'guest-create'),
    );
    const guest = await identityService.createManagedGuest(
      {
        displayName: 'Guest Example',
        sponsorSubjectId: bootstrap.subject.id,
        externalContactEmail: 'guest@example.net',
        externalOrganization: 'Example Partner',
        purpose: 'Time-bounded review',
        validFrom: '2025-12-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:create-guest' },
    );
    const processed = await new GuestExpirationService(
      repositories.identities,
      fixtureRuntime('2026-01-03T00:00:00.000Z', 'guest-expire'),
    ).processExpiredGuests({
      requestId: 'scheduled:guest-expiration',
      reason: 'managed_guest_expiration',
    });
    expect(processed).toBe(1);
    expect((await repositories.identities.getGuestProfile(guest.subject.id))?.status).toBe(
      'expired',
    );
    expect(
      (await repositories.audit.listAuditEvents()).some(
        (event) => event.eventType === 'access-control.guest.expired',
      ),
    ).toBe(true);
  });
});

async function countAuditAndOutbox() {
  return env.DB.prepare(
    `SELECT
      (SELECT count(*) FROM audit_events) AS audits,
      (SELECT count(*) FROM outbox) AS outbox`,
  ).first<{ audits: number; outbox: number }>();
}
