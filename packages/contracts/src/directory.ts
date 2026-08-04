import { z } from 'zod';
import { emailSchema, idSchema, sha256Schema, timestampSchema } from '@access-control/domain';

export const observedDirectoryUserSchema = z
  .object({
    immutableId: z.string().trim().min(1).max(256),
    primaryEmail: emailSchema,
    aliases: z.array(emailSchema).max(100),
    displayName: z.string().trim().min(1).max(160),
    suspended: z.boolean(),
    lifecycle: z.enum(['active', 'deleted']),
  })
  .strict();

export const observedDirectoryGroupSchema = z
  .object({
    immutableId: z.string().trim().min(1).max(256),
    email: emailSchema,
    aliases: z.array(emailSchema).max(100),
    name: z.string().trim().min(1).max(160),
    lifecycle: z.enum(['active', 'deleted']),
  })
  .strict();

export const observedDirectoryMembershipSchema = z
  .object({
    immutableId: z.string().trim().min(1).max(256),
    groupImmutableId: z.string().trim().min(1).max(256),
    memberImmutableId: z.string().trim().min(1).max(500),
    memberEmail: emailSchema.optional(),
    memberType: z.enum(['user', 'group', 'external']),
    role: z.enum(['MEMBER', 'MANAGER', 'OWNER']),
  })
  .strict();

export const directorySnapshotSchema = z
  .object({
    directorySourceId: idSchema,
    observedAt: timestampSchema,
    snapshotVersion: sha256Schema,
    users: z.array(observedDirectoryUserSchema).max(100_000),
    groups: z.array(observedDirectoryGroupSchema).max(50_000),
    memberships: z.array(observedDirectoryMembershipSchema).max(500_000),
  })
  .strict();

export const directoryObservationRequestSchema = z
  .object({
    directorySourceId: idSchema,
    customerId: z.string().trim().min(1).max(128),
    delegatedAdmin: emailSchema,
    credentialRef: z.string().trim().min(1).max(128),
    accessGroupPrefix: z.string().trim().min(1).max(100),
  })
  .strict();

export type ObservedDirectoryUser = z.infer<typeof observedDirectoryUserSchema>;
export type ObservedDirectoryGroup = z.infer<typeof observedDirectoryGroupSchema>;
export type ObservedDirectoryMembership = z.infer<typeof observedDirectoryMembershipSchema>;
export type DirectorySnapshot = z.infer<typeof directorySnapshotSchema>;
export type DirectoryObservationRequest = z.infer<typeof directoryObservationRequestSchema>;

export interface DirectoryAdapter {
  observeDirectory(input: DirectoryObservationRequest): Promise<DirectorySnapshot>;
}
