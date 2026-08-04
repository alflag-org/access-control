import { z } from 'zod';
import {
  displayNameSchema,
  emailSchema,
  idSchema,
  revisionSchema,
  sha256Schema,
  timestampSchema,
} from './common';

export const directorySyncRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export const directorySyncViolationCodeSchema = z.enum([
  'nested_access_group',
  'unmanaged_external_member',
  'missing_subject',
  'invalid_directory_record',
  'duplicate_immutable_id',
]);

export const directorySyncRunSchema = z
  .object({
    id: idSchema,
    directorySourceId: idSchema,
    status: directorySyncRunStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    snapshotVersion: sha256Schema.optional(),
    userCount: z.int().nonnegative(),
    groupCount: z.int().nonnegative(),
    membershipCount: z.int().nonnegative(),
    violationCount: z.int().nonnegative(),
    errorCode: z.string().trim().min(1).max(100).optional(),
    requestId: idSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.status === 'running' &&
      (run.completedAt !== undefined || run.snapshotVersion !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A running directory sync cannot have completion metadata.',
      });
    }
    if (
      run.status === 'completed' &&
      (run.completedAt === undefined || run.snapshotVersion === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'A completed directory sync requires completion time and snapshot version.',
      });
    }
    if (run.status === 'failed' && (run.completedAt === undefined || run.errorCode === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'A failed directory sync requires completion time and a stable error code.',
      });
    }
  });

export const directorySyncViolationSchema = z
  .object({
    id: idSchema,
    syncRunId: idSchema,
    code: directorySyncViolationCodeSchema,
    entityType: z.enum(['user', 'group', 'membership']),
    entityId: z.string().trim().min(1).max(500),
    field: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(1_000),
    recordedAt: timestampSchema,
  })
  .strict();

export const sourceGroupSchema = z
  .object({
    id: idSchema,
    directorySourceId: idSchema,
    providerGroupId: z.string().trim().min(1).max(256),
    email: emailSchema,
    aliases: z.array(emailSchema).max(100),
    name: displayNameSchema,
    kind: z.enum(['access', 'unmanaged']),
    status: z.enum(['active', 'missing']),
    directMemberCount: z.int().nonnegative(),
    lastSyncRunId: idSchema,
    lastObservedAt: timestampSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const sourceGroupMembershipSchema = z
  .object({
    id: idSchema,
    sourceGroupId: idSchema,
    providerMembershipId: z.string().trim().min(1).max(256),
    memberType: z.enum(['user', 'group', 'external']),
    memberProviderId: z.string().trim().min(1).max(500),
    memberEmail: emailSchema.optional(),
    role: z.enum(['MEMBER', 'MANAGER', 'OWNER']),
    status: z.enum(['active', 'missing']),
    syncRunId: idSchema,
    observedAt: timestampSchema,
  })
  .strict();

export type DirectorySyncRun = z.infer<typeof directorySyncRunSchema>;
export type DirectorySyncViolation = z.infer<typeof directorySyncViolationSchema>;
export type SourceGroup = z.infer<typeof sourceGroupSchema>;
export type SourceGroupMembership = z.infer<typeof sourceGroupMembershipSchema>;
