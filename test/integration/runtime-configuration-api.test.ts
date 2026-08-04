import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const time = '2026-01-01T00:00:00.000Z';
const planHash = `sha256:${'a'.repeat(64)}`;
const administratorHeaders = headers('local-admin');
const operatorHeaders = headers('config-operator');
const auditorHeaders = headers('config-auditor');

describe('Runtime configuration management API', () => {
  let administratorSubjectId: string;
  let applicationId: string;
  let entitlementId: string;

  beforeAll(async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    administratorSubjectId = bootstrap.subject.id;
    await insertAdministrativeSubject('config-operator', 'operator', administratorSubjectId);
    await insertAdministrativeSubject('config-auditor', 'auditor', administratorSubjectId);
  });

  it('keeps configuration reads available to auditors and writes limited to admin/operator', async () => {
    for (const path of [
      '/api/v1/organization-settings',
      '/api/v1/directory-sources',
      '/api/v1/provider-connections',
      '/api/v1/provisioning-targets',
    ]) {
      const response = await SELF.fetch(`http://localhost${path}`, {
        headers: auditorHeaders,
      });
      expect(response.status, path).toBe(200);
    }

    const forbidden = await request('/api/v1/directory-sources', 'POST', auditorHeaders, {
      id: 'directory:auditor-forbidden',
      provider: 'google',
      customerId: 'customer',
      delegatedAdmin: 'admin@example.org',
      credentialRef: 'GOOGLE_CREDENTIAL',
      accessGroupPrefix: 'access.',
      status: 'active',
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({ error: { code: 'role_forbidden' } });

    const organizationForbidden = await request(
      '/api/v1/organization-settings',
      'PATCH',
      operatorHeaders,
      {
        organizationName: 'Example Access Control',
        title: 'Example Access Control',
        supportUrl: 'https://support.example.org',
        maxPlanChanges: 20,
        expectedRevision: 1,
      },
    );
    expect(organizationForbidden.status).toBe(403);

    const organizationUpdated = await request(
      '/api/v1/organization-settings',
      'PATCH',
      administratorHeaders,
      {
        organizationName: 'Example Access Control',
        title: 'Runtime Configuration',
        supportUrl: null,
        brandMarkUrl: null,
        maxPlanChanges: 20,
        expectedRevision: 1,
      },
    );
    expect(organizationUpdated.status).toBe(200);
    await expect(organizationUpdated.json()).resolves.toMatchObject({ data: { revision: 2 } });
  });

  it('manages sources with revision CAS and administrator-only protected fields', async () => {
    const created = await request('/api/v1/directory-sources', 'POST', operatorHeaders, {
      id: 'directory:runtime',
      provider: 'google',
      customerId: 'customer-one',
      delegatedAdmin: 'directory-admin@example.org',
      credentialRef: 'GOOGLE_CREDENTIAL',
      accessGroupPrefix: 'access.',
      status: 'active',
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      data: { id: 'directory:runtime', revision: 1, status: 'active' },
    });

    const retiredCreate = await request('/api/v1/directory-sources', 'POST', operatorHeaders, {
      id: 'directory:retired-tombstone',
      provider: 'google',
      customerId: 'customer',
      delegatedAdmin: 'directory-admin@example.org',
      credentialRef: 'GOOGLE_CREDENTIAL',
      accessGroupPrefix: 'access.',
      status: 'retired',
    });
    expect(retiredCreate.status).toBe(400);

    const readCreated = await SELF.fetch(
      'http://localhost/api/v1/directory-sources/directory%3Aruntime',
      { headers: auditorHeaders },
    );
    expect(readCreated.status).toBe(200);
    await expect(readCreated.json()).resolves.toMatchObject({
      data: { id: 'directory:runtime', customerId: 'customer-one' },
    });

    const safeUpdate = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      operatorHeaders,
      {
        customerId: 'customer-one',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'active',
        expectedRevision: 1,
      },
    );
    expect(safeUpdate.status, JSON.stringify(await safeUpdate.clone().json())).toBe(200);

    const protectedUpdate = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      operatorHeaders,
      {
        customerId: 'customer-two',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'active',
        expectedRevision: 2,
      },
    );
    expect(protectedUpdate.status).toBe(403);
    await expect(protectedUpdate.json()).resolves.toMatchObject({
      error: { code: 'administrator_required' },
    });

    const administratorUpdate = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      administratorHeaders,
      {
        customerId: 'customer-two',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'active',
        expectedRevision: 2,
      },
    );
    expect(administratorUpdate.status).toBe(200);
    await expect(administratorUpdate.json()).resolves.toMatchObject({ data: { revision: 3 } });

    const stale = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      administratorHeaders,
      {
        customerId: 'customer-two',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'disabled',
        expectedRevision: 2,
      },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'revision_conflict' } });

    const immutableField = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      administratorHeaders,
      {
        provider: 'google',
        customerId: 'customer-two',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'active',
        expectedRevision: 3,
      },
    );
    expect(immutableField.status).toBe(400);

    const missingRevision = await request(
      '/api/v1/directory-sources/directory%3Aruntime',
      'PATCH',
      administratorHeaders,
      {
        customerId: 'customer-two',
        delegatedAdmin: 'new-directory-admin@example.org',
        credentialRef: 'GOOGLE_CREDENTIAL',
        accessGroupPrefix: 'access.',
        status: 'disabled',
      },
    );
    expect(missingRevision.status).toBe(400);

    const deleteResponse = await SELF.fetch(
      'http://localhost/api/v1/directory-sources/directory%3Aruntime',
      { method: 'DELETE', headers: administratorHeaders },
    );
    expect(deleteResponse.status).toBe(404);
  });

  it('manages the catalog, connections, targets, and mapping lifecycle without DELETE', async () => {
    const application = await request('/api/v1/applications', 'POST', operatorHeaders, {
      key: 'runtime-catalog',
      name: 'Runtime Catalog',
      category: 'Operations',
      launchUrl: 'https://catalog.example.org',
      status: 'active',
      visibility: 'entitled',
      authentication: { type: 'cloudflare_oidc', reference: 'access-runtime-catalog' },
      provisioningMode: 'observe',
    });
    expect(application.status).toBe(200);
    applicationId = ((await application.json()) as { data: { id: string } }).data.id;

    const entitlement = await request(
      `/api/v1/applications/${encodeURIComponent(applicationId)}/entitlements`,
      'POST',
      operatorHeaders,
      {
        key: 'reader',
        name: 'Reader',
        status: 'active',
        requiresProvisioning: true,
      },
    );
    expect(entitlement.status).toBe(200);
    entitlementId = ((await entitlement.json()) as { data: { id: string } }).data.id;

    const connection = await request('/api/v1/provider-connections', 'POST', operatorHeaders, {
      id: 'provider:runtime-github',
      provider: 'github',
      name: 'Runtime GitHub',
      mode: 'observe',
      credentialRef: 'GITHUB_CREDENTIAL',
      configuration: { organization: 'example-organization' },
      status: 'active',
    });
    expect(connection.status).toBe(200);

    const secretConfiguration = await request(
      '/api/v1/provider-connections',
      'POST',
      operatorHeaders,
      {
        id: 'provider:secret-rejected',
        provider: 'github',
        name: 'Rejected secret',
        mode: 'observe',
        configuration: { client_secret: 'must-not-be-stored' },
        status: 'active',
      },
    );
    expect(secretConfiguration.status).toBe(422);
    await expect(secretConfiguration.json()).resolves.toMatchObject({
      error: { code: 'secret_configuration_forbidden' },
    });

    const automatic = await request(
      '/api/v1/provider-connections/provider%3Aruntime-github',
      'PATCH',
      operatorHeaders,
      {
        name: 'Runtime GitHub',
        mode: 'automatic',
        credentialRef: 'GITHUB_CREDENTIAL',
        configuration: { organization: 'example-organization' },
        status: 'active',
        expectedRevision: 1,
      },
    );
    expect(automatic.status).toBe(403);
    await expect(automatic.json()).resolves.toMatchObject({
      error: { code: 'administrator_required' },
    });

    const invalidAutomaticTarget = await request(
      '/api/v1/provisioning-targets',
      'POST',
      administratorHeaders,
      {
        id: 'target:invalid-automatic',
        providerConnectionId: 'provider:runtime-github',
        applicationEntitlementId: entitlementId,
        targetType: 'github_team_membership',
        providerTargetId: 'invalid-automatic',
        mode: 'automatic',
        protected: false,
        configuration: {},
        status: 'active',
      },
    );
    expect(invalidAutomaticTarget.status).toBe(422);
    await expect(invalidAutomaticTarget.json()).resolves.toMatchObject({
      error: { code: 'invalid_configuration_lifecycle' },
    });

    const target = await request('/api/v1/provisioning-targets', 'POST', operatorHeaders, {
      id: 'target:runtime-readers',
      providerConnectionId: 'provider:runtime-github',
      applicationEntitlementId: entitlementId,
      targetType: 'github_team_membership',
      providerTargetId: 'readers',
      mode: 'observe',
      protected: true,
      configuration: {},
      status: 'active',
    });
    expect(target.status).toBe(200);

    const connectionRead = await SELF.fetch(
      'http://localhost/api/v1/provider-connections/provider%3Aruntime-github',
      { headers: auditorHeaders },
    );
    expect(connectionRead.status).toBe(200);
    const targetRead = await SELF.fetch(
      'http://localhost/api/v1/provisioning-targets/target%3Aruntime-readers',
      { headers: auditorHeaders },
    );
    expect(targetRead.status).toBe(200);

    const connectionWithActiveTarget = await request(
      '/api/v1/provider-connections/provider%3Aruntime-github',
      'PATCH',
      operatorHeaders,
      {
        name: 'Runtime GitHub',
        mode: 'observe',
        credentialRef: 'GITHUB_CREDENTIAL',
        configuration: { organization: 'example-organization' },
        status: 'disabled',
        expectedRevision: 1,
      },
    );
    expect(connectionWithActiveTarget.status).toBe(422);

    const entitlementWithActiveTarget = await request(
      `/api/v1/applications/${encodeURIComponent(applicationId)}/entitlements/${encodeURIComponent(entitlementId)}`,
      'PATCH',
      operatorHeaders,
      {
        name: 'Reader',
        status: 'disabled',
        requiresProvisioning: true,
        expectedRevision: 1,
      },
    );
    expect(entitlementWithActiveTarget.status).toBe(422);

    const clearProtected = await request(
      '/api/v1/provisioning-targets/target%3Aruntime-readers',
      'PATCH',
      operatorHeaders,
      {
        applicationEntitlementId: entitlementId,
        mode: 'observe',
        protected: false,
        configuration: {},
        status: 'active',
        expectedRevision: 1,
      },
    );
    expect(clearProtected.status).toBe(403);

    const adminClearProtected = await request(
      '/api/v1/provisioning-targets/target%3Aruntime-readers',
      'PATCH',
      administratorHeaders,
      {
        applicationEntitlementId: entitlementId,
        mode: 'observe',
        protected: false,
        configuration: {},
        status: 'active',
        expectedRevision: 1,
      },
    );
    expect(adminClearProtected.status).toBe(200);

    const entitlementUpdate = await request(
      `/api/v1/applications/${encodeURIComponent(applicationId)}/entitlements/${encodeURIComponent(entitlementId)}`,
      'PATCH',
      operatorHeaders,
      {
        name: 'Read only',
        status: 'active',
        requiresProvisioning: true,
        expectedRevision: 1,
      },
    );
    expect(entitlementUpdate.status, JSON.stringify(await entitlementUpdate.clone().json())).toBe(
      200,
    );

    await insertObservedSourceGroup();
    const mapping = await request('/api/v1/mappings', 'POST', operatorHeaders, {
      id: 'mapping:runtime-readers',
      sourceGroupId: 'group:runtime-readers',
      entitlementIds: [entitlementId],
      provisioningTargetIds: ['target:runtime-readers'],
    });
    expect(mapping.status).toBe(200);
    await expect(mapping.json()).resolves.toMatchObject({
      data: { id: 'mapping:runtime-readers', status: 'draft', revision: 1 },
    });

    const preview = await request(
      '/api/v1/mappings/mapping%3Aruntime-readers/preview',
      'POST',
      operatorHeaders,
      { expectedRevision: 1 },
    );
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toMatchObject({
      data: { affectedSubjectIds: [], grantCountBefore: 0, grantCountAfter: 0 },
    });

    const activation = await request(
      '/api/v1/mappings/mapping%3Aruntime-readers/activate',
      'POST',
      operatorHeaders,
      { expectedRevision: 1, confirmedAffectedSubjectIds: [] },
    );
    expect(activation.status).toBe(200);

    const retired = await request(
      '/api/v1/mappings/mapping%3Aruntime-readers/retire',
      'POST',
      operatorHeaders,
      { expectedRevision: 2 },
    );
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toMatchObject({
      data: { status: 'retired', revision: 3 },
    });
  });

  it('enforces immutable configuration identity fields in D1', async () => {
    await expect(
      env.DB.prepare(
        `UPDATE directory_sources
         SET provider = 'google', id = 'directory:replacement', revision = 4,
             updated_at = ?, updated_by = ?
         WHERE id = 'directory:runtime'`,
      )
        .bind(time, administratorSubjectId)
        .run(),
    ).rejects.toThrow(/directory_source_key_immutable/);
    await expect(
      env.DB.prepare(
        `UPDATE provider_connections
         SET provider = 'posix', revision = 2, updated_at = ?, updated_by = ?
         WHERE id = 'provider:runtime-github'`,
      )
        .bind(time, administratorSubjectId)
        .run(),
    ).rejects.toThrow(/provider_connection_key_immutable/);
    await expect(
      env.DB.prepare(
        `UPDATE provisioning_targets
         SET provider_target_id = 'replacement', revision = 3, updated_at = ?, updated_by = ?
         WHERE id = 'target:runtime-readers'`,
      )
        .bind(time, administratorSubjectId)
        .run(),
    ).rejects.toThrow(/provisioning_target_key_immutable/);
  });

  it('records each successful configuration mutation in audit/outbox and renders read-only state', async () => {
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT count(*) FROM audit_events
          WHERE json_extract(payload_json, '$.configurationPlanHash') = ?) AS audits,
        (SELECT count(*) FROM outbox records
          JOIN audit_events events ON events.id = records.audit_event_id
          WHERE json_extract(events.payload_json, '$.configurationPlanHash') = ?) AS outbox_records`,
    )
      .bind(planHash, planHash)
      .first<{ audits: number; outbox_records: number }>();
    expect(counts).toEqual({ audits: 13, outbox_records: 13 });

    const page = await SELF.fetch('http://localhost/admin/settings', {
      headers: auditorHeaders,
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Google ディレクトリ');
    expect(html).toContain('外部サービス接続');
    expect(html).toContain('権限の反映先');
    expect(html).toContain(planHash);
    expect(html).not.toContain('<textarea');
  });
});

function headers(identity: string) {
  return {
    'content-type': 'application/json',
    'x-access-control-dev-identity': `access:${identity}`,
    'x-access-control-plan-hash': planHash,
    'x-access-control-reason': 'runtime_configuration_api_test',
  };
}

function request(
  path: string,
  method: 'PATCH' | 'POST',
  requestHeaders: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method,
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

async function insertAdministrativeSubject(
  providerSubject: string,
  role: 'auditor' | 'operator',
  administratorId: string,
): Promise<void> {
  const subjectId = `subject:${providerSubject}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subjects (
        id, kind, classification, display_name, primary_email, status, directory_state,
        protected, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'human', 'member', ?, NULL, 'active', 'active', 0, 1, ?, ?, ?, ?)`,
    ).bind(subjectId, providerSubject, time, time, administratorId, administratorId),
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
      providerSubject,
      time,
      time,
      administratorId,
      administratorId,
    ),
    env.DB.prepare(
      `INSERT INTO platform_role_grants (
        id, subject_id, role, active, protected, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
    ).bind(
      `role-grant:${providerSubject}`,
      subjectId,
      role,
      time,
      time,
      administratorId,
      administratorId,
    ),
  ]);
}

async function insertObservedSourceGroup(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO directory_sync_runs (
        id, directory_source_id, status, started_at, completed_at, snapshot_version,
        user_count, group_count, membership_count, violation_count, error_code, request_id
      ) VALUES (
        'sync:runtime', 'directory:runtime', 'completed', ?, ?, ?, 0, 1, 0, 0, NULL,
        'request:runtime-sync'
      )`,
    ).bind(time, time, `sha256:${'0'.repeat(64)}`),
    env.DB.prepare(
      `INSERT INTO source_groups (
        id, directory_source_id, provider_group_id, email, aliases_json, name, kind, status,
        direct_member_count, last_sync_run_id, last_observed_at, revision, created_at, updated_at
      ) VALUES (
        'group:runtime-readers', 'directory:runtime', 'google-group-runtime-readers',
        'access.runtime.readers@example.org', '[]', 'Runtime Readers', 'access', 'active',
        0, 'sync:runtime', ?, 1, ?, ?
      )`,
    ).bind(time, time, time),
  ]);
}
