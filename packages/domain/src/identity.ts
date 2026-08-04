import { z } from 'zod';
import {
  bindingReferenceSchema,
  displayNameSchema,
  emailSchema,
  httpsUrlSchema,
  idSchema,
  nonEmptyTextSchema,
  revisionSchema,
  timestampSchema,
} from './common';

export const subjectKindSchema = z.enum(['human', 'service', 'workload']);
export const subjectClassificationSchema = z.enum([
  'member',
  'managed_guest',
  'external_guest',
  'service_account',
  'automation',
]);
export const subjectStatusSchema = z.enum(['pending', 'active', 'suspended', 'retired']);
export const directoryStateSchema = z.enum(['pending', 'active', 'suspended', 'missing']);
export const externalIdentityStatusSchema = z.enum(['pending', 'active', 'disabled', 'missing']);
export const platformRoleSchema = z.enum(['admin', 'operator', 'auditor']);
export const guestStatusSchema = z.enum(['pending', 'active', 'suspended', 'expired', 'retired']);

export const organizationSettingsSchema = z
  .object({
    id: idSchema,
    organizationName: displayNameSchema,
    title: displayNameSchema,
    supportUrl: httpsUrlSchema.optional(),
    brandMarkUrl: httpsUrlSchema.optional(),
    maxPlanChanges: z.int().min(1).max(10_000),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const subjectSchema = z
  .object({
    id: idSchema,
    kind: subjectKindSchema,
    classification: subjectClassificationSchema,
    displayName: displayNameSchema,
    primaryEmail: emailSchema.optional(),
    status: subjectStatusSchema,
    directoryState: directoryStateSchema,
    protected: z.boolean(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict()
  .superRefine((subject, context) => {
    if (
      subject.kind !== 'human' &&
      ['member', 'managed_guest', 'external_guest'].includes(subject.classification)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'Human classifications require kind human.',
      });
    }
    if (
      subject.kind === 'human' &&
      ['service_account', 'automation'].includes(subject.classification)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'Service classifications require a non-human Subject kind.',
      });
    }
  });

export const externalIdentitySchema = z
  .object({
    id: idSchema,
    subjectId: idSchema,
    provider: z.enum(['cloudflare_access', 'google', 'github', 'proxmox', 'zabbix', 'posix']),
    issuer: z.string().trim().min(1).max(500),
    providerSubject: z.string().trim().min(1).max(500),
    displayName: displayNameSchema.optional(),
    email: emailSchema.optional(),
    status: externalIdentityStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const guestProfileSchema = z
  .object({
    subjectId: idSchema,
    sponsorSubjectId: idSchema,
    externalContactEmail: emailSchema,
    externalOrganization: displayNameSchema,
    purpose: nonEmptyTextSchema,
    validFrom: timestampSchema,
    expiresAt: timestampSchema,
    nextReviewAt: timestampSchema.optional(),
    status: guestStatusSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict()
  .superRefine((guest, context) => {
    if (guest.subjectId === guest.sponsorSubjectId) {
      context.addIssue({
        code: 'custom',
        path: ['sponsorSubjectId'],
        message: 'A managed guest cannot sponsor itself.',
      });
    }
    if (Date.parse(guest.expiresAt) <= Date.parse(guest.validFrom)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Guest expiration must be after the valid-from time.',
      });
    }
  });

export const platformRoleGrantSchema = z
  .object({
    id: idSchema,
    subjectId: idSchema,
    role: platformRoleSchema,
    active: z.boolean(),
    protected: z.boolean(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const directorySourceSchema = z
  .object({
    id: idSchema,
    provider: z.literal('google'),
    customerId: z.string().trim().min(1).max(128),
    delegatedAdmin: emailSchema,
    credentialRef: bindingReferenceSchema,
    accessGroupPrefix: z.string().trim().min(1).max(100),
    status: z.enum(['active', 'disabled', 'retired']),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export type Subject = z.infer<typeof subjectSchema>;
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export type GuestProfile = z.infer<typeof guestProfileSchema>;
export type PlatformRoleGrant = z.infer<typeof platformRoleGrantSchema>;
export type PlatformRole = z.infer<typeof platformRoleSchema>;
export type DirectorySource = z.infer<typeof directorySourceSchema>;
