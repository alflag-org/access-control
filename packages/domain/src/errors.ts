import type { JsonObject } from './common';

export interface Violation {
  code: string;
  path: string;
  message: string;
}

export class AccessControlError extends Error {
  public constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly violations: Violation[] = [],
    public readonly safeEvidence?: JsonObject,
  ) {
    super(message);
    this.name = 'AccessControlError';
  }
}

export class RevisionConflictError extends AccessControlError {
  public constructor(expectedRevision: number, actualRevision: number) {
    super(409, 'revision_conflict', 'The resource changed before this update was committed.', [
      {
        code: 'expected_revision_mismatch',
        path: 'expectedRevision',
        message: `Expected revision ${expectedRevision} but found revision ${actualRevision}.`,
      },
    ]);
  }
}

export class NotFoundError extends AccessControlError {
  public constructor(entity: string, id: string) {
    super(404, 'not_found', `${entity} ${id} was not found.`);
  }
}

export function databaseConflict(error: unknown): AccessControlError {
  const message = error instanceof Error ? error.message : String(error);
  const mappings: Array<[string, string, string]> = [
    [
      'final_active_admin_required',
      'final_administrator_required',
      'At least one active administrator must remain.',
    ],
    [
      'sole_admin_self_change_forbidden',
      'sole_administrator_self_change',
      'The sole administrator cannot remove their own access.',
    ],
    ['revision_increment_required', 'revision_conflict', 'The resource revision is stale.'],
    ['identity_key_immutable', 'immutable_identity_key', 'External identity keys are immutable.'],
    ['application_key_immutable', 'immutable_application_key', 'Application keys are immutable.'],
    ['entitlement_key_immutable', 'immutable_entitlement_key', 'Entitlement keys are immutable.'],
    [
      'organization_settings_key_immutable',
      'immutable_organization_settings_key',
      'Organization settings identity and provenance are immutable.',
    ],
    [
      'directory_source_key_immutable',
      'immutable_directory_source_key',
      'Directory Source identity and provider are immutable.',
    ],
    [
      'provider_connection_key_immutable',
      'immutable_provider_connection_key',
      'Provider Connection identity and provider are immutable.',
    ],
    [
      'provisioning_target_key_immutable',
      'immutable_provisioning_target_key',
      'Provisioning Target provider identity is immutable.',
    ],
    ['plan_immutable', 'immutable_plan', 'Persisted operation plans are immutable.'],
    [
      'hard_delete_forbidden',
      'hard_delete_forbidden',
      'Domain records must be retired instead of deleted.',
    ],
  ];
  const match = mappings.find(([fragment]) => message.includes(fragment));
  if (match !== undefined) return new AccessControlError(409, match[1], match[2]);
  if (message.includes('UNIQUE constraint failed')) {
    return new AccessControlError(
      409,
      'uniqueness_conflict',
      'A record with the same immutable key already exists.',
    );
  }
  return new AccessControlError(
    409,
    'persistence_conflict',
    'The requested mutation could not be committed.',
  );
}
