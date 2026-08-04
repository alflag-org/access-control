import { describe, expect, it } from 'vitest';
import {
  createProviderAccountCandidate,
  createProvisioningStateCandidate,
  createProvisioningTargetCandidate,
} from '@access-control/domain';
import { applicationAvailability } from '../../apps/worker/src/ui/app';
import { FIXTURE_TIME, entitlement, memberSubject } from '../fixtures/domain-fixtures';

describe('Application-specific provider account availability', () => {
  it('applies a pending invitation only through the related entitlement and provider connection', () => {
    const subject = memberSubject();
    const sourceControlEntitlement = entitlement();
    const infrastructureEntitlement = entitlement({
      id: 'entitlement:infrastructure-user',
      applicationId: 'application:infrastructure',
    });
    const sourceControlTarget = provisioningTarget({
      id: 'target:source-control',
      providerConnectionId: 'provider:github',
      applicationEntitlementId: sourceControlEntitlement.id,
      targetType: 'github_organization_membership',
    });
    const infrastructureTarget = provisioningTarget({
      id: 'target:infrastructure',
      providerConnectionId: 'provider:proxmox',
      applicationEntitlementId: infrastructureEntitlement.id,
      targetType: 'proxmox_group_membership',
    });
    const states = [
      provisioningState(sourceControlTarget.id, 'state:source-control'),
      provisioningState(infrastructureTarget.id, 'state:infrastructure'),
    ];
    const pendingGitHubAccount = createProviderAccountCandidate({
      id: 'provider-account:github',
      providerConnectionId: 'provider:github',
      subjectId: subject.id,
      externalId: '1001',
      login: 'ada-example',
      status: 'pending_invitation',
      observedAt: FIXTURE_TIME,
      revision: 1,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    });
    const targets = [sourceControlTarget, infrastructureTarget];

    expect(
      applicationAvailability({
        subject,
        effectiveEntitlements: [infrastructureEntitlement],
        states,
        applicationEntitlements: [infrastructureEntitlement],
        targets,
        providerAccounts: [pendingGitHubAccount],
      }),
    ).toEqual({ state: 'available' });

    expect(
      applicationAvailability({
        subject,
        effectiveEntitlements: [sourceControlEntitlement],
        states,
        applicationEntitlements: [sourceControlEntitlement],
        targets,
        providerAccounts: [pendingGitHubAccount],
      }),
    ).toEqual({ state: 'pending', message: '保留中の GitHub 組織招待を承認してください。' });
  });
});

function provisioningTarget(overrides: {
  id: string;
  providerConnectionId: string;
  applicationEntitlementId: string;
  targetType: 'github_organization_membership' | 'proxmox_group_membership';
}) {
  return createProvisioningTargetCandidate({
    ...overrides,
    providerTargetId: overrides.id,
    mode: 'plan',
    protected: false,
    configuration: {},
    status: 'active',
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
  });
}

function provisioningState(provisioningTargetId: string, id: string) {
  return createProvisioningStateCandidate({
    id,
    provisioningTargetId,
    subjectId: 'subject:member',
    desiredState: 'present',
    observedState: 'present',
    status: 'converged',
    evidence: {},
    revision: 1,
    updatedAt: FIXTURE_TIME,
  });
}
