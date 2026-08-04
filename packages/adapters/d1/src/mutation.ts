import {
  AccessControlError,
  databaseConflict,
  type AuditEvent,
  type OutboxRecord,
} from '@access-control/domain';
import type { MutationRecords } from '@access-control/application';
import type { SqlValue } from './client';

export interface SqlPredicate {
  sql: string;
  params: SqlValue[];
}

type StatementFactory = (sql: string, ...params: SqlValue[]) => D1PreparedStatement;

export function mutationStatements(
  statement: StatementFactory,
  mutation: MutationRecords,
  predicate?: SqlPredicate,
): D1PreparedStatement[] {
  const audit = mutation.auditEvent;
  const outbox = mutation.outboxRecord;
  const insertAudit =
    predicate === undefined
      ? statement(
          auditInsertSql('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
          ...auditParams(audit),
        )
      : statement(
          auditInsertSql(`SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${predicate.sql}`),
          ...auditParams(audit),
          ...predicate.params,
        );
  const insertOutbox = statement(
    `INSERT INTO outbox (
      id, audit_event_id, topic, payload_json, status, attempts,
      created_at, updated_at, delivered_at, last_error_code
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
    ...outboxParams(outbox),
    audit.id,
  );
  return [insertAudit, insertOutbox];
}

export function mutationGuardStatements(
  statement: StatementFactory,
  guardId: string,
  validitySql: string,
  params: SqlValue[],
): { before: D1PreparedStatement; after: D1PreparedStatement } {
  return {
    before: statement(
      `INSERT INTO mutation_guards (id, is_valid) SELECT ?, CASE WHEN ${validitySql} THEN 1 ELSE 0 END`,
      guardId,
      ...params,
    ),
    after: statement('DELETE FROM mutation_guards WHERE id = ?', guardId),
  };
}

export async function executeBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  mutationIndex: number,
  entity: string,
): Promise<D1Result<unknown>[]> {
  let results: D1Result<unknown>[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    throw databaseConflict(error);
  }
  if (results[mutationIndex]?.meta.changes !== 1) {
    throw new AccessControlError(
      409,
      'revision_conflict',
      `${entity} changed before the mutation was committed.`,
    );
  }
  return results;
}

function auditInsertSql(values: string): string {
  return `INSERT INTO audit_events (
    id, event_type, actor_subject_id, target_type, target_id, action, reason,
    request_id, result, previous_revision, resulting_revision,
    provider_evidence_ref, payload_json, occurred_at
  ) ${values}`;
}

function auditParams(event: AuditEvent): SqlValue[] {
  return [
    event.id,
    event.eventType,
    event.actorSubjectId ?? null,
    event.targetType,
    event.targetId,
    event.action,
    event.reason ?? null,
    event.requestId,
    event.result,
    event.previousRevision ?? null,
    event.resultingRevision ?? null,
    event.providerEvidenceRef ?? null,
    JSON.stringify(event.payload),
    event.occurredAt,
  ];
}

function outboxParams(record: OutboxRecord): SqlValue[] {
  return [
    record.id,
    record.auditEventId,
    record.topic,
    JSON.stringify(record.payload),
    record.status,
    record.attempts,
    record.createdAt,
    record.updatedAt,
    record.deliveredAt ?? null,
    record.lastErrorCode ?? null,
  ];
}
