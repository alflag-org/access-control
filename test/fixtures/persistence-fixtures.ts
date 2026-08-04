import { BootstrapService, type BootstrapResult } from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import { fixtureRuntime } from './domain-fixtures';

export async function bootstrapAdministrator(database: D1Database): Promise<BootstrapResult> {
  const repositories = createD1Repositories(database);
  return new BootstrapService(repositories.identities, fixtureRuntime()).execute(
    {
      environment: 'development',
      canonicalIdentity: 'access:local-admin',
      displayName: 'Local Administrator',
      organizationName: 'Example Access Control',
      supportUrl: 'https://support.example.org',
    },
    { requestId: 'request:bootstrap' },
  );
}

export async function insertDirectorySource(database: D1Database, administratorId: string) {
  const now = '2026-01-01T00:00:00.000Z';
  await database
    .prepare(
      `INSERT INTO directory_sources (
        id, provider, customer_id, delegated_admin, credential_ref, access_group_prefix,
        status, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, 'google', ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    )
    .bind(
      'directory:google',
      'example-customer',
      'directory-admin@example.org',
      'GOOGLE_CREDENTIAL',
      'access.',
      now,
      now,
      administratorId,
      administratorId,
    )
    .run();
}
