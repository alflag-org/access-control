import { z } from 'zod';
import {
  displayNameSchema,
  httpsUrlSchema,
  idSchema,
  keySchema,
  revisionSchema,
  timestampSchema,
  uniqueValues,
} from './common';

const authenticationReferenceSchema = z.string().trim().min(1).max(500);

export const applicationAuthenticationSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('cloudflare_oidc'), reference: authenticationReferenceSchema })
    .strict(),
  z
    .object({ type: z.literal('cloudflare_saml'), reference: authenticationReferenceSchema })
    .strict(),
  z
    .object({ type: z.literal('cloudflare_self_hosted'), reference: authenticationReferenceSchema })
    .strict(),
  z
    .object({
      type: z.literal('direct_google'),
      reference: authenticationReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('none'), reference: authenticationReferenceSchema.optional() })
    .strict(),
]);

export const provisioningModeSchema = z.enum(['none', 'jit', 'observe', 'plan', 'automatic']);
export const reconciliationModeSchema = z.enum(['observe', 'plan', 'automatic']);

export const applicationSchema = z
  .object({
    id: idSchema,
    key: keySchema,
    name: displayNameSchema,
    description: z.string().trim().min(1).max(1_000).optional(),
    category: z.string().trim().min(1).max(100),
    launchUrl: httpsUrlSchema,
    icon: z
      .object({
        type: z.enum(['url', 'text']),
        value: z.string().trim().min(1).max(2048),
      })
      .strict()
      .optional(),
    status: z.enum(['active', 'disabled', 'retired']),
    visibility: z.enum(['entitled', 'all_active_subjects']),
    authentication: applicationAuthenticationSchema,
    provisioningMode: provisioningModeSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const applicationEntitlementSchema = z
  .object({
    id: idSchema,
    applicationId: idSchema,
    key: keySchema,
    name: displayNameSchema,
    description: z.string().trim().min(1).max(1_000).optional(),
    status: z.enum(['active', 'disabled', 'retired']),
    requiresProvisioning: z.boolean(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const entitlementMappingSchema = z
  .object({
    id: idSchema,
    sourceGroupId: idSchema,
    entitlementIds: z.array(idSchema).min(1).max(100),
    provisioningTargetIds: z.array(idSchema).max(100),
    status: z.enum(['draft', 'active', 'retired']),
    validFrom: timestampSchema.optional(),
    validUntil: timestampSchema.optional(),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict()
  .superRefine((mapping, context) => {
    if (!uniqueValues(mapping.entitlementIds)) {
      context.addIssue({
        code: 'custom',
        path: ['entitlementIds'],
        message: 'Entitlement identifiers must be unique.',
      });
    }
    if (!uniqueValues(mapping.provisioningTargetIds)) {
      context.addIssue({
        code: 'custom',
        path: ['provisioningTargetIds'],
        message: 'Provisioning target identifiers must be unique.',
      });
    }
    if (
      mapping.validFrom !== undefined &&
      mapping.validUntil !== undefined &&
      Date.parse(mapping.validUntil) <= Date.parse(mapping.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Mapping validity end must be after its start.',
      });
    }
  });

export const effectiveGrantSchema = z
  .object({
    id: idSchema,
    subjectId: idSchema,
    sourceGroupId: idSchema,
    sourceGroupMembershipId: idSchema,
    mappingId: idSchema,
    entitlementId: idSchema,
    status: z.enum(['active', 'expired', 'blocked']),
    calculatedAt: timestampSchema,
    validUntil: timestampSchema.optional(),
  })
  .strict();

export const mappingPreviewSchema = z
  .object({
    mappingId: idSchema,
    expectedRevision: revisionSchema,
    affectedSubjectIds: z.array(idSchema),
    grantCountBefore: z.int().nonnegative(),
    grantCountAfter: z.int().nonnegative(),
    calculatedAt: timestampSchema,
  })
  .strict();

export type Application = z.infer<typeof applicationSchema>;
export type ApplicationEntitlement = z.infer<typeof applicationEntitlementSchema>;
export type EntitlementMapping = z.infer<typeof entitlementMappingSchema>;
export type EffectiveGrant = z.infer<typeof effectiveGrantSchema>;
export type MappingPreview = z.infer<typeof mappingPreviewSchema>;
export type ReconciliationMode = z.infer<typeof reconciliationModeSchema>;
