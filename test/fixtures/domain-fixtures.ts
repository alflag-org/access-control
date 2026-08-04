import {
  createApplicationCandidate,
  createApplicationEntitlementCandidate,
  createEntitlementMappingCandidate,
  createExternalIdentityCandidate,
  createGuestProfileCandidate,
  createSourceGroupCandidate,
  createSourceGroupMembershipCandidate,
  createSubjectCandidate,
} from '@access-control/domain';
import type { ServiceRuntime } from '@access-control/application';

export const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';

export function fixtureRuntime(time = FIXTURE_TIME, namespace = 'fixture'): ServiceRuntime {
  let sequence = 0;
  return {
    now: () => time,
    id: (prefix) => `${prefix}:${namespace}-${++sequence}`,
  };
}

export function memberSubject(overrides: Record<string, unknown> = {}) {
  return createSubjectCandidate({
    id: 'subject:member',
    kind: 'human',
    classification: 'member',
    displayName: 'Ada Example',
    primaryEmail: 'ada@example.org',
    status: 'active',
    directoryState: 'active',
    protected: false,
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
    ...overrides,
  });
}

export function googleIdentity(overrides: Record<string, unknown> = {}) {
  return createExternalIdentityCandidate({
    id: 'identity:google-member',
    subjectId: 'subject:member',
    provider: 'google',
    issuer: 'urn:google-directory:customer:example-customer',
    providerSubject: 'google-user-1',
    displayName: 'Ada Example',
    email: 'ada@example.org',
    status: 'active',
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
    ...overrides,
  });
}

export function activeGuest(overrides: Record<string, unknown> = {}) {
  return createGuestProfileCandidate({
    subjectId: 'subject:member',
    sponsorSubjectId: 'subject:sponsor',
    externalContactEmail: 'ada.external@example.net',
    externalOrganization: 'Example Partner',
    purpose: 'Time-bounded documentation review',
    validFrom: '2025-12-01T00:00:00.000Z',
    expiresAt: '2026-02-01T00:00:00.000Z',
    status: 'active',
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:sponsor',
    updatedBy: 'subject:sponsor',
    ...overrides,
  });
}

export function sourceGroup(overrides: Record<string, unknown> = {}) {
  return createSourceGroupCandidate({
    id: 'group:source-control',
    directorySourceId: 'directory:google',
    providerGroupId: 'google-group-1',
    email: 'access.github.member@example.org',
    aliases: [],
    name: 'Source Control Members',
    kind: 'access',
    status: 'active',
    directMemberCount: 1,
    lastSyncRunId: 'sync:1',
    lastObservedAt: FIXTURE_TIME,
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

export function sourceMembership(overrides: Record<string, unknown> = {}) {
  return createSourceGroupMembershipCandidate({
    id: 'membership:source-control-member',
    sourceGroupId: 'group:source-control',
    providerMembershipId: 'google-membership-1',
    memberType: 'user',
    memberProviderId: 'google-user-1',
    memberEmail: 'ada@example.org',
    role: 'MEMBER',
    status: 'active',
    syncRunId: 'sync:1',
    observedAt: FIXTURE_TIME,
    ...overrides,
  });
}

export function application(overrides: Record<string, unknown> = {}) {
  return createApplicationCandidate({
    id: 'application:source-control',
    key: 'source-control',
    name: 'Source Control',
    description: 'Fictional source control service.',
    category: 'Engineering',
    launchUrl: 'https://source.example.org',
    status: 'active',
    visibility: 'entitled',
    authentication: { type: 'cloudflare_oidc', reference: 'example-reference' },
    provisioningMode: 'plan',
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
    ...overrides,
  });
}

export function entitlement(overrides: Record<string, unknown> = {}) {
  return createApplicationEntitlementCandidate({
    id: 'entitlement:source-control-member',
    applicationId: 'application:source-control',
    key: 'member',
    name: 'Member',
    status: 'active',
    requiresProvisioning: true,
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
    ...overrides,
  });
}

export function activeMapping(overrides: Record<string, unknown> = {}) {
  return createEntitlementMappingCandidate({
    id: 'mapping:source-control-member',
    sourceGroupId: 'group:source-control',
    entitlementIds: ['entitlement:source-control-member'],
    provisioningTargetIds: [],
    status: 'active',
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
    ...overrides,
  });
}
