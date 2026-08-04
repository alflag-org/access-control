import {
  auditEventSchema,
  exportRecordSchema,
  outboxRecordSchema,
  type AuditEvent,
  type ExportRecord,
  type OutboxRecord,
} from '@access-control/domain';
import {
  integer,
  jsonValue,
  optionalInteger,
  optionalText,
  text,
  type DatabaseRow,
} from './row-values';

export function mapAuditEvent(row: DatabaseRow): AuditEvent {
  return auditEventSchema.parse({
    id: text(row, 'id'),
    eventType: text(row, 'event_type'),
    ...(optionalText(row, 'actor_subject_id') === undefined
      ? {}
      : { actorSubjectId: optionalText(row, 'actor_subject_id') }),
    targetType: text(row, 'target_type'),
    targetId: text(row, 'target_id'),
    action: text(row, 'action'),
    ...(optionalText(row, 'reason') === undefined ? {} : { reason: optionalText(row, 'reason') }),
    requestId: text(row, 'request_id'),
    result: text(row, 'result'),
    ...(optionalInteger(row, 'previous_revision') === undefined
      ? {}
      : { previousRevision: optionalInteger(row, 'previous_revision') }),
    ...(optionalInteger(row, 'resulting_revision') === undefined
      ? {}
      : { resultingRevision: optionalInteger(row, 'resulting_revision') }),
    ...(optionalText(row, 'provider_evidence_ref') === undefined
      ? {}
      : { providerEvidenceRef: optionalText(row, 'provider_evidence_ref') }),
    payload: jsonValue(row, 'payload_json'),
    occurredAt: text(row, 'occurred_at'),
  });
}

export function mapOutboxRecord(row: DatabaseRow): OutboxRecord {
  return outboxRecordSchema.parse({
    id: text(row, 'id'),
    auditEventId: text(row, 'audit_event_id'),
    topic: text(row, 'topic'),
    payload: jsonValue(row, 'payload_json'),
    status: text(row, 'status'),
    attempts: integer(row, 'attempts'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    ...(optionalText(row, 'delivered_at') === undefined
      ? {}
      : { deliveredAt: optionalText(row, 'delivered_at') }),
    ...(optionalText(row, 'last_error_code') === undefined
      ? {}
      : { lastErrorCode: optionalText(row, 'last_error_code') }),
  });
}

export function mapExportRecord(row: DatabaseRow): ExportRecord {
  return exportRecordSchema.parse({
    id: text(row, 'id'),
    schemaVersion: text(row, 'schema_version'),
    status: text(row, 'status'),
    ...(optionalText(row, 'object_key') === undefined
      ? {}
      : { objectKey: optionalText(row, 'object_key') }),
    ...(optionalText(row, 'checksum') === undefined
      ? {}
      : { checksum: optionalText(row, 'checksum') }),
    ...(optionalInteger(row, 'entity_count') === undefined
      ? {}
      : { entityCount: optionalInteger(row, 'entity_count') }),
    revision: integer(row, 'revision'),
    requestedBy: text(row, 'requested_by'),
    ...(optionalText(row, 'claim_id') === undefined
      ? {}
      : { claimId: optionalText(row, 'claim_id') }),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    ...(optionalText(row, 'completed_at') === undefined
      ? {}
      : { completedAt: optionalText(row, 'completed_at') }),
    ...(optionalText(row, 'error_code') === undefined
      ? {}
      : { errorCode: optionalText(row, 'error_code') }),
  });
}
