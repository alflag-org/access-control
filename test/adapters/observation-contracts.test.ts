import { describe, expect, it } from 'vitest';
import {
  PROXMOX_FIXTURE,
  ProxmoxObservationAdapter,
  proxmoxSnapshotSchema,
} from '@access-control/proxmox';
import {
  ZABBIX_FIXTURE,
  ZabbixObservationAdapter,
  zabbixSnapshotSchema,
} from '@access-control/zabbix';
import { POSIX_FIXTURE, PosixObservationAdapter, posixSnapshotSchema } from '@access-control/posix';
import type { AuthoritativePlanContext } from '@access-control/contracts';
import {
  createApplicationEntitlementCandidate,
  createEffectiveGrantCandidate,
  createOrganizationSettingsCandidate,
  createProviderAccountCandidate,
  createProviderConnectionCandidate,
  createProviderObservationCandidate,
  createProvisioningStateCandidate,
  createProvisioningTargetCandidate,
  createSubjectCandidate,
} from '@access-control/domain';

const now = '2026-08-01T00:00:00.000Z';

const observation = {
  providerConnectionId: 'provider:fixture',
  provisioningTargetId: 'target:fixture',
  configuration: {},
};

describe('observe-only adapter contracts', () => {
  it.each([
    ['Proxmox', proxmoxSnapshotSchema, PROXMOX_FIXTURE],
    ['Zabbix', zabbixSnapshotSchema, ZABBIX_FIXTURE],
    ['POSIX', posixSnapshotSchema, POSIX_FIXTURE],
  ])('%s fixture is strict', (_name, schema, fixture) => {
    expect(schema.safeParse(fixture).success).toBe(true);
    expect(schema.safeParse({ ...fixture, unknown: true }).success).toBe(false);
  });

  it('creates a Proxmox plan but refuses production writes', async () => {
    const adapter = new ProxmoxObservationAdapter({ observe: async () => PROXMOX_FIXTURE });
    expect((await adapter.observe(observation)).status).toBe('complete');
    const plan = await adapter.plan(
      planContext('proxmox', 'proxmox_group_membership', 'auditors', PROXMOX_FIXTURE, {
        externalId: 'auditor@example',
      }),
    );
    expect(plan.changes).toHaveLength(1);
    await expect(adapter.apply({} as never)).rejects.toMatchObject({
      code: 'proxmox_writes_not_implemented',
    });
  });

  it('creates a Zabbix plan but refuses production writes', async () => {
    const adapter = new ZabbixObservationAdapter({ observe: async () => ZABBIX_FIXTURE });
    expect((await adapter.observe(observation)).status).toBe('complete');
    const plan = await adapter.plan(
      planContext('zabbix', 'zabbix_saml_mapping', 'monitoring-users', {
        ...ZABBIX_FIXTURE,
        samlJitMappings: [],
      }),
    );
    expect(plan.changes).toHaveLength(1);
    await expect(adapter.apply({} as never)).rejects.toMatchObject({
      code: 'zabbix_writes_not_implemented',
    });
  });

  it('creates a POSIX review plan but never allocates identifiers or writes', async () => {
    const adapter = new PosixObservationAdapter({ observe: async () => POSIX_FIXTURE });
    expect((await adapter.observe(observation)).status).toBe('complete');
    const plan = await adapter.plan(
      planContext(
        'posix',
        'posix_account',
        'example_user',
        { ...POSIX_FIXTURE, accounts: [] },
        {
          externalId: 'example_user',
          login: 'example_user',
        },
      ),
    );
    expect(plan.changes).toHaveLength(1);
    await expect(adapter.apply({} as never)).rejects.toMatchObject({
      code: 'posix_allocation_not_implemented',
    });
  });
});

function planContext(
  provider: 'posix' | 'proxmox' | 'zabbix',
  targetType: 'posix_account' | 'proxmox_group_membership' | 'zabbix_saml_mapping',
  providerTargetId: string,
  payload: Record<string, unknown>,
  accountInput?: { externalId: string; login?: string },
): AuthoritativePlanContext {
  const organizationSettings = createOrganizationSettingsCandidate({
    id: 'organization',
    organizationName: 'Example Organization',
    title: 'Access Control',
    maxPlanChanges: 20,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'subject:administrator',
    updatedBy: 'subject:administrator',
  });
  const subject = createSubjectCandidate({
    id: 'subject:fixture',
    kind: 'human',
    classification: 'member',
    displayName: 'Fixture Subject',
    status: 'active',
    directoryState: 'active',
    protected: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'subject:administrator',
    updatedBy: 'subject:administrator',
  });
  const entitlement = createApplicationEntitlementCandidate({
    id: 'entitlement:fixture',
    applicationId: 'application:fixture',
    key: 'member',
    name: 'Member',
    status: 'active',
    requiresProvisioning: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'subject:administrator',
    updatedBy: 'subject:administrator',
  });
  const providerConnection = createProviderConnectionCandidate({
    id: 'provider:fixture',
    provider,
    name: 'Fixture Provider',
    mode: 'plan',
    configuration: {},
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'subject:administrator',
    updatedBy: 'subject:administrator',
  });
  const provisioningTarget = createProvisioningTargetCandidate({
    id: 'target:fixture',
    providerConnectionId: providerConnection.id,
    applicationEntitlementId: entitlement.id,
    targetType,
    providerTargetId,
    mode: 'plan',
    protected: false,
    configuration: {},
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: 'subject:administrator',
    updatedBy: 'subject:administrator',
  });
  const provisioningState = createProvisioningStateCandidate({
    id: 'state:fixture',
    provisioningTargetId: provisioningTarget.id,
    subjectId: subject.id,
    desiredState: 'present',
    observedState: 'absent',
    status: 'observed',
    revision: 1,
    evidence: {},
    updatedAt: now,
  });
  const effectiveGrant = createEffectiveGrantCandidate({
    id: 'grant:fixture',
    subjectId: subject.id,
    sourceGroupId: 'group:fixture',
    sourceGroupMembershipId: 'membership:fixture',
    mappingId: 'mapping:fixture',
    entitlementId: entitlement.id,
    status: 'active',
    calculatedAt: now,
  });
  const providerAccount =
    accountInput === undefined
      ? undefined
      : createProviderAccountCandidate({
          id: 'provider-account:fixture',
          providerConnectionId: providerConnection.id,
          subjectId: subject.id,
          externalId: accountInput.externalId,
          ...(accountInput.login === undefined ? {} : { login: accountInput.login }),
          status: 'active',
          observedAt: now,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
  const observationRecord = createProviderObservationCandidate({
    id: 'observation:fixture',
    providerConnectionId: providerConnection.id,
    provisioningTargetId: provisioningTarget.id,
    status: 'complete',
    observedAt: now,
    payload,
    checksum: `sha256:${'a'.repeat(64)}`,
  });
  return {
    evaluatedAt: now,
    organizationSettings,
    subject,
    entitlement,
    providerConnection,
    provisioningTarget,
    provisioningState,
    ...(providerAccount === undefined ? {} : { providerAccount }),
    effectiveGrants: [effectiveGrant],
    requiredProvisioningTargets: [provisioningTarget],
    observation: observationRecord,
  };
}
