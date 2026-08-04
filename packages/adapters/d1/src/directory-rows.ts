import {
  directorySourceSchema,
  directorySyncRunSchema,
  directorySyncViolationSchema,
  sourceGroupMembershipSchema,
  sourceGroupSchema,
  type DirectorySource,
  type DirectorySyncRun,
  type DirectorySyncViolation,
  type SourceGroup,
  type SourceGroupMembership,
} from '@access-control/domain';
import { integer, jsonValue, optionalText, text, type DatabaseRow } from './row-values';

export function mapDirectorySource(row: DatabaseRow): DirectorySource {
  return directorySourceSchema.parse({
    id: text(row, 'id'),
    provider: text(row, 'provider'),
    customerId: text(row, 'customer_id'),
    delegatedAdmin: text(row, 'delegated_admin'),
    credentialRef: text(row, 'credential_ref'),
    accessGroupPrefix: text(row, 'access_group_prefix'),
    status: text(row, 'status'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapDirectorySyncRun(row: DatabaseRow): DirectorySyncRun {
  return directorySyncRunSchema.parse({
    id: text(row, 'id'),
    directorySourceId: text(row, 'directory_source_id'),
    status: text(row, 'status'),
    startedAt: text(row, 'started_at'),
    ...(optionalText(row, 'completed_at') === undefined
      ? {}
      : { completedAt: optionalText(row, 'completed_at') }),
    ...(optionalText(row, 'snapshot_version') === undefined
      ? {}
      : { snapshotVersion: optionalText(row, 'snapshot_version') }),
    userCount: integer(row, 'user_count'),
    groupCount: integer(row, 'group_count'),
    membershipCount: integer(row, 'membership_count'),
    violationCount: integer(row, 'violation_count'),
    ...(optionalText(row, 'error_code') === undefined
      ? {}
      : { errorCode: optionalText(row, 'error_code') }),
    requestId: text(row, 'request_id'),
  });
}

export function mapDirectorySyncViolation(row: DatabaseRow): DirectorySyncViolation {
  return directorySyncViolationSchema.parse({
    id: text(row, 'id'),
    syncRunId: text(row, 'sync_run_id'),
    code: text(row, 'code'),
    entityType: text(row, 'entity_type'),
    entityId: text(row, 'entity_id'),
    ...(optionalText(row, 'field') === undefined ? {} : { field: optionalText(row, 'field') }),
    message: text(row, 'message'),
    recordedAt: text(row, 'recorded_at'),
  });
}

export function mapSourceGroup(row: DatabaseRow): SourceGroup {
  return sourceGroupSchema.parse({
    id: text(row, 'id'),
    directorySourceId: text(row, 'directory_source_id'),
    providerGroupId: text(row, 'provider_group_id'),
    email: text(row, 'email'),
    aliases: jsonValue(row, 'aliases_json'),
    name: text(row, 'name'),
    kind: text(row, 'kind'),
    status: text(row, 'status'),
    directMemberCount: integer(row, 'direct_member_count'),
    lastSyncRunId: text(row, 'last_sync_run_id'),
    lastObservedAt: text(row, 'last_observed_at'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  });
}

export function mapSourceGroupMembership(row: DatabaseRow): SourceGroupMembership {
  return sourceGroupMembershipSchema.parse({
    id: text(row, 'id'),
    sourceGroupId: text(row, 'source_group_id'),
    providerMembershipId: text(row, 'provider_membership_id'),
    memberType: text(row, 'member_type'),
    memberProviderId: text(row, 'member_provider_id'),
    ...(optionalText(row, 'member_email') === undefined
      ? {}
      : { memberEmail: optionalText(row, 'member_email') }),
    role: text(row, 'role'),
    status: text(row, 'status'),
    syncRunId: text(row, 'sync_run_id'),
    observedAt: text(row, 'observed_at'),
  });
}
