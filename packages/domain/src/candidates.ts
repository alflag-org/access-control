import type { z } from 'zod';
import {
  applicationEntitlementSchema,
  applicationSchema,
  effectiveGrantSchema,
  entitlementMappingSchema,
} from './catalog';
import {
  directorySyncRunSchema,
  directorySyncViolationSchema,
  sourceGroupMembershipSchema,
  sourceGroupSchema,
} from './directory';
import { auditEventSchema, exportRecordSchema, outboxRecordSchema } from './events';
import {
  directorySourceSchema,
  externalIdentitySchema,
  guestProfileSchema,
  organizationSettingsSchema,
  platformRoleGrantSchema,
  subjectSchema,
} from './identity';
import {
  lockSchema,
  operationPlanChangeSchema,
  operationPlanSchema,
  operationSchema,
  operationStepSchema,
  providerAccountSchema,
  providerConnectionSchema,
  providerObservationSchema,
  provisioningStateSchema,
  provisioningTargetSchema,
} from './provisioning';

function candidateBuilder<Schema extends z.ZodType>(schema: Schema) {
  return (input: z.input<Schema>): z.output<Schema> => schema.parse(input);
}

export const createOrganizationSettingsCandidate = candidateBuilder(organizationSettingsSchema);
export const createSubjectCandidate = candidateBuilder(subjectSchema);
export const createExternalIdentityCandidate = candidateBuilder(externalIdentitySchema);
export const createGuestProfileCandidate = candidateBuilder(guestProfileSchema);
export const createPlatformRoleGrantCandidate = candidateBuilder(platformRoleGrantSchema);
export const createDirectorySourceCandidate = candidateBuilder(directorySourceSchema);
export const createDirectorySyncRunCandidate = candidateBuilder(directorySyncRunSchema);
export const createDirectorySyncViolationCandidate = candidateBuilder(directorySyncViolationSchema);
export const createSourceGroupCandidate = candidateBuilder(sourceGroupSchema);
export const createSourceGroupMembershipCandidate = candidateBuilder(sourceGroupMembershipSchema);
export const createApplicationCandidate = candidateBuilder(applicationSchema);
export const createApplicationEntitlementCandidate = candidateBuilder(applicationEntitlementSchema);
export const createEntitlementMappingCandidate = candidateBuilder(entitlementMappingSchema);
export const createEffectiveGrantCandidate = candidateBuilder(effectiveGrantSchema);
export const createProviderConnectionCandidate = candidateBuilder(providerConnectionSchema);
export const createProviderAccountCandidate = candidateBuilder(providerAccountSchema);
export const createProvisioningTargetCandidate = candidateBuilder(provisioningTargetSchema);
export const createProvisioningStateCandidate = candidateBuilder(provisioningStateSchema);
export const createProviderObservationCandidate = candidateBuilder(providerObservationSchema);
export const createOperationPlanCandidate = candidateBuilder(operationPlanSchema);
export const createOperationPlanChangeCandidate = candidateBuilder(operationPlanChangeSchema);
export const createOperationCandidate = candidateBuilder(operationSchema);
export const createOperationStepCandidate = candidateBuilder(operationStepSchema);
export const createLockCandidate = candidateBuilder(lockSchema);
export const createAuditEventCandidate = candidateBuilder(auditEventSchema);
export const createOutboxRecordCandidate = candidateBuilder(outboxRecordSchema);
export const createExportRecordCandidate = candidateBuilder(exportRecordSchema);
