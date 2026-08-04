import { z } from 'zod';
import {
  applicationEntitlementSchema,
  applicationSchema,
  auditEventSchema,
  effectiveGrantSchema,
  entitlementMappingSchema,
  exportRecordSchema,
  externalIdentitySchema,
  guestProfileSchema,
  operationPlanChangeSchema,
  operationPlanSchema,
  organizationSettingsSchema,
  platformRoleGrantSchema,
  providerAccountSchema,
  providerConnectionSchema,
  provisioningStateSchema,
  provisioningTargetSchema,
  sha256Schema,
  sourceGroupMembershipSchema,
  sourceGroupSchema,
  subjectSchema,
  timestampSchema,
} from '@access-control/domain';

export const exportEntitiesSchema = z
  .object({
    organizationSettings: z.array(organizationSettingsSchema).max(1),
    subjects: z.array(subjectSchema),
    externalIdentities: z.array(externalIdentitySchema),
    guestProfiles: z.array(guestProfileSchema),
    platformRoleGrants: z.array(platformRoleGrantSchema),
    sourceGroups: z.array(sourceGroupSchema),
    sourceGroupMemberships: z.array(sourceGroupMembershipSchema),
    applications: z.array(applicationSchema),
    applicationEntitlements: z.array(applicationEntitlementSchema),
    entitlementMappings: z.array(entitlementMappingSchema),
    effectiveGrants: z.array(effectiveGrantSchema),
    providerConnections: z.array(providerConnectionSchema),
    providerAccounts: z.array(providerAccountSchema),
    provisioningTargets: z.array(provisioningTargetSchema),
    provisioningStates: z.array(provisioningStateSchema),
    operationPlans: z.array(operationPlanSchema),
    operationPlanChanges: z.array(operationPlanChangeSchema),
    auditEvents: z.array(auditEventSchema),
    exportRecords: z.array(exportRecordSchema),
  })
  .strict();

export const portableExportPayloadSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    generatedAt: timestampSchema,
    entities: exportEntitiesSchema,
  })
  .strict();

export const portableExportSchema = portableExportPayloadSchema
  .extend({
    checksum: sha256Schema,
  })
  .strict();

export type ExportEntities = z.infer<typeof exportEntitiesSchema>;
export type PortableExportPayload = z.infer<typeof portableExportPayloadSchema>;
export type PortableExport = z.infer<typeof portableExportSchema>;
