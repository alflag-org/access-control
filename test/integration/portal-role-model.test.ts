import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Repositories } from '@access-control/d1';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const administratorHeaders = {
  'content-type': 'application/json',
  'x-access-control-dev-identity': 'access:local-admin',
  'x-access-control-reason': 'administration_role_test',
};
const timestamp = '2026-01-01T00:00:00.000Z';

describe('Portal Subject access and administration roles', () => {
  let administratorSubjectId: string;

  beforeAll(async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    administratorSubjectId = bootstrap.subject.id;
    await insertRolelessSubject('portal-user', 'Portal User', administratorSubjectId);
    await insertRolelessSubject('second-admin', 'Second Administrator', administratorSubjectId);
  });

  it('allows an active Subject to use every self-service API without a Platform Role', async () => {
    const headers = { 'x-access-control-dev-identity': 'access:portal-user' };
    for (const path of [
      '/api/v1/me',
      '/api/v1/me/applications',
      '/api/v1/me/entitlements',
      '/api/v1/me/provider-accounts',
    ]) {
      const response = await SELF.fetch(`http://localhost${path}`, { headers });
      expect(response.status, path).toBe(200);
    }

    const account = await SELF.fetch('http://localhost/api/v1/me', { headers });
    await expect(account.json()).resolves.toMatchObject({
      data: {
        subject: { id: 'subject:portal-user', status: 'active' },
        roles: [],
      },
    });
    const administration = await SELF.fetch('http://localhost/api/v1/subjects', {
      headers,
    });
    expect(administration.status).toBe(403);
    await expect(administration.json()).resolves.toMatchObject({
      error: { code: 'role_forbidden' },
    });
  });

  it('creates, lists, deactivates, and reactivates administration roles', async () => {
    const subjectId = 'subject:second-admin';
    const invalidRole = await grantRole(subjectId, 'user');
    expect(invalidRole.status).toBe(400);

    const created = await grantRole(subjectId, 'admin');
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      data: { id: string; active: boolean; revision: number };
    };
    expect(createdBody.data).toMatchObject({ active: true, revision: 1 });

    const listed = await SELF.fetch(
      `http://localhost/api/v1/subjects/${subjectId}/platform-role-grants`,
      { headers: administratorHeaders },
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      data: [{ id: createdBody.data.id, subjectId, role: 'admin', active: true }],
    });

    const deactivated = await deactivateRole(createdBody.data.id, 1);
    expect(deactivated.status).toBe(200);
    await expect(deactivated.json()).resolves.toMatchObject({
      data: { id: createdBody.data.id, active: false, revision: 2 },
    });

    const repositories = createD1Repositories(env.DB);
    const initialAdministratorGrant = (
      await repositories.identities.listPlatformRoleGrants(administratorSubjectId)
    ).find((grant) => grant.role === 'admin');
    expect(initialAdministratorGrant).toBeDefined();
    if (initialAdministratorGrant === undefined) throw new Error('Administrator grant missing.');
    const finalAdministratorRemoval = await deactivateRole(
      initialAdministratorGrant.id,
      initialAdministratorGrant.revision,
    );
    expect(finalAdministratorRemoval.status).toBe(409);
    await expect(finalAdministratorRemoval.json()).resolves.toMatchObject({
      error: { code: 'sole_administrator_self_change' },
    });

    const reactivated = await grantRole(subjectId, 'admin');
    expect(reactivated.status).toBe(200);
    await expect(reactivated.json()).resolves.toMatchObject({
      data: { id: createdBody.data.id, active: true, revision: 3 },
    });

    const competingDeactivations = await Promise.all([
      deactivateRole(createdBody.data.id, 3),
      deactivateRole(createdBody.data.id, 3),
    ]);
    expect(competingDeactivations.map((response) => response.status).sort()).toEqual([200, 409]);
    const mutationCounts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM audit_events WHERE target_id = ?) AS audits,
        (SELECT count(*) FROM outbox outbox_records
          JOIN audit_events events ON events.id = outbox_records.audit_event_id
          WHERE events.target_id = ?) AS outbox_records`,
    )
      .bind(createdBody.data.id, createdBody.data.id)
      .first<{ audits: number; outbox_records: number }>();
    expect(mutationCounts).toEqual({ audits: 4, outbox_records: 4 });
  });
});

async function insertRolelessSubject(
  providerSubject: string,
  displayName: string,
  administratorSubjectId: string,
): Promise<void> {
  const subjectId = `subject:${providerSubject}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subjects (
        id, kind, classification, display_name, primary_email, status, directory_state,
        protected, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'human', 'member', ?, NULL, 'active', 'active', 0, 1, ?, ?, ?, ?)`,
    ).bind(
      subjectId,
      displayName,
      timestamp,
      timestamp,
      administratorSubjectId,
      administratorSubjectId,
    ),
    env.DB.prepare(
      `INSERT INTO external_identities (
        id, subject_id, provider, issuer, provider_subject, display_name, email, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, 'cloudflare_access', 'local://access-control', ?, ?, NULL, 'active', 1,
        ?, ?, ?, ?)`,
    ).bind(
      `identity:${providerSubject}`,
      subjectId,
      providerSubject,
      displayName,
      timestamp,
      timestamp,
      administratorSubjectId,
      administratorSubjectId,
    ),
  ]);
}

async function grantRole(subjectId: string, role: string): Promise<Response> {
  return SELF.fetch(`http://localhost/api/v1/subjects/${subjectId}/platform-role-grants`, {
    method: 'POST',
    headers: administratorHeaders,
    body: JSON.stringify({ role, expectedSubjectRevision: 1 }),
  });
}

async function deactivateRole(roleGrantId: string, expectedRevision: number): Promise<Response> {
  return SELF.fetch(`http://localhost/api/v1/platform-role-grants/${roleGrantId}`, {
    method: 'PATCH',
    headers: administratorHeaders,
    body: JSON.stringify({ expectedRevision, confirmed: true }),
  });
}
