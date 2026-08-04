import { describe, expect, it, vi } from 'vitest';
import { calculateOperationPlanHash } from '@access-control/application';
import {
  GitHubProvisioningAdapter,
  FetchGitHubTransport,
  assertGitHubApplyAllowed,
  calculateGitHubPlan,
  createGitHubAppTransport,
  type GitHubTransport,
} from '@access-control/github';
import {
  createOperationPlanChangeCandidate,
  type AccessControlError,
} from '@access-control/domain';

const hash = `sha256:${'a'.repeat(64)}`;
const change = createOperationPlanChangeCandidate({
  id: 'change:1',
  operationPlanId: 'plan:1',
  position: 0,
  action: 'github.team.add',
  resource: 'example-organization:platform:octocat',
  before: null,
  after: { membership: 'active' },
  destructive: false,
  protected: false,
  preconditions: ['organization_membership_active'],
});

describe('Deterministic plan hashing', () => {
  it('is independent of incidental object key and change array order', async () => {
    const second = createOperationPlanChangeCandidate({
      ...change,
      id: 'change:2',
      position: 1,
      before: { b: 2, a: 1 },
    });
    const base = {
      providerConnectionId: 'provider:github',
      provisioningTargetId: 'target:team',
      provisioningStateId: 'state:team',
      subjectId: 'subject:member',
      entitlementId: 'entitlement:member',
      observationId: 'observation:github',
      observationChecksum: hash,
      effectiveGrantIds: ['grant:member'],
      requiredProvisioningTargetIds: ['target:team'],
      inputRevisions: { 'target:team': 2, 'subject:member': 3 },
    };
    const left = await calculateOperationPlanHash({ ...base, changes: [change, second] });
    const right = await calculateOperationPlanHash({
      ...base,
      inputRevisions: { 'subject:member': 3, 'target:team': 2 },
      changes: [{ ...second, before: { a: 1, b: 2 } }, change],
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe('GitHub plan rules', () => {
  const desired = {
    account: { githubUserId: 1001, login: 'ada-example' },
    organization: {
      login: 'example-organization',
      membership: 'present' as const,
      remainingRequiredMemberships: 1,
    },
    teams: [{ slug: 'platform', membership: 'present' as const }],
  };

  it('plans an invitation before team membership and reports the waiting state', () => {
    const result = calculateGitHubPlan(desired, {
      organizationMembership: 'absent',
      activeOwnerCount: 2,
      teamSlugs: [],
    });
    expect(result.plan.changes.map((item) => item.action)).toEqual(['github.organization.invite']);
    expect(result.provisioningStatus).toBe('pending');
    expect(
      calculateGitHubPlan(desired, {
        organizationMembership: 'pending_invitation',
        activeOwnerCount: 2,
        teamSlugs: [],
      }).provisioningStatus,
    ).toBe('waiting_for_invitation');
  });

  it('adds a team only after active organization membership', () => {
    const result = calculateGitHubPlan(desired, {
      organizationMembership: 'active',
      organizationRole: 'member',
      activeOwnerCount: 2,
      teamSlugs: [],
    });
    expect(result.plan.changes.map((item) => item.action)).toEqual(['github.team.add']);
  });

  it('blocks organization removal while another entitlement requires membership', () => {
    const result = calculateGitHubPlan(
      {
        ...desired,
        organization: { ...desired.organization, membership: 'absent' },
        teams: [],
      },
      {
        organizationMembership: 'active',
        organizationRole: 'member',
        activeOwnerCount: 2,
        teamSlugs: [],
      },
    );
    expect(result.plan.blockedReason).toBe('github_membership_still_required');
  });

  it('forbids final-owner removal and protects other owner removals', () => {
    const removal = {
      ...desired,
      organization: {
        ...desired.organization,
        membership: 'absent' as const,
        remainingRequiredMemberships: 0,
      },
      teams: [],
    };
    expect(
      calculateGitHubPlan(removal, {
        organizationMembership: 'active',
        organizationRole: 'admin',
        activeOwnerCount: 1,
        teamSlugs: [],
      }).plan.blockedReason,
    ).toBe('github_last_owner_forbidden');
    expect(
      calculateGitHubPlan(removal, {
        organizationMembership: 'active',
        organizationRole: 'admin',
        activeOwnerCount: 2,
        teamSlugs: [],
      }).plan.changes[0]?.protected,
    ).toBe(true);
  });
});

describe('GitHub apply guards', () => {
  const input = {
    operationId: 'operation:1',
    operationPlanId: 'plan:1',
    planHash: hash,
    persistedPlanHash: hash,
    operationStatus: 'applying' as const,
    connectionMode: 'automatic' as const,
    writesEnabled: true,
    change,
  };

  it.each([
    ['adapter disabled', input, false, 'github_writes_disabled'],
    ['request disabled', { ...input, writesEnabled: false }, true, 'github_writes_disabled'],
    [
      'hash mismatch',
      { ...input, persistedPlanHash: `sha256:${'b'.repeat(64)}` },
      true,
      'plan_hash_mismatch',
    ],
    [
      'protected change',
      { ...input, change: { ...change, protected: true } },
      true,
      'protected_change_apply_forbidden',
    ],
  ])('blocks %s', (_case, candidate, enabled, code) => {
    expect(() => assertGitHubApplyAllowed(candidate, enabled)).toThrowError(
      expect.objectContaining<Partial<AccessControlError>>({ code }),
    );
  });

  it('rejects a malformed JSON credential before making a request', async () => {
    await expect(createGitHubAppTransport('{')).rejects.toMatchObject({
      code: 'github_credential_invalid',
    });
  });

  it('does not follow redirects while sending a GitHub installation token', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
      expect(init?.redirect).toBe('error');
      return new Response('{"id":1001,"login":"ada-example"}', {
        headers: { 'content-type': 'application/json' },
      });
    });
    const transport = new FetchGitHubTransport('installation-token', fetcher);

    await expect(transport.getUser('ada-example')).resolves.toEqual({
      id: 1001,
      login: 'ada-example',
    });
  });

  it('rechecks live provider state before a destructive write', async () => {
    const removeOrganizationMember = vi.fn(async () => undefined);
    const transport: GitHubTransport = {
      listOrganizationMembers: async () => ({
        items: [{ id: 1001, login: 'ada-example', role: 'admin' }],
      }),
      getOrganizationMembership: async () => ({ role: 'admin' }),
      listOrganizationInvitations: async () => ({ items: [] }),
      listTeams: async () => ({ items: [] }),
      listTeamMembers: async () => ({ items: [] }),
      getUser: async () => ({ id: 1001, login: 'ada-example' }),
      inviteOrganizationMember: async () => undefined,
      removeOrganizationMember,
      addTeamMember: async () => undefined,
      removeTeamMember: async () => undefined,
    };
    const adapter = new GitHubProvisioningAdapter(async () => transport, true);
    const removal = createOperationPlanChangeCandidate({
      id: 'change:remove',
      operationPlanId: 'plan:1',
      position: 0,
      action: 'github.organization.remove',
      resource: 'organization:example-organization|id:1001|login:ada-example',
      before: { membership: 'active', role: 'member' },
      after: null,
      destructive: true,
      protected: false,
      preconditions: ['active_owner_remains'],
    });

    await expect(adapter.apply({ ...input, change: removal })).rejects.toMatchObject({
      code: 'github_precondition_changed',
    });
    expect(removeOrganizationMember).not.toHaveBeenCalled();
  });
});
