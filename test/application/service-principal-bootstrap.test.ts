import { describe, expect, it } from 'vitest';
import {
  assertServicePrincipalBootstrapAllowed,
  createServicePrincipalBootstrapRecords,
} from '@access-control/application';
import { fixtureRuntime } from '../fixtures/domain-fixtures';

describe('Service principal bootstrap', () => {
  it('requires an existing administrator and rejects duplicate identities', () => {
    expect(() =>
      assertServicePrincipalBootstrapAllowed({ duplicateIdentityExists: false }),
    ).toThrowError(expect.objectContaining({ code: 'administrator_required' }));
    expect(() =>
      assertServicePrincipalBootstrapAllowed({
        activeAdministratorId: 'subject:admin',
        duplicateIdentityExists: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'service_identity_already_exists' }));
  });

  it('creates a protected service Subject and protected non-admin role with audit/outbox', () => {
    const records = createServicePrincipalBootstrapRecords(
      {
        administratorId: 'subject:admin',
        issuer: 'https://example.cloudflareaccess.com',
        commonName: 'access-control-configurator',
        role: 'operator',
        requestId: 'request:bootstrap-service',
      },
      fixtureRuntime(),
    );

    expect(records.subject).toMatchObject({
      kind: 'service',
      classification: 'automation',
      protected: true,
      status: 'active',
    });
    expect(records.identity).toMatchObject({
      provider: 'cloudflare_access',
      issuer: 'https://example.cloudflareaccess.com',
      providerSubject: 'access-control-configurator',
      status: 'active',
    });
    expect(records.roleGrant).toMatchObject({ role: 'operator', protected: true, active: true });
    expect(records.roleGrant.role).not.toBe('admin');
    expect(records.mutation.outboxRecord.auditEventId).toBe(records.mutation.auditEvent.id);
  });
});
