import {
  createAuditEventCandidate,
  createOutboxRecordCandidate,
  type AuditEvent,
  type JsonObject,
  type OutboxRecord,
} from '@access-control/domain';
import type { ServiceRuntime } from './runtime';

export interface MutationContext {
  actorSubjectId?: string;
  requestId: string;
  reason?: string;
  configurationPlanHash?: string;
}

export interface MutationRecords {
  auditEvent: AuditEvent;
  outboxRecord: OutboxRecord;
}

export interface MutationEventInput {
  eventType: string;
  topic: string;
  targetType: string;
  targetId: string;
  action: string;
  result?: 'succeeded' | 'failed' | 'blocked';
  previousRevision?: number;
  resultingRevision?: number;
  providerEvidenceRef?: string;
  payload?: JsonObject;
}

export function createMutationRecords(
  runtime: ServiceRuntime,
  context: MutationContext,
  input: MutationEventInput,
): MutationRecords {
  const occurredAt = runtime.now();
  const payload = {
    ...(input.payload ?? {}),
    ...(context.configurationPlanHash === undefined
      ? {}
      : { configurationPlanHash: context.configurationPlanHash }),
  };
  const auditEvent = createAuditEventCandidate({
    id: runtime.id('audit'),
    eventType: input.eventType,
    ...(context.actorSubjectId === undefined ? {} : { actorSubjectId: context.actorSubjectId }),
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    ...(context.reason === undefined ? {} : { reason: context.reason }),
    requestId: context.requestId,
    result: input.result ?? 'succeeded',
    ...(input.previousRevision === undefined ? {} : { previousRevision: input.previousRevision }),
    ...(input.resultingRevision === undefined
      ? {}
      : { resultingRevision: input.resultingRevision }),
    ...(input.providerEvidenceRef === undefined
      ? {}
      : { providerEvidenceRef: input.providerEvidenceRef }),
    payload,
    occurredAt,
  });
  return {
    auditEvent,
    outboxRecord: createOutboxRecordCandidate({
      id: runtime.id('outbox'),
      auditEventId: auditEvent.id,
      topic: input.topic,
      payload: {
        eventId: auditEvent.id,
        targetType: input.targetType,
        targetId: input.targetId,
        ...payload,
      },
      status: 'pending',
      attempts: 0,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }),
  };
}
