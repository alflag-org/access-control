import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createD1Repositories } from '@access-control/d1';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const administratorHeaders = {
  'content-type': 'application/json',
  'x-access-control-dev-identity': 'access:local-admin',
  'x-access-control-reason': 'profile-editing-test',
};
const timestamp = '2026-01-01T00:00:00.000Z';

describe('Subject and managed guest profile editing', () => {
  let administratorSubjectId: string;

  beforeAll(async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    administratorSubjectId = bootstrap.subject.id;
  });

  it('updates a locally managed Subject profile and permits clearing its email', async () => {
    const updated = await request(`/api/v1/subjects/${administratorSubjectId}/profile`, {
      displayName: 'Updated Administrator',
      primaryEmail: 'administrator@example.org',
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        id: administratorSubjectId,
        displayName: 'Updated Administrator',
        primaryEmail: 'administrator@example.org',
        revision: 2,
      },
    });

    const cleared = await request(`/api/v1/subjects/${administratorSubjectId}/profile`, {
      displayName: 'Updated Administrator',
      primaryEmail: null,
      expectedRevision: 2,
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      data: { displayName: 'Updated Administrator', revision: 3 },
    });

    const subject = await createD1Repositories(env.DB).identities.getSubject(
      administratorSubjectId,
    );
    expect(subject?.primaryEmail).toBeUndefined();
    const audits = (await createD1Repositories(env.DB).audit.listAuditEvents()).filter(
      (event) =>
        event.eventType === 'access-control.subject.profile.updated' &&
        event.targetId === administratorSubjectId,
    );
    expect(audits.map((audit) => audit.payload)).toContainEqual({
      changedFields: ['displayName', 'primaryEmail'],
    });
    expect(JSON.stringify(audits)).not.toContain('administrator@example.org');
  });

  it('updates a managed guest profile atomically and enforces both revisions', async () => {
    const created = await request(
      '/api/v1/guests',
      {
        displayName: 'Managed Guest',
        primaryEmail: 'guest@example.org',
        sponsorSubjectId: administratorSubjectId,
        externalContactEmail: 'guest.contact@example.net',
        externalOrganization: 'Example Partner',
        purpose: 'Time-bounded repository review',
        validFrom: timestamp,
        expiresAt: '2027-02-01T00:00:00.000Z',
      },
      'POST',
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      data: { subject: { id: string; revision: number }; guestProfile: { revision: number } };
    };

    const updated = await request(`/api/v1/guests/${createdBody.data.subject.id}/profile`, {
      displayName: 'Renamed Guest',
      primaryEmail: null,
      externalContactEmail: 'updated.contact@example.net',
      externalOrganization: 'Updated Partner',
      purpose: 'Updated repository review',
      expectedSubjectRevision: createdBody.data.subject.revision,
      expectedGuestRevision: createdBody.data.guestProfile.revision,
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      data: {
        subject: { displayName: 'Renamed Guest', revision: 2 },
        guestProfile: {
          externalContactEmail: 'updated.contact@example.net',
          externalOrganization: 'Updated Partner',
          purpose: 'Updated repository review',
          revision: 2,
        },
      },
    });

    const stale = await request(`/api/v1/guests/${createdBody.data.subject.id}/profile`, {
      displayName: 'Stale Guest Update',
      externalContactEmail: 'stale.contact@example.net',
      externalOrganization: 'Stale Partner',
      purpose: 'Stale update',
      expectedSubjectRevision: 1,
      expectedGuestRevision: 1,
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'revision_conflict' } });

    const repositories = createD1Repositories(env.DB);
    await env.DB.prepare(
      `UPDATE subjects
       SET directory_state = 'active', revision = 3, updated_at = ?, updated_by = ?
       WHERE id = ? AND revision = 2`,
    )
      .bind(timestamp, administratorSubjectId, createdBody.data.subject.id)
      .run();
    const directoryManagedUpdate = await request(
      `/api/v1/guests/${createdBody.data.subject.id}/profile`,
      {
        externalContactEmail: 'directory-managed.contact@example.net',
        externalOrganization: 'Directory Partner',
        purpose: 'Directory-managed guest review',
        expectedSubjectRevision: 3,
        expectedGuestRevision: 2,
      },
    );
    expect(directoryManagedUpdate.status).toBe(200);

    const updatedSubject = await repositories.identities.getSubject(createdBody.data.subject.id);
    expect(updatedSubject).toMatchObject({ displayName: 'Renamed Guest', revision: 4 });
    expect(updatedSubject?.primaryEmail).toBeUndefined();
    await expect(
      repositories.identities.getGuestProfile(createdBody.data.subject.id),
    ).resolves.toMatchObject({
      externalContactEmail: 'directory-managed.contact@example.net',
      externalOrganization: 'Directory Partner',
      purpose: 'Directory-managed guest review',
      revision: 3,
    });
  });

  it('rejects profile edits for a directory-managed Subject', async () => {
    const subjectId = 'subject:directory-managed-profile';
    await env.DB.prepare(
      `INSERT INTO subjects (
        id, kind, classification, display_name, primary_email, status, directory_state,
        protected, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'human', 'member', ?, ?, 'active', 'active', 0, 1, ?, ?, ?, ?)`,
    )
      .bind(
        subjectId,
        'Directory User',
        'directory@example.org',
        timestamp,
        timestamp,
        administratorSubjectId,
        administratorSubjectId,
      )
      .run();

    const response = await request(`/api/v1/subjects/${subjectId}/profile`, {
      displayName: 'Local Override',
      primaryEmail: 'override@example.org',
      expectedRevision: 1,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'directory_managed_profile' },
    });
    await expect(
      createD1Repositories(env.DB).identities.getSubject(subjectId),
    ).resolves.toMatchObject({
      displayName: 'Directory User',
      primaryEmail: 'directory@example.org',
      revision: 1,
    });
  });
});

async function request(
  path: string,
  body: Record<string, unknown>,
  method = 'PATCH',
): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method,
    headers: administratorHeaders,
    body: JSON.stringify(body),
  });
}
