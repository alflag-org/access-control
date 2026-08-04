import { z } from 'zod';
import {
  idSchema,
  jsonObjectSchema,
  revisionSchema,
  sha256Schema,
  timestampSchema,
} from './common';

export const auditEventSchema = z
  .object({
    id: idSchema,
    eventType: z.string().trim().min(1).max(200),
    actorSubjectId: idSchema.optional(),
    targetType: z.string().trim().min(1).max(100),
    targetId: idSchema,
    action: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(1_000).optional(),
    requestId: idSchema,
    result: z.enum(['succeeded', 'failed', 'blocked']),
    previousRevision: revisionSchema.optional(),
    resultingRevision: revisionSchema.optional(),
    providerEvidenceRef: z.string().trim().min(1).max(1_000).optional(),
    payload: jsonObjectSchema,
    occurredAt: timestampSchema,
  })
  .strict();

export const outboxRecordSchema = z
  .object({
    id: idSchema,
    auditEventId: idSchema,
    topic: z.string().trim().min(1).max(200),
    payload: jsonObjectSchema,
    status: z.enum(['pending', 'dispatching', 'delivered', 'failed']),
    attempts: z.int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deliveredAt: timestampSchema.optional(),
    lastErrorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const exportRecordSchema = z
  .object({
    id: idSchema,
    schemaVersion: z.literal('1.0.0'),
    status: z.enum(['planned', 'running', 'completed', 'failed']),
    objectKey: z.string().trim().min(1).max(1_000).optional(),
    checksum: sha256Schema.optional(),
    entityCount: z.int().nonnegative().optional(),
    revision: revisionSchema,
    requestedBy: idSchema,
    claimId: idSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type OutboxRecord = z.infer<typeof outboxRecordSchema>;
export type ExportRecord = z.infer<typeof exportRecordSchema>;
