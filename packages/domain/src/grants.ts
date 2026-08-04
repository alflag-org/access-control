import type {
  Application,
  ApplicationEntitlement,
  EffectiveGrant,
  EntitlementMapping,
} from './catalog';
import { createEffectiveGrantCandidate } from './candidates';
import { deterministicId } from './common';
import type { SourceGroup, SourceGroupMembership } from './directory';
import type { ExternalIdentity, GuestProfile, Subject } from './identity';

export interface EffectiveGrantCalculationInput {
  subjects: readonly Subject[];
  externalIdentities: readonly ExternalIdentity[];
  guestProfiles: readonly GuestProfile[];
  sourceGroups: readonly SourceGroup[];
  memberships: readonly SourceGroupMembership[];
  mappings: readonly EntitlementMapping[];
  applications: readonly Application[];
  entitlements: readonly ApplicationEntitlement[];
  calculatedAt: string;
}

export interface EffectiveGrantCalculationResult {
  grants: EffectiveGrant[];
  ignoredMembershipIds: string[];
}

export function calculateEffectiveGrants(
  input: EffectiveGrantCalculationInput,
): EffectiveGrantCalculationResult {
  const now = Date.parse(input.calculatedAt);
  const subjects = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const guests = new Map(input.guestProfiles.map((guest) => [guest.subjectId, guest]));
  const groups = new Map(input.sourceGroups.map((group) => [group.id, group]));
  const applications = new Map(
    input.applications.map((application) => [application.id, application]),
  );
  const entitlements = new Map(
    input.entitlements.map((entitlement) => [entitlement.id, entitlement]),
  );
  const googleIdentities = new Map(
    input.externalIdentities
      .filter((identity) => identity.provider === 'google' && identity.status === 'active')
      .map((identity) => [identity.providerSubject, identity]),
  );
  const mappingsByGroup = new Map<string, EntitlementMapping[]>();
  for (const mapping of input.mappings) {
    if (mapping.status !== 'active') continue;
    if (mapping.validFrom !== undefined && Date.parse(mapping.validFrom) > now) continue;
    if (mapping.validUntil !== undefined && Date.parse(mapping.validUntil) <= now) continue;
    const mappings = mappingsByGroup.get(mapping.sourceGroupId) ?? [];
    mappings.push(mapping);
    mappingsByGroup.set(mapping.sourceGroupId, mappings);
  }

  const grants: EffectiveGrant[] = [];
  const ignoredMembershipIds: string[] = [];
  for (const membership of input.memberships) {
    if (membership.status !== 'active' || membership.memberType !== 'user') {
      ignoredMembershipIds.push(membership.id);
      continue;
    }
    const group = groups.get(membership.sourceGroupId);
    const identity = googleIdentities.get(membership.memberProviderId);
    if (group?.kind !== 'access' || group.status !== 'active' || identity === undefined) continue;
    const subject = subjects.get(identity.subjectId);
    if (subject?.status !== 'active' || subject.directoryState !== 'active') continue;
    const guest = guests.get(subject.id);
    if (guest !== undefined) {
      const sponsor = subjects.get(guest.sponsorSubjectId);
      if (
        guest.status !== 'active' ||
        Date.parse(guest.validFrom) > now ||
        Date.parse(guest.expiresAt) <= now ||
        sponsor?.status !== 'active'
      ) {
        continue;
      }
    }

    for (const mapping of mappingsByGroup.get(group.id) ?? []) {
      for (const entitlementId of mapping.entitlementIds) {
        const entitlement = entitlements.get(entitlementId);
        const application =
          entitlement === undefined ? undefined : applications.get(entitlement.applicationId);
        if (entitlement?.status !== 'active' || application?.status !== 'active') continue;
        const validUntil = earliestTimestamp(mapping.validUntil, guest?.expiresAt);
        grants.push(
          createEffectiveGrantCandidate({
            id: deterministicId('grant', [subject.id, membership.id, mapping.id, entitlement.id]),
            subjectId: subject.id,
            sourceGroupId: group.id,
            sourceGroupMembershipId: membership.id,
            mappingId: mapping.id,
            entitlementId: entitlement.id,
            status: 'active',
            calculatedAt: input.calculatedAt,
            ...(validUntil === undefined ? {} : { validUntil }),
          }),
        );
      }
    }
  }

  return {
    grants: grants.sort((left, right) => left.id.localeCompare(right.id)),
    ignoredMembershipIds: ignoredMembershipIds.sort(),
  };
}

function earliestTimestamp(left?: string, right?: string): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
