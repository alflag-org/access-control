import { z } from 'zod';
import {
  applicationEntitlementSchema,
  effectiveGrantSchema,
  idSchema,
  jsonObjectSchema,
  operationPlanChangeSchema,
  organizationSettingsSchema,
  providerAccountSchema,
  providerConnectionSchema,
  providerObservationSchema,
  provisioningStateSchema,
  provisioningTargetSchema,
  sha256Schema,
  subjectSchema,
  timestampSchema,
} from '@access-control/domain';

export const observationRequestSchema = z
  .object({
    providerConnectionId: idSchema,
    provisioningTargetId: idSchema,
    configuration: jsonObjectSchema,
  })
  .strict();

export const authoritativePlanContextSchema = z
  .object({
    evaluatedAt: timestampSchema,
    organizationSettings: organizationSettingsSchema,
    subject: subjectSchema,
    entitlement: applicationEntitlementSchema,
    providerConnection: providerConnectionSchema,
    provisioningTarget: provisioningTargetSchema,
    provisioningState: provisioningStateSchema,
    providerAccount: providerAccountSchema.optional(),
    effectiveGrants: z.array(effectiveGrantSchema).max(10_000),
    requiredProvisioningTargets: z.array(provisioningTargetSchema).max(10_000),
    observation: providerObservationSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.provisioningTarget.providerConnectionId !== input.providerConnection.id) {
      context.addIssue({
        code: 'custom',
        path: ['provisioningTarget', 'providerConnectionId'],
        message: 'Provisioning Target must belong to the Provider Connection.',
      });
    }
    if (input.provisioningTarget.applicationEntitlementId !== input.entitlement.id) {
      context.addIssue({
        code: 'custom',
        path: ['provisioningTarget', 'applicationEntitlementId'],
        message: 'Provisioning Target must belong to the Application Entitlement.',
      });
    }
    if (
      input.provisioningState.provisioningTargetId !== input.provisioningTarget.id ||
      input.provisioningState.subjectId !== input.subject.id
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provisioningState'],
        message: 'Provisioning State must match the Subject and Provisioning Target.',
      });
    }
    if (
      input.providerAccount !== undefined &&
      (input.providerAccount.providerConnectionId !== input.providerConnection.id ||
        input.providerAccount.subjectId !== input.subject.id)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['providerAccount'],
        message: 'Provider Account must match the Subject and Provider Connection.',
      });
    }
    if (
      input.observation.providerConnectionId !== input.providerConnection.id ||
      input.observation.provisioningTargetId !== input.provisioningTarget.id ||
      input.observation.status !== 'complete' ||
      input.observation.payload === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observation'],
        message: 'A complete inline observation for the Provisioning Target is required.',
      });
    }
    if (
      input.effectiveGrants.some(
        (grant) => grant.subjectId !== input.subject.id || grant.status !== 'active',
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['effectiveGrants'],
        message: 'Effective Grants must be active and belong to the Subject.',
      });
    }
  });

export const providerPlanSchema = z
  .object({
    changes: z.array(operationPlanChangeSchema.omit({ id: true, operationPlanId: true })),
    destructive: z.boolean(),
    protected: z.boolean(),
    blockedReason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const applyRequestSchema = z
  .object({
    operationId: idSchema,
    operationPlanId: idSchema,
    planHash: sha256Schema,
    persistedPlanHash: sha256Schema,
    operationStatus: z.literal('applying'),
    connectionMode: z.enum(['plan', 'automatic']),
    writesEnabled: z.boolean(),
    change: operationPlanChangeSchema,
    fencingToken: z.int().positive().optional(),
    lockExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const applyResultSchema = z
  .object({
    status: z.enum(['applied', 'waiting_for_invitation', 'blocked']),
    evidence: jsonObjectSchema,
  })
  .strict();

export const verifyRequestSchema = z
  .object({
    operationId: idSchema,
    operationPlanId: idSchema,
    planHash: sha256Schema,
    observation: observationRequestSchema,
  })
  .strict();

export type ObservationRequest = z.infer<typeof observationRequestSchema>;
export type AuthoritativePlanContext = z.infer<typeof authoritativePlanContextSchema>;
export type ProviderPlan = z.infer<typeof providerPlanSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
export type ApplyResult = z.infer<typeof applyResultSchema>;
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

export interface ProvisioningAdapter {
  readonly provider: 'github' | 'proxmox' | 'zabbix' | 'posix';
  readonly capabilities: readonly string[];
  observe(input: ObservationRequest): Promise<z.input<typeof providerObservationSchema>>;
  plan(input: AuthoritativePlanContext): Promise<ProviderPlan>;
  apply(input: ApplyRequest): Promise<ApplyResult>;
  verify(input: VerifyRequest): Promise<z.input<typeof providerObservationSchema>>;
}
