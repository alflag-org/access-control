import { z } from 'zod';
import {
  authoritativePlanContextSchema,
  observationRequestSchema,
  providerPlanSchema,
  type ApplyRequest,
  type AuthoritativePlanContext,
  type ObservationRequest,
  type ProvisioningAdapter,
  type VerifyRequest,
} from '@access-control/contracts';
import { AccessControlError, canonicalJson, jsonValueSchema } from '@access-control/domain';

export const zabbixSamlJitMappingSchema = z
  .object({
    mappingId: z.string().trim().min(1).max(256),
    groupPattern: z.string().trim().min(1).max(500),
    userGroupIds: z.array(z.string().trim().min(1).max(256)),
    roleId: z.string().trim().min(1).max(256),
  })
  .strict();

export const zabbixScimUserSchema = z
  .object({
    userId: z.string().trim().min(1).max(256),
    userName: z.string().trim().min(1).max(320),
    active: z.boolean(),
  })
  .strict();

export const zabbixScimGroupMembershipSchema = z
  .object({
    groupId: z.string().trim().min(1).max(256),
    userId: z.string().trim().min(1).max(256),
    active: z.boolean(),
  })
  .strict();

export const zabbixDeprovisionedGroupSchema = z
  .object({
    groupId: z.string().trim().min(1).max(256),
    deprovisioned: z.boolean(),
  })
  .strict();

export const zabbixSnapshotSchema = z
  .object({
    samlJitMappings: z.array(zabbixSamlJitMappingSchema),
    scimUsers: z.array(zabbixScimUserSchema),
    scimGroupMemberships: z.array(zabbixScimGroupMembershipSchema),
    deprovisionedGroups: z.array(zabbixDeprovisionedGroupSchema),
  })
  .strict();

const desiredMappingSchema = z
  .object({
    mappingId: z.string().trim().min(1).max(256),
    membership: z.enum(['present', 'absent']),
  })
  .strict();

const observedMappingSchema = z.object({ present: z.boolean() }).strict();

export interface ZabbixObservationTransport {
  observe(configuration: ObservationRequest['configuration']): Promise<unknown>;
}

export const ZABBIX_FIXTURE = zabbixSnapshotSchema.parse({
  samlJitMappings: [
    {
      mappingId: 'monitoring-users',
      groupPattern: 'access.zabbix.user@example.org',
      userGroupIds: ['13'],
      roleId: '2',
    },
  ],
  scimUsers: [{ userId: 'user-1001', userName: 'observer@example.org', active: true }],
  scimGroupMemberships: [{ groupId: '13', userId: 'user-1001', active: true }],
  deprovisionedGroups: [{ groupId: 'retired-contractors', deprovisioned: true }],
});

export class ZabbixObservationAdapter implements ProvisioningAdapter {
  public readonly provider = 'zabbix' as const;
  public readonly capabilities = [
    'saml_jit_mapping',
    'scim_user',
    'scim_group_membership',
    'deprovisioned_group',
  ] as const;

  public constructor(
    private readonly transport: ZabbixObservationTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async observe(inputValue: ObservationRequest) {
    const input = observationRequestSchema.parse(inputValue);
    const payload = zabbixSnapshotSchema.parse(await this.transport.observe(input.configuration));
    return observationResult(input, payload, this.now());
  }

  public async plan(inputValue: AuthoritativePlanContext) {
    const input = authoritativePlanContextSchema.parse(inputValue);
    if (
      input.providerConnection.provider !== 'zabbix' ||
      input.provisioningTarget.targetType !== 'zabbix_saml_mapping'
    ) {
      throw new AccessControlError(
        422,
        'zabbix_target_unsupported',
        'Only Zabbix SAML mapping plans are supported in this milestone.',
      );
    }
    const mappingId = input.provisioningTarget.providerTargetId;
    const snapshot = zabbixSnapshotSchema.parse(input.observation.payload);
    const desired = desiredMappingSchema.parse({
      mappingId,
      membership: input.requiredProvisioningTargets.some(
        (target) => target.id === input.provisioningTarget.id,
      )
        ? 'present'
        : 'absent',
    });
    const observed = observedMappingSchema.parse({
      present: snapshot.samlJitMappings.some((mapping) => mapping.mappingId === mappingId),
    });
    const needsAdd = desired.membership === 'present' && !observed.present;
    const needsRemove = desired.membership === 'absent' && observed.present;
    return providerPlanSchema.parse({
      changes:
        needsAdd || needsRemove
          ? [
              {
                position: 0,
                action: needsAdd ? 'zabbix.mapping.add' : 'zabbix.mapping.remove',
                resource: desired.mappingId,
                before: { present: observed.present },
                after: { present: needsAdd },
                destructive: needsRemove,
                protected: false,
                preconditions: ['zabbix_observation_current'],
              },
            ]
          : [],
      destructive: needsRemove,
      protected: false,
    });
  }

  public async apply(_input: ApplyRequest): Promise<never> {
    throw new AccessControlError(
      409,
      'zabbix_writes_not_implemented',
      'Zabbix production writes are excluded from this milestone.',
    );
  }

  public async verify(input: VerifyRequest) {
    return this.observe(input.observation);
  }
}

async function observationResult(
  input: ObservationRequest,
  payload: z.infer<typeof zabbixSnapshotSchema>,
  observedAt: string,
) {
  return {
    id: `zabbix-observation:${crypto.randomUUID()}`,
    providerConnectionId: input.providerConnectionId,
    provisioningTargetId: input.provisioningTargetId,
    status: 'complete' as const,
    observedAt,
    payload,
    checksum: await sha256(canonicalJson(jsonValueSchema.parse(payload))),
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
