import { z } from 'zod';
import {
  bindingReferenceSchema,
  displayNameSchema,
  idSchema,
  jsonObjectSchema,
  jsonValueSchema,
  revisionSchema,
  sha256Schema,
  timestampSchema,
  uniqueValues,
} from './common';
import { reconciliationModeSchema } from './catalog';

export const providerSchema = z.enum(['google', 'github', 'proxmox', 'zabbix', 'posix']);
export const githubProviderConfigurationSchema = z
  .object({
    organization: z.string().trim().min(1).max(100),
    teamSlugs: z.array(z.string().trim().min(1).max(256)).max(100).default([]),
  })
  .strict();
const emptyProviderConfigurationSchema = z.object({}).strict();
export const providerConfigurationSchemas = {
  google: emptyProviderConfigurationSchema,
  github: githubProviderConfigurationSchema,
  proxmox: emptyProviderConfigurationSchema,
  zabbix: emptyProviderConfigurationSchema,
  posix: emptyProviderConfigurationSchema,
} as const;
export const provisioningTargetConfigurationSchema = z
  .object({ requiresLock: z.boolean().optional() })
  .strict();
export const provisioningStatusSchema = z.enum([
  'unmanaged',
  'pending',
  'observed',
  'planned',
  'applying',
  'verifying',
  'converged',
  'blocked',
  'failed',
  'drifted',
  'waiting_for_login',
  'waiting_for_invitation',
  'action_required',
  'expired',
]);

export const providerConnectionSchema = z
  .object({
    id: idSchema,
    provider: providerSchema,
    name: displayNameSchema,
    mode: reconciliationModeSchema,
    credentialRef: bindingReferenceSchema.optional(),
    configuration: jsonObjectSchema,
    status: z.enum(['active', 'disabled', 'retired']),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const providerAccountSchema = z
  .object({
    id: idSchema,
    providerConnectionId: idSchema,
    subjectId: idSchema.optional(),
    externalId: z.string().trim().min(1).max(500),
    login: z.string().trim().min(1).max(256).optional(),
    displayName: displayNameSchema.optional(),
    status: z.enum(['active', 'pending_invitation', 'suspended', 'missing']),
    observedAt: timestampSchema,
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const provisioningTargetSchema = z
  .object({
    id: idSchema,
    providerConnectionId: idSchema,
    applicationEntitlementId: idSchema,
    targetType: z.enum([
      'github_organization_membership',
      'github_team_membership',
      'proxmox_group_membership',
      'zabbix_saml_mapping',
      'zabbix_scim_membership',
      'posix_account',
      'posix_group_membership',
      'posix_sudo',
    ]),
    providerTargetId: z.string().trim().min(1).max(500),
    mode: reconciliationModeSchema,
    protected: z.boolean(),
    configuration: jsonObjectSchema,
    status: z.enum(['active', 'disabled', 'retired']),
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export const provisioningStateSchema = z
  .object({
    id: idSchema,
    provisioningTargetId: idSchema,
    subjectId: idSchema,
    desiredState: z.enum(['present', 'absent']),
    observedState: z.enum(['unknown', 'present', 'absent']),
    status: provisioningStatusSchema,
    lastObservationId: idSchema.optional(),
    lastPlanId: idSchema.optional(),
    evidence: jsonObjectSchema,
    revision: revisionSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const providerObservationSchema = z
  .object({
    id: idSchema,
    providerConnectionId: idSchema,
    provisioningTargetId: idSchema.optional(),
    status: z.enum(['complete', 'failed']),
    observedAt: timestampSchema,
    payload: jsonObjectSchema.optional(),
    payloadRef: z.string().trim().min(1).max(1_000).optional(),
    checksum: sha256Schema,
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.payload === undefined && observation.payloadRef === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['payload'],
        message: 'Provider observation requires an inline payload or archived payload reference.',
      });
    }
    if (observation.status === 'failed' && observation.errorCode === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'Failed provider observations require a stable error code.',
      });
    }
  });

export const operationPlanSchema = z
  .object({
    id: idSchema,
    providerConnectionId: idSchema,
    provisioningTargetId: idSchema,
    provisioningStateId: idSchema,
    subjectId: idSchema,
    entitlementId: idSchema,
    observationId: idSchema,
    observationChecksum: sha256Schema,
    effectiveGrantIds: z.array(idSchema).max(10_000),
    requiredProvisioningTargetIds: z.array(idSchema).max(10_000),
    planHash: sha256Schema,
    destructive: z.boolean(),
    protected: z.boolean(),
    inputRevisions: z.record(
      z
        .string()
        .min(3)
        .max(256)
        .regex(/^[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]*$/),
      revisionSchema,
    ),
    status: z.enum(['persisted', 'superseded']),
    createdBy: idSchema,
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (!uniqueValues(plan.effectiveGrantIds)) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveGrantIds'],
        message: 'Effective Grant identifiers must be unique.',
      });
    }
    if (!uniqueValues(plan.requiredProvisioningTargetIds)) {
      context.addIssue({
        code: 'custom',
        path: ['requiredProvisioningTargetIds'],
        message: 'Required Provisioning Target identifiers must be unique.',
      });
    }
  });

export const operationPlanChangeSchema = z
  .object({
    id: idSchema,
    operationPlanId: idSchema,
    position: z.int().nonnegative(),
    action: z.enum([
      'github.organization.invite',
      'github.organization.remove',
      'github.team.add',
      'github.team.remove',
      'proxmox.membership.add',
      'proxmox.membership.remove',
      'zabbix.mapping.add',
      'zabbix.mapping.remove',
      'posix.account.present',
      'posix.account.absent',
    ]),
    resource: z.string().trim().min(1).max(500),
    before: jsonValueSchema,
    after: jsonValueSchema,
    destructive: z.boolean(),
    protected: z.boolean(),
    preconditions: z.array(z.string().trim().min(1).max(500)).max(100),
  })
  .strict();

export const operationSchema = z
  .object({
    id: idSchema,
    operationPlanId: idSchema,
    status: z.enum([
      'planned',
      'running',
      'applying',
      'verifying',
      'waiting_for_invitation',
      'action_required',
      'completed',
      'failed',
      'cancelled',
      'blocked',
    ]),
    explicit: z.boolean(),
    revision: revisionSchema,
    createdBy: idSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      [
        'running',
        'applying',
        'verifying',
        'waiting_for_invitation',
        'action_required',
        'completed',
        'failed',
      ].includes(operation.status) &&
      operation.startedAt === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'Started operations require a start time.',
      });
    }
    if (
      ['completed', 'failed', 'cancelled'].includes(operation.status) &&
      operation.completedAt === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Terminal operations require a completion time.',
      });
    }
  });

export const operationStepSchema = z
  .object({
    id: idSchema,
    operationId: idSchema,
    position: z.int().nonnegative(),
    name: displayNameSchema,
    status: z.enum(['planned', 'running', 'completed', 'failed', 'blocked', 'skipped']),
    evidence: jsonObjectSchema,
    revision: revisionSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const lockSchema = z
  .object({
    id: idSchema,
    key: z.string().trim().min(1).max(500),
    operationId: idSchema,
    fencingToken: z.int().positive(),
    acquiredAt: timestampSchema,
    expiresAt: timestampSchema,
    releasedAt: timestampSchema.optional(),
  })
  .strict()
  .refine((lock) => Date.parse(lock.expiresAt) > Date.parse(lock.acquiredAt), {
    path: ['expiresAt'],
    message: 'Lock expiration must be after acquisition.',
  });

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProvisioningTarget = z.infer<typeof provisioningTargetSchema>;
export type ProvisioningState = z.infer<typeof provisioningStateSchema>;
export type ProviderObservation = z.infer<typeof providerObservationSchema>;
export type OperationPlan = z.infer<typeof operationPlanSchema>;
export type OperationPlanChange = z.infer<typeof operationPlanChangeSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type OperationStep = z.infer<typeof operationStepSchema>;
export type Lock = z.infer<typeof lockSchema>;
