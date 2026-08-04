import { z } from 'zod';
import {
  applyRequestSchema,
  applyResultSchema,
  authoritativePlanContextSchema,
  observationRequestSchema,
  providerPlanSchema,
  type ApplyRequest,
  type ApplyResult,
  type AuthoritativePlanContext,
  type ObservationRequest,
  type ProviderPlan,
  type ProvisioningAdapter,
  type VerifyRequest,
} from '@access-control/contracts';
import {
  AccessControlError,
  canonicalJson,
  githubProviderConfigurationSchema,
  jsonValueSchema,
  type OperationPlanChange,
} from '@access-control/domain';

const githubUserSchema = z
  .object({
    id: z.int().positive(),
    login: z.string().min(1).max(256),
  })
  .passthrough();

const githubMemberSchema = githubUserSchema
  .extend({
    role: z.enum(['admin', 'member']).optional(),
  })
  .passthrough();

const githubInvitationSchema = z
  .object({
    id: z.int().positive(),
    login: z.string().min(1).max(256).optional(),
    email: z.email().nullable().optional(),
    role: z.enum(['admin', 'direct_member', 'billing_manager']).optional(),
    invitee: githubUserSchema.nullable().optional(),
  })
  .passthrough();

const githubTeamSchema = z
  .object({
    id: z.int().positive(),
    slug: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
  })
  .passthrough();

export const githubAdapterConfigurationSchema = githubProviderConfigurationSchema;

export const githubDesiredStateSchema = z
  .object({
    account: z
      .object({
        githubUserId: z.int().positive().optional(),
        login: z.string().trim().min(1).max(256).optional(),
      })
      .strict()
      .refine((account) => account.githubUserId !== undefined || account.login !== undefined, {
        message: 'A GitHub numeric user ID or login binding is required.',
      }),
    organization: z
      .object({
        login: z.string().trim().min(1).max(100),
        membership: z.enum(['present', 'absent']),
        remainingRequiredMemberships: z.int().nonnegative(),
      })
      .strict(),
    teams: z.array(
      z
        .object({
          slug: z.string().trim().min(1).max(256),
          membership: z.enum(['present', 'absent']),
        })
        .strict(),
    ),
  })
  .strict();

export const githubObservedSubjectStateSchema = z
  .object({
    organizationMembership: z.enum(['active', 'pending_invitation', 'absent']),
    organizationRole: z.enum(['admin', 'member']).optional(),
    activeOwnerCount: z.int().nonnegative(),
    teamSlugs: z.array(z.string().trim().min(1).max(256)),
  })
  .strict();

export const githubObservationPayloadSchema = z
  .object({
    organization: z.string().trim().min(1).max(100),
    members: z.array(
      z
        .object({
          id: z.int().positive(),
          login: z.string().trim().min(1).max(256),
          role: z.enum(['admin', 'member']),
        })
        .strict(),
    ),
    invitations: z.array(
      z
        .object({
          id: z.int().positive(),
          githubUserId: z.int().positive().optional(),
          login: z.string().trim().min(1).max(256).optional(),
          email: z.email().optional(),
          role: z.enum(['admin', 'direct_member', 'billing_manager']),
        })
        .strict(),
    ),
    teams: z.array(
      z
        .object({
          id: z.int().positive(),
          slug: z.string().trim().min(1).max(256),
          name: z.string().trim().min(1).max(256),
          memberIds: z.array(z.int().positive()),
        })
        .strict(),
    ),
  })
  .strict();

const githubAppCredentialSchema = z
  .object({
    appId: z.union([z.string().regex(/^\d+$/), z.int().positive()]),
    installationId: z.union([z.string().regex(/^\d+$/), z.int().positive()]),
    privateKey: z.string().min(1),
  })
  .strict();

const installationTokenSchema = z
  .object({
    token: z.string().min(1),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();

type GitHubUser = z.infer<typeof githubUserSchema>;
type GitHubMember = z.infer<typeof githubMemberSchema>;
type GitHubInvitation = z.infer<typeof githubInvitationSchema>;
type GitHubTeam = z.infer<typeof githubTeamSchema>;

export interface GitHubPage<T> {
  items: T[];
  nextPage?: number;
}

export interface GitHubTransport {
  listOrganizationMembers(organization: string, page?: number): Promise<GitHubPage<GitHubMember>>;
  getOrganizationMembership(
    organization: string,
    username: string,
  ): Promise<{ role: 'admin' | 'member' }>;
  listOrganizationInvitations(
    organization: string,
    page?: number,
  ): Promise<GitHubPage<GitHubInvitation>>;
  listTeams(organization: string, page?: number): Promise<GitHubPage<GitHubTeam>>;
  listTeamMembers(
    organization: string,
    teamSlug: string,
    page?: number,
  ): Promise<GitHubPage<GitHubUser>>;
  getUser(login: string): Promise<GitHubUser>;
  inviteOrganizationMember(organization: string, userId: number): Promise<void>;
  removeOrganizationMember(organization: string, username: string): Promise<void>;
  addTeamMember(organization: string, teamSlug: string, username: string): Promise<void>;
  removeTeamMember(organization: string, teamSlug: string, username: string): Promise<void>;
}

export type GitHubTransportFactory = () => Promise<GitHubTransport>;

export interface GitHubPlanCalculation {
  plan: ProviderPlan;
  provisioningStatus: 'converged' | 'pending' | 'planned' | 'waiting_for_invitation' | 'blocked';
}

type PlanChangeInput = Omit<OperationPlanChange, 'id' | 'operationPlanId'>;

export class GitHubProvisioningAdapter implements ProvisioningAdapter {
  public readonly provider = 'github' as const;
  public readonly capabilities = [
    'organization_membership',
    'organization_invitation',
    'team_membership',
  ] as const;

  public constructor(
    private readonly createTransport: GitHubTransportFactory,
    private readonly writesEnabled: boolean,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async observe(inputValue: ObservationRequest) {
    const input = observationRequestSchema.parse(inputValue);
    const configuration = githubAdapterConfigurationSchema.parse(input.configuration);
    const transport = await this.createTransport();
    const [rawMembers, rawInvitations, rawTeams] = await Promise.all([
      collectGitHubPages((page) =>
        transport.listOrganizationMembers(configuration.organization, page),
      ),
      collectGitHubPages((page) =>
        transport.listOrganizationInvitations(configuration.organization, page),
      ),
      collectGitHubPages((page) => transport.listTeams(configuration.organization, page)),
    ]);
    const members = await Promise.all(
      rawMembers.map(async (member) => {
        const parsed = githubMemberSchema.parse(member);
        const role =
          parsed.role ??
          (await transport.getOrganizationMembership(configuration.organization, parsed.login))
            .role;
        return { id: parsed.id, login: parsed.login, role };
      }),
    );
    const selectedTeams = rawTeams.filter(
      (team) => configuration.teamSlugs.length === 0 || configuration.teamSlugs.includes(team.slug),
    );
    const teams = await Promise.all(
      selectedTeams.map(async (teamValue) => {
        const team = githubTeamSchema.parse(teamValue);
        const teamMembers = await collectGitHubPages((page) =>
          transport.listTeamMembers(configuration.organization, team.slug, page),
        );
        return {
          id: team.id,
          slug: team.slug,
          name: team.name,
          memberIds: teamMembers.map((member) => member.id).sort((left, right) => left - right),
        };
      }),
    );
    const invitations = rawInvitations.map((invitationValue) => {
      const invitation = githubInvitationSchema.parse(invitationValue);
      return {
        id: invitation.id,
        ...(invitation.invitee?.id === undefined ? {} : { githubUserId: invitation.invitee.id }),
        ...((invitation.invitee?.login ?? invitation.login) === undefined
          ? {}
          : { login: invitation.invitee?.login ?? invitation.login }),
        ...(invitation.email === undefined || invitation.email === null
          ? {}
          : { email: invitation.email }),
        role: invitation.role ?? 'direct_member',
      };
    });
    const payload = githubObservationPayloadSchema.parse({
      organization: configuration.organization,
      members: members.sort((left, right) => left.id - right.id),
      invitations: invitations.sort((left, right) => left.id - right.id),
      teams: teams.sort((left, right) => left.slug.localeCompare(right.slug)),
    });
    return {
      id: `github-observation:${crypto.randomUUID()}`,
      providerConnectionId: input.providerConnectionId,
      provisioningTargetId: input.provisioningTargetId,
      status: 'complete' as const,
      observedAt: this.now(),
      payload,
      checksum: await sha256(canonicalJson(jsonValueSchema.parse(payload))),
    };
  }

  public async plan(inputValue: AuthoritativePlanContext): Promise<ProviderPlan> {
    const input = authoritativePlanContextSchema.parse(inputValue);
    const { desired, observed } = deriveGitHubPlanStates(input);
    return calculateGitHubPlan(desired, observed).plan;
  }

  public async apply(inputValue: ApplyRequest): Promise<ApplyResult> {
    const input = applyRequestSchema.parse(inputValue);
    assertGitHubApplyAllowed(input, this.writesEnabled);
    const transport = await this.createTransport();
    const resource = parseGitHubResource(input.change.resource);
    const user = await resolveUser(transport, resource);
    await assertLiveGitHubPreconditions(transport, input.change.action, resource, user);
    switch (input.change.action) {
      case 'github.organization.invite': {
        await transport.inviteOrganizationMember(resource.organization, user.id);
        return applyResultSchema.parse({
          status: 'waiting_for_invitation',
          evidence: { githubUserId: user.id, organization: resource.organization },
        });
      }
      case 'github.organization.remove': {
        if (resource.login === undefined) throw missingLogin();
        await transport.removeOrganizationMember(resource.organization, user.login);
        return applyResultSchema.parse({
          status: 'applied',
          evidence: { githubUserId: user.id, organization: resource.organization },
        });
      }
      case 'github.team.add': {
        if (resource.login === undefined) throw missingLogin();
        if (resource.teamSlug === undefined) throw invalidResource();
        await transport.addTeamMember(resource.organization, resource.teamSlug, user.login);
        return applyResultSchema.parse({
          status: 'applied',
          evidence: {
            githubUserId: user.id,
            organization: resource.organization,
            teamSlug: resource.teamSlug,
          },
        });
      }
      case 'github.team.remove': {
        if (resource.login === undefined) throw missingLogin();
        if (resource.teamSlug === undefined) throw invalidResource();
        await transport.removeTeamMember(resource.organization, resource.teamSlug, user.login);
        return applyResultSchema.parse({
          status: 'applied',
          evidence: {
            githubUserId: user.id,
            organization: resource.organization,
            teamSlug: resource.teamSlug,
          },
        });
      }
      default:
        throw new AccessControlError(
          422,
          'github_change_unsupported',
          'The persisted change is not supported by the GitHub adapter.',
        );
    }
  }

  public async verify(input: VerifyRequest) {
    return this.observe(input.observation);
  }
}

function deriveGitHubPlanStates(input: AuthoritativePlanContext): {
  desired: z.infer<typeof githubDesiredStateSchema>;
  observed: z.infer<typeof githubObservedSubjectStateSchema>;
} {
  if (input.providerConnection.provider !== 'github') {
    throw new AccessControlError(
      422,
      'github_connection_required',
      'The GitHub adapter requires a GitHub Provider Connection.',
    );
  }
  if (
    input.provisioningTarget.targetType !== 'github_organization_membership' &&
    input.provisioningTarget.targetType !== 'github_team_membership'
  ) {
    throw new AccessControlError(
      422,
      'github_target_unsupported',
      'The Provisioning Target is not supported by the GitHub adapter.',
    );
  }
  const account = input.providerAccount;
  if (account === undefined || !/^\d+$/.test(account.externalId)) {
    throw new AccessControlError(
      422,
      'github_binding_missing',
      'A GitHub Provider Account with a numeric immutable user ID is required.',
    );
  }
  const githubUserId = Number(account.externalId);
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    throw new AccessControlError(
      422,
      'github_binding_invalid',
      'The GitHub Provider Account immutable user ID is invalid.',
    );
  }
  const configuration = githubAdapterConfigurationSchema.parse(
    input.providerConnection.configuration,
  );
  const payload = githubObservationPayloadSchema.parse(input.observation.payload);
  if (payload.organization !== configuration.organization) {
    throw new AccessControlError(
      409,
      'github_observation_organization_mismatch',
      'The latest GitHub observation belongs to another organization.',
    );
  }
  const member = payload.members.find((candidate) => candidate.id === githubUserId);
  const invitation = payload.invitations.find(
    (candidate) =>
      candidate.githubUserId === githubUserId ||
      (account.login !== undefined && candidate.login === account.login),
  );
  const teamSlugs = payload.teams
    .filter((team) => team.memberIds.includes(githubUserId))
    .map((team) => team.slug)
    .sort();
  const observed = githubObservedSubjectStateSchema.parse({
    organizationMembership:
      member === undefined
        ? invitation === undefined
          ? 'absent'
          : 'pending_invitation'
        : 'active',
    ...(member === undefined ? {} : { organizationRole: member.role }),
    activeOwnerCount: payload.members.filter((candidate) => candidate.role === 'admin').length,
    teamSlugs,
  });
  const requiredTargetIds = new Set(input.requiredProvisioningTargets.map((target) => target.id));
  const currentTargetRequired = requiredTargetIds.has(input.provisioningTarget.id);
  const otherRequiredTargets = input.requiredProvisioningTargets.filter(
    (target) =>
      target.id !== input.provisioningTarget.id &&
      target.providerConnectionId === input.providerConnection.id &&
      (target.targetType === 'github_organization_membership' ||
        target.targetType === 'github_team_membership'),
  );
  const desiredTeams = new Map<string, { slug: string; membership: 'present' | 'absent' }>(
    teamSlugs.map((slug) => [slug, { slug, membership: 'present' as const }]),
  );
  let organizationMembership: 'present' | 'absent';
  if (input.provisioningTarget.targetType === 'github_team_membership') {
    const teamSlug = input.provisioningTarget.providerTargetId;
    if (configuration.teamSlugs.length > 0 && !configuration.teamSlugs.includes(teamSlug)) {
      throw new AccessControlError(
        422,
        'github_team_not_observed',
        'The Provisioning Target team is outside the configured GitHub observation set.',
      );
    }
    desiredTeams.set(teamSlug, {
      slug: teamSlug,
      membership: currentTargetRequired ? 'present' : 'absent',
    });
    organizationMembership =
      currentTargetRequired || observed.organizationMembership !== 'absent' ? 'present' : 'absent';
  } else {
    if (input.provisioningTarget.providerTargetId !== configuration.organization) {
      throw new AccessControlError(
        422,
        'github_organization_target_mismatch',
        'The Provisioning Target does not match the configured GitHub organization.',
      );
    }
    organizationMembership = currentTargetRequired ? 'present' : 'absent';
  }
  const desired = githubDesiredStateSchema.parse({
    account: {
      githubUserId,
      ...(account.login === undefined ? {} : { login: account.login }),
    },
    organization: {
      login: configuration.organization,
      membership: organizationMembership,
      remainingRequiredMemberships: otherRequiredTargets.length,
    },
    teams: [...desiredTeams.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
  });
  return { desired, observed };
}

export function calculateGitHubPlan(
  desiredValue: z.infer<typeof githubDesiredStateSchema>,
  observedValue: z.infer<typeof githubObservedSubjectStateSchema>,
): GitHubPlanCalculation {
  const desired = githubDesiredStateSchema.parse(desiredValue);
  const observed = githubObservedSubjectStateSchema.parse(observedValue);
  const account = preferredAccountReference(desired.account);
  const changes: PlanChangeInput[] = [];
  if (desired.organization.membership === 'present') {
    if (observed.organizationMembership === 'absent') {
      changes.push(
        change(
          'github.organization.invite',
          resource(desired.organization.login, account),
          null,
          { membership: 'pending_invitation' },
          false,
          false,
          ['github_binding_present'],
        ),
      );
      return result(changes, 'pending');
    }
    if (observed.organizationMembership === 'pending_invitation') {
      return result([], 'waiting_for_invitation');
    }
  }
  for (const team of [...desired.teams].sort((left, right) =>
    left.slug.localeCompare(right.slug),
  )) {
    const present = observed.teamSlugs.includes(team.slug);
    if (team.membership === 'present' && !present) {
      if (observed.organizationMembership !== 'active') continue;
      if (account.login === undefined) return blocked('github_login_binding_required');
      changes.push(
        change(
          'github.team.add',
          resource(desired.organization.login, account, team.slug),
          null,
          { membership: 'active' },
          false,
          false,
          ['organization_membership_active'],
        ),
      );
    }
    if (team.membership === 'absent' && present) {
      if (account.login === undefined) return blocked('github_login_binding_required');
      changes.push(
        change(
          'github.team.remove',
          resource(desired.organization.login, account, team.slug),
          { membership: 'active' },
          null,
          true,
          false,
          ['organization_membership_unchanged'],
        ),
      );
    }
  }
  if (
    desired.organization.membership === 'absent' &&
    observed.organizationMembership === 'active'
  ) {
    if (desired.organization.remainingRequiredMemberships > 0) {
      return blocked('github_membership_still_required');
    }
    if (account.login === undefined) return blocked('github_login_binding_required');
    const ownerRemoval = observed.organizationRole === 'admin';
    if (ownerRemoval && observed.activeOwnerCount <= 1)
      return blocked('github_last_owner_forbidden');
    changes.push(
      change(
        'github.organization.remove',
        resource(desired.organization.login, account),
        { membership: 'active', role: observed.organizationRole ?? 'member' },
        null,
        true,
        ownerRemoval,
        ['remaining_required_memberships_zero', 'active_owner_remains'],
      ),
    );
  }
  return result(changes, changes.length === 0 ? 'converged' : 'planned');
}

export function assertGitHubApplyAllowed(input: ApplyRequest, adapterWritesEnabled: boolean): void {
  if (!adapterWritesEnabled || !input.writesEnabled) {
    throw new AccessControlError(409, 'github_writes_disabled', 'GitHub writes are disabled.');
  }
  if (input.operationStatus !== 'applying') {
    throw new AccessControlError(409, 'operation_not_applying', 'The operation is not applying.');
  }
  if (input.planHash !== input.persistedPlanHash) {
    throw new AccessControlError(409, 'plan_hash_mismatch', 'The persisted plan hash changed.');
  }
  if (input.change.protected) {
    throw new AccessControlError(
      409,
      'protected_change_apply_forbidden',
      'Protected GitHub changes cannot be applied automatically.',
    );
  }
}

async function assertLiveGitHubPreconditions(
  transport: GitHubTransport,
  action: OperationPlanChange['action'],
  resource: ReturnType<typeof parseGitHubResource>,
  user: GitHubUser,
): Promise<void> {
  const members = await collectGitHubPages((page) =>
    transport.listOrganizationMembers(resource.organization, page),
  );
  const member = members.find(
    (candidate) => candidate.id === user.id || candidate.login === user.login,
  );
  let organizationState: 'absent' | 'pending' | 'member' | 'admin' = 'absent';
  if (member !== undefined) {
    const role =
      member.role ??
      (await transport.getOrganizationMembership(resource.organization, member.login)).role;
    organizationState = role;
  } else {
    const invitations = await collectGitHubPages((page) =>
      transport.listOrganizationInvitations(resource.organization, page),
    );
    const invited = invitations.some(
      (invitation) =>
        invitation.invitee?.id === user.id ||
        invitation.login === user.login ||
        invitation.invitee?.login === user.login,
    );
    if (invited) organizationState = 'pending';
  }

  if (action === 'github.organization.invite') {
    if (organizationState !== 'absent') throw githubPreconditionChanged();
    return;
  }
  if (action === 'github.organization.remove') {
    if (organizationState !== 'member') throw githubPreconditionChanged();
    return;
  }
  if (
    resource.teamSlug === undefined ||
    organizationState === 'absent' ||
    organizationState === 'pending'
  ) {
    throw githubPreconditionChanged();
  }
  const teamMembers = await collectGitHubPages((page) =>
    transport.listTeamMembers(resource.organization, resource.teamSlug!, page),
  );
  const teamMember = teamMembers.some(
    (candidate) => candidate.id === user.id || candidate.login === user.login,
  );
  if (
    (action === 'github.team.add' && teamMember) ||
    (action === 'github.team.remove' && !teamMember)
  ) {
    throw githubPreconditionChanged();
  }
}

function githubPreconditionChanged(): AccessControlError {
  return new AccessControlError(
    409,
    'github_precondition_changed',
    'GitHub state changed after the plan was created; observe and plan again.',
  );
}

export async function createGitHubAppTransport(
  credentialValue: unknown,
  fetcher: typeof fetch = fetch,
): Promise<GitHubTransport> {
  const credential = parseGitHubCredential(credentialValue);
  const appJwt = await createGitHubAppJwt(String(credential.appId), credential.privateKey);
  const response = await githubRequest(
    fetcher,
    `/app/installations/${credential.installationId}/access_tokens`,
    appJwt,
    { method: 'POST', body: '{}' },
  );
  const token = installationTokenSchema.parse(response.body).token;
  return new FetchGitHubTransport(token, fetcher);
}

function parseGitHubCredential(value: unknown): z.infer<typeof githubAppCredentialSchema> {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new AccessControlError(
        503,
        'github_credential_invalid',
        'The GitHub credential binding is not valid JSON.',
      );
    }
  }
  const result = githubAppCredentialSchema.safeParse(candidate);
  if (!result.success) {
    throw new AccessControlError(
      503,
      'github_credential_invalid',
      'The GitHub credential binding does not match the GitHub App contract.',
    );
  }
  return result.data;
}

export class FetchGitHubTransport implements GitHubTransport {
  public constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async listOrganizationMembers(organization: string, page = 1) {
    return this.page<GitHubMember>(
      `/orgs/${encodeURIComponent(organization)}/members?filter=all&per_page=100&page=${page}`,
      githubMemberSchema,
      page,
    );
  }

  public async getOrganizationMembership(organization: string, username: string) {
    const response = await this.request(
      `/orgs/${encodeURIComponent(organization)}/memberships/${encodeURIComponent(username)}`,
    );
    return z
      .object({ role: z.enum(['admin', 'member']) })
      .passthrough()
      .parse(response);
  }

  public async listOrganizationInvitations(organization: string, page = 1) {
    return this.page<GitHubInvitation>(
      `/orgs/${encodeURIComponent(organization)}/invitations?per_page=100&page=${page}`,
      githubInvitationSchema,
      page,
    );
  }

  public async listTeams(organization: string, page = 1) {
    return this.page<GitHubTeam>(
      `/orgs/${encodeURIComponent(organization)}/teams?per_page=100&page=${page}`,
      githubTeamSchema,
      page,
    );
  }

  public async listTeamMembers(organization: string, teamSlug: string, page = 1) {
    return this.page<GitHubUser>(
      `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug)}/members?per_page=100&page=${page}`,
      githubUserSchema,
      page,
    );
  }

  public async getUser(login: string): Promise<GitHubUser> {
    return githubUserSchema.parse(await this.request(`/users/${encodeURIComponent(login)}`));
  }

  public async inviteOrganizationMember(organization: string, userId: number): Promise<void> {
    await this.request(`/orgs/${encodeURIComponent(organization)}/invitations`, {
      method: 'POST',
      body: JSON.stringify({ invitee_id: userId, role: 'direct_member' }),
    });
  }

  public async removeOrganizationMember(organization: string, username: string): Promise<void> {
    await this.request(
      `/orgs/${encodeURIComponent(organization)}/members/${encodeURIComponent(username)}`,
      { method: 'DELETE' },
    );
  }

  public async addTeamMember(
    organization: string,
    teamSlug: string,
    username: string,
  ): Promise<void> {
    await this.request(
      `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
      { method: 'PUT', body: JSON.stringify({ role: 'member' }) },
    );
  }

  public async removeTeamMember(
    organization: string,
    teamSlug: string,
    username: string,
  ): Promise<void> {
    await this.request(
      `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`,
      { method: 'DELETE' },
    );
  }

  private async page<T>(
    path: string,
    itemSchema: z.ZodType<T>,
    currentPage: number,
  ): Promise<GitHubPage<T>> {
    const response = await githubRequest(this.fetcher, path, this.token);
    const items = z.array(itemSchema).parse(response.body);
    const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '');
    return hasNext ? { items, nextPage: currentPage + 1 } : { items };
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    return (await githubRequest(this.fetcher, path, this.token, init)).body;
  }
}

async function githubRequest(
  fetcher: typeof fetch,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<{ body: unknown; headers: Headers }> {
  let response: Response;
  try {
    response = await fetcher(new URL(path, 'https://api.github.com'), {
      ...init,
      redirect: 'error',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'access-control',
        'x-github-api-version': '2026-03-10',
        ...headersToObject(init.headers),
      },
    });
  } catch {
    throw new AccessControlError(503, 'github_unavailable', 'GitHub could not be reached.');
  }
  if (!response.ok) throw githubHttpError(response);
  if (response.status === 204) return { body: null, headers: response.headers };
  try {
    return { body: await response.json(), headers: response.headers };
  } catch {
    throw new AccessControlError(
      503,
      'github_invalid_response',
      'GitHub returned an invalid response.',
    );
  }
}

function githubHttpError(response: Response): AccessControlError {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (response.status === 429 || (response.status === 403 && remaining === '0')) {
    return new AccessControlError(429, 'github_rate_limited', 'GitHub rate limited the request.');
  }
  if (response.status === 403 && response.headers.has('retry-after')) {
    return new AccessControlError(
      429,
      'github_secondary_rate_limited',
      'GitHub applied a secondary rate limit.',
    );
  }
  if (response.status === 401 || response.status === 403) {
    return new AccessControlError(
      503,
      'github_authorization_failed',
      'GitHub App authorization failed.',
    );
  }
  if (response.status === 404) {
    return new AccessControlError(
      422,
      'github_resource_not_found',
      'The GitHub resource was not found.',
    );
  }
  return new AccessControlError(503, 'github_api_error', 'GitHub returned an error.');
}

async function collectGitHubPages<T>(
  readPage: (page?: number) => Promise<GitHubPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<number>();
  let page: number | undefined;
  do {
    const response = await readPage(page);
    items.push(...response.items);
    page = response.nextPage;
    if (page !== undefined && seen.has(page)) {
      throw new AccessControlError(
        503,
        'github_pagination_cycle',
        'GitHub repeated a pagination page.',
      );
    }
    if (page !== undefined) seen.add(page);
  } while (page !== undefined);
  return items;
}

function preferredAccountReference(account: z.infer<typeof githubDesiredStateSchema>['account']) {
  if (account.githubUserId !== undefined || account.login !== undefined) {
    return {
      ...(account.githubUserId === undefined ? {} : { githubUserId: account.githubUserId }),
      ...(account.login === undefined ? {} : { login: account.login }),
    };
  }
  throw new AccessControlError(
    422,
    'github_binding_missing',
    'A GitHub numeric user ID or login binding is required.',
  );
}

function resource(
  organization: string,
  account: { githubUserId?: number; login?: string },
  teamSlug?: string,
): string {
  return [
    `organization:${encodeURIComponent(organization)}`,
    ...(account.githubUserId === undefined ? [] : [`id:${account.githubUserId}`]),
    ...(account.login === undefined ? [] : [`login:${encodeURIComponent(account.login)}`]),
    ...(teamSlug === undefined ? [] : [`team:${encodeURIComponent(teamSlug)}`]),
  ].join('|');
}

function parseGitHubResource(value: string): {
  organization: string;
  githubUserId?: number;
  login?: string;
  teamSlug?: string;
} {
  const parts = Object.fromEntries(
    value.split('|').map((part) => {
      const separator = part.indexOf(':');
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }),
  );
  if (parts.organization === undefined || (parts.id === undefined && parts.login === undefined)) {
    throw invalidResource();
  }
  if (parts.id !== undefined && !/^\d+$/.test(parts.id)) throw invalidResource();
  return {
    organization: parts.organization,
    ...(parts.id === undefined ? {} : { githubUserId: Number(parts.id) }),
    ...(parts.login === undefined ? {} : { login: parts.login }),
    ...(parts.team === undefined ? {} : { teamSlug: parts.team }),
  };
}

async function resolveUser(
  transport: GitHubTransport,
  reference: { githubUserId?: number; login?: string },
): Promise<GitHubUser> {
  if (reference.login !== undefined) {
    const user = await transport.getUser(reference.login);
    if (reference.githubUserId !== undefined && user.id !== reference.githubUserId) {
      throw new AccessControlError(
        409,
        'github_binding_changed',
        'The GitHub numeric user ID no longer matches the login.',
      );
    }
    return user;
  }
  if (reference.githubUserId !== undefined) {
    return { id: reference.githubUserId, login: String(reference.githubUserId) };
  }
  throw invalidResource();
}

function change(
  action: PlanChangeInput['action'],
  resourceValue: string,
  before: PlanChangeInput['before'],
  after: PlanChangeInput['after'],
  destructive: boolean,
  protectedChange: boolean,
  preconditions: string[],
): PlanChangeInput {
  return {
    position: 0,
    action,
    resource: resourceValue,
    before,
    after,
    destructive,
    protected: protectedChange,
    preconditions,
  };
}

function result(
  changes: PlanChangeInput[],
  provisioningStatus: GitHubPlanCalculation['provisioningStatus'],
): GitHubPlanCalculation {
  const positioned = changes.map((candidate, position) => ({ ...candidate, position }));
  const plan = providerPlanSchema.parse({
    changes: positioned,
    destructive: positioned.some((candidate) => candidate.destructive),
    protected: positioned.some((candidate) => candidate.protected),
  });
  return { plan, provisioningStatus };
}

function blocked(reason: string): GitHubPlanCalculation {
  return {
    plan: providerPlanSchema.parse({
      changes: [],
      destructive: false,
      protected: false,
      blockedReason: reason,
    }),
    provisioningStatus: 'blocked',
  };
}

function invalidResource(): AccessControlError {
  return new AccessControlError(
    422,
    'github_resource_invalid',
    'The persisted GitHub resource reference is invalid.',
  );
}

function missingLogin(): AccessControlError {
  return new AccessControlError(
    422,
    'github_login_binding_required',
    'This GitHub change requires a stable login in addition to the preferred numeric user ID.',
  );
}

async function createGitHubAppJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new AccessControlError(
      503,
      'github_credential_invalid',
      'The GitHub App private key could not be imported.',
    );
  }
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function base64Url(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
