import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiRoutes } from '../../apps/worker/src/api/route-contracts';

describe('Server-authoritative provisioning plan contract', () => {
  it('accepts only a provisioning state and its expected revision', () => {
    const schema = requestBodySchema(apiRoutes.createOperationPlan.definition);

    expect(
      schema.safeParse({ provisioningStateId: 'state:github-member', expectedRevision: 3 }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        providerConnectionId: 'provider:github',
        provisioningTargetId: 'target:github-member',
        subjectId: 'subject:member',
        entitlementId: 'entitlement:github-member',
        provisioningStateId: 'state:github-member',
        desired: { organizationMembership: 'absent', activeOwnerCount: 100 },
        observed: { organizationMembership: 'active', activeOwnerCount: 100 },
        inputRevisions: { 'state:github-member': 3 },
        expectedStateRevision: 3,
        maxPlanChanges: 10_000,
      }).success,
    ).toBe(false);
  });

  it('does not accept a caller-selected execution threshold', () => {
    const schema = requestBodySchema(apiRoutes.executeOperation.definition);

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ maxPlanChanges: 10_000 }).success).toBe(false);
  });
});

function requestBodySchema(definition: unknown): z.ZodType {
  return z
    .object({
      request: z.object({
        body: z.object({
          content: z.object({
            'application/json': z.object({ schema: z.custom<z.ZodType>() }),
          }),
        }),
      }),
    })
    .passthrough()
    .parse(definition).request.body.content['application/json'].schema;
}
