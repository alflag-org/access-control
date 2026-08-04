import { describe, expect, it } from 'vitest';
import { calculateEffectiveGrants } from '@access-control/domain';
import {
  FIXTURE_TIME,
  activeGuest,
  activeMapping,
  application,
  entitlement,
  googleIdentity,
  memberSubject,
  sourceGroup,
  sourceMembership,
} from '../fixtures/domain-fixtures';

function calculate(overrides: Partial<Parameters<typeof calculateEffectiveGrants>[0]> = {}) {
  return calculateEffectiveGrants({
    subjects: [memberSubject()],
    externalIdentities: [googleIdentity()],
    guestProfiles: [],
    sourceGroups: [sourceGroup()],
    memberships: [sourceMembership()],
    mappings: [activeMapping()],
    applications: [application()],
    entitlements: [entitlement()],
    calculatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

describe('Effective grant calculation', () => {
  it('retains complete source provenance and a deterministic identifier', () => {
    const first = calculate().grants;
    const second = calculate().grants;
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({
        subjectId: 'subject:member',
        sourceGroupId: 'group:source-control',
        sourceGroupMembershipId: 'membership:source-control-member',
        mappingId: 'mapping:source-control-member',
        entitlementId: 'entitlement:source-control-member',
      }),
    ]);
  });

  it.each([
    ['inactive Subject', { subjects: [memberSubject({ status: 'suspended' })] }],
    ['missing directory user', { subjects: [memberSubject({ directoryState: 'missing' })] }],
    ['missing identity', { externalIdentities: [googleIdentity({ status: 'missing' })] }],
    ['missing membership', { memberships: [sourceMembership({ status: 'missing' })] }],
    ['inactive group', { sourceGroups: [sourceGroup({ status: 'missing' })] }],
  ])('does not grant access for %s', (_case, overrides) => {
    expect(calculate(overrides).grants).toEqual([]);
  });

  it('does not expand nested groups', () => {
    const membership = sourceMembership({ memberType: 'group' });
    const result = calculate({ memberships: [membership] });
    expect(result.grants).toEqual([]);
    expect(result.ignoredMembershipIds).toEqual([membership.id]);
  });

  it('changes desired access to absent after Guest expiration without removing history inputs', () => {
    const result = calculate({
      subjects: [memberSubject({ classification: 'managed_guest' })],
      guestProfiles: [activeGuest({ expiresAt: '2025-12-31T23:59:59.000Z' })],
    });
    expect(result.grants).toEqual([]);
    expect(result.ignoredMembershipIds).toEqual([]);
  });

  it('bounds managed Guest grants by expiration and an active sponsor', () => {
    const guest = memberSubject({ classification: 'managed_guest' });
    const sponsor = memberSubject({ id: 'subject:sponsor', primaryEmail: 'sponsor@example.org' });
    const profile = activeGuest();
    expect(calculate({ subjects: [guest, sponsor], guestProfiles: [profile] }).grants).toEqual([
      expect.objectContaining({ validUntil: profile.expiresAt }),
    ]);
    expect(
      calculate({
        subjects: [guest, { ...sponsor, status: 'suspended' }],
        guestProfiles: [profile],
      }).grants,
    ).toEqual([]);
  });
});
