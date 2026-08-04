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

export const posixAccountSchema = z
  .object({
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    uid: z.int().nonnegative(),
    primaryGid: z.int().nonnegative(),
    supplementalGroups: z.array(z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/)),
    sudoEntitlements: z.array(z.string().trim().min(1).max(500)),
    status: z.enum(['active', 'locked', 'absent']),
  })
  .strict();

export const posixSnapshotSchema = z.object({ accounts: z.array(posixAccountSchema) }).strict();

const desiredAccountSchema = z
  .object({
    username: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    status: z.enum(['present', 'absent']),
  })
  .strict();

const observedAccountSchema = z.object({ present: z.boolean() }).strict();

export interface PosixObservationTransport {
  observe(configuration: ObservationRequest['configuration']): Promise<unknown>;
}

export const POSIX_FIXTURE = posixSnapshotSchema.parse({
  accounts: [
    {
      username: 'example_user',
      uid: 20_001,
      primaryGid: 20_001,
      supplementalGroups: ['documentation'],
      sudoEntitlements: [],
      status: 'active',
    },
  ],
});

export class PosixObservationAdapter implements ProvisioningAdapter {
  public readonly provider = 'posix' as const;
  public readonly capabilities = [
    'username',
    'uid',
    'gid',
    'supplemental_groups',
    'sudo_entitlements',
    'status',
  ] as const;

  public constructor(
    private readonly transport: PosixObservationTransport,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async observe(inputValue: ObservationRequest) {
    const input = observationRequestSchema.parse(inputValue);
    const payload = posixSnapshotSchema.parse(await this.transport.observe(input.configuration));
    return observationResult(input, payload, this.now());
  }

  public async plan(inputValue: AuthoritativePlanContext) {
    const input = authoritativePlanContextSchema.parse(inputValue);
    if (
      input.providerConnection.provider !== 'posix' ||
      input.provisioningTarget.targetType !== 'posix_account'
    ) {
      throw new AccessControlError(
        422,
        'posix_target_unsupported',
        'Only POSIX account plans are supported in this milestone.',
      );
    }
    const account = input.providerAccount;
    if (account === undefined) {
      throw new AccessControlError(
        422,
        'posix_binding_missing',
        'A POSIX Provider Account is required.',
      );
    }
    const username = account.login ?? account.externalId;
    const snapshot = posixSnapshotSchema.parse(input.observation.payload);
    const desired = desiredAccountSchema.parse({
      username,
      status: input.requiredProvisioningTargets.some(
        (target) => target.id === input.provisioningTarget.id,
      )
        ? 'present'
        : 'absent',
    });
    const observed = observedAccountSchema.parse({
      present: snapshot.accounts.some(
        (candidate) => candidate.username === username && candidate.status !== 'absent',
      ),
    });
    const needsPresent = desired.status === 'present' && !observed.present;
    const needsAbsent = desired.status === 'absent' && observed.present;
    return providerPlanSchema.parse({
      changes:
        needsPresent || needsAbsent
          ? [
              {
                position: 0,
                action: needsPresent ? 'posix.account.present' : 'posix.account.absent',
                resource: desired.username,
                before: { present: observed.present },
                after: { present: needsPresent },
                destructive: needsAbsent,
                protected: needsAbsent,
                preconditions: ['posix_observation_current', 'allocation_reviewed'],
              },
            ]
          : [],
      destructive: needsAbsent,
      protected: needsAbsent,
    });
  }

  public async apply(_input: ApplyRequest): Promise<never> {
    throw new AccessControlError(
      409,
      'posix_allocation_not_implemented',
      'POSIX allocation and production writes are excluded from this milestone.',
    );
  }

  public async verify(input: VerifyRequest) {
    return this.observe(input.observation);
  }
}

async function observationResult(
  input: ObservationRequest,
  payload: z.infer<typeof posixSnapshotSchema>,
  observedAt: string,
) {
  return {
    id: `posix-observation:${crypto.randomUUID()}`,
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
