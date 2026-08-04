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

export const proxmoxRealmUserSchema = z
  .object({
    userId: z.string().trim().min(1).max(256),
    realm: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
  })
  .strict();

export const proxmoxGroupSchema = z
  .object({
    groupId: z.string().trim().min(1).max(256),
    comment: z.string().trim().max(500).optional(),
  })
  .strict();

export const proxmoxMembershipSchema = z
  .object({
    groupId: z.string().trim().min(1).max(256),
    userId: z.string().trim().min(1).max(256),
  })
  .strict();

export const proxmoxRoleSchema = z
  .object({
    roleId: z.string().trim().min(1).max(256),
    privileges: z.array(z.string().trim().min(1).max(256)),
  })
  .strict();

export const proxmoxAclSchema = z
  .object({
    path: z.string().trim().min(1).max(1_000),
    principalType: z.enum(['user', 'group']),
    principalId: z.string().trim().min(1).max(256),
    roleId: z.string().trim().min(1).max(256),
    propagate: z.boolean(),
  })
  .strict();

export const proxmoxSnapshotSchema = z
  .object({
    users: z.array(proxmoxRealmUserSchema),
    groups: z.array(proxmoxGroupSchema),
    memberships: z.array(proxmoxMembershipSchema),
    roles: z.array(proxmoxRoleSchema),
    acls: z.array(proxmoxAclSchema),
  })
  .strict();

const desiredMembershipSchema = z
  .object({
    userId: z.string().trim().min(1).max(256),
    groupId: z.string().trim().min(1).max(256),
    membership: z.enum(['present', 'absent']),
  })
  .strict();

const observedMembershipSchema = z.object({ present: z.boolean() }).strict();

export interface ProxmoxObservationTransport {
  observe(configuration: ObservationRequest['configuration']): Promise<unknown>;
}

export const PROXMOX_FIXTURE = proxmoxSnapshotSchema.parse({
  users: [{ userId: 'auditor@example', realm: 'example', enabled: true }],
  groups: [{ groupId: 'auditors', comment: 'Read-only virtualization access' }],
  memberships: [],
  roles: [{ roleId: 'PVEAuditor', privileges: ['Sys.Audit', 'VM.Audit'] }],
  acls: [
    {
      path: '/',
      principalType: 'group',
      principalId: 'auditors',
      roleId: 'PVEAuditor',
      propagate: true,
    },
  ],
});

export class ProxmoxObservationAdapter implements ProvisioningAdapter {
  public readonly provider = 'proxmox' as const;
  public readonly capabilities = ['realm_user', 'group', 'membership', 'role', 'acl'] as const;

  public constructor(
    private readonly transport: ProxmoxObservationTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async observe(inputValue: ObservationRequest) {
    const input = observationRequestSchema.parse(inputValue);
    const payload = proxmoxSnapshotSchema.parse(await this.transport.observe(input.configuration));
    return observationResult(input, payload, this.now());
  }

  public async plan(inputValue: AuthoritativePlanContext) {
    const input = authoritativePlanContextSchema.parse(inputValue);
    if (
      input.providerConnection.provider !== 'proxmox' ||
      input.provisioningTarget.targetType !== 'proxmox_group_membership'
    ) {
      throw new AccessControlError(
        422,
        'proxmox_target_unsupported',
        'The Provisioning Target is not supported by the Proxmox adapter.',
      );
    }
    const account = input.providerAccount;
    if (account === undefined) {
      throw new AccessControlError(
        422,
        'proxmox_binding_missing',
        'A Proxmox Provider Account is required.',
      );
    }
    const userId = account.login ?? account.externalId;
    const groupId = input.provisioningTarget.providerTargetId;
    const snapshot = proxmoxSnapshotSchema.parse(input.observation.payload);
    const desired = desiredMembershipSchema.parse({
      userId,
      groupId,
      membership: input.requiredProvisioningTargets.some(
        (target) => target.id === input.provisioningTarget.id,
      )
        ? 'present'
        : 'absent',
    });
    const observed = observedMembershipSchema.parse({
      present: snapshot.memberships.some(
        (membership) => membership.userId === userId && membership.groupId === groupId,
      ),
    });
    const needsAdd = desired.membership === 'present' && !observed.present;
    const needsRemove = desired.membership === 'absent' && observed.present;
    return providerPlanSchema.parse({
      changes:
        needsAdd || needsRemove
          ? [
              {
                position: 0,
                action: needsAdd ? 'proxmox.membership.add' : 'proxmox.membership.remove',
                resource: `${desired.groupId}:${desired.userId}`,
                before: { present: observed.present },
                after: { present: needsAdd },
                destructive: needsRemove,
                protected: false,
                preconditions: ['proxmox_observation_current'],
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
      'proxmox_writes_not_implemented',
      'Proxmox production writes are excluded from this milestone.',
    );
  }

  public async verify(input: VerifyRequest) {
    return this.observe(input.observation);
  }
}

async function observationResult(
  input: ObservationRequest,
  payload: z.infer<typeof proxmoxSnapshotSchema>,
  observedAt: string,
) {
  return {
    id: `proxmox-observation:${crypto.randomUUID()}`,
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
