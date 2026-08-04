import { canonicalJson, type JsonObject, type OperationPlanChange } from '@access-control/domain';

export interface OperationPlanHashInput {
  providerConnectionId: string;
  provisioningTargetId: string;
  provisioningStateId: string;
  subjectId: string;
  entitlementId: string;
  observationId: string;
  observationChecksum: string;
  effectiveGrantIds: string[];
  requiredProvisioningTargetIds: string[];
  inputRevisions: Record<string, number>;
  changes: OperationPlanChange[];
}

export async function calculateOperationPlanHash(input: OperationPlanHashInput): Promise<string> {
  const payload: JsonObject = {
    providerConnectionId: input.providerConnectionId,
    provisioningTargetId: input.provisioningTargetId,
    provisioningStateId: input.provisioningStateId,
    subjectId: input.subjectId,
    entitlementId: input.entitlementId,
    observationId: input.observationId,
    observationChecksum: input.observationChecksum,
    effectiveGrantIds: [...input.effectiveGrantIds].sort(),
    requiredProvisioningTargetIds: [...input.requiredProvisioningTargetIds].sort(),
    inputRevisions: input.inputRevisions,
    changes: [...input.changes]
      .sort((left, right) => left.position - right.position)
      .map((change) => ({
        position: change.position,
        action: change.action,
        resource: change.resource,
        before: change.before,
        after: change.after,
        destructive: change.destructive,
        protected: change.protected,
        preconditions: change.preconditions,
      })),
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(payload)),
  );
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hexadecimal}`;
}
