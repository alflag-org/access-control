import type { AccessControlRepositories } from '@access-control/application';
import {
  AccessControlError,
  type ApplicationEntitlement,
  type GuestProfile,
  type OrganizationSettings,
  type PlatformRole,
  type ProviderAccount,
  type ProvisioningState,
  type ProvisioningTarget,
  type Subject,
} from '@access-control/domain';
import { renderPageShell } from './components/shell';
import {
  renderApplicationsPage,
  renderAccountPage,
  renderMyAccessPage,
  type ApplicationPortalEntry,
} from './pages/portal';
import {
  renderApplicationsAdmin,
  renderAuditAdmin,
  renderGroupsAdmin,
  renderGuestsAdmin,
  renderMappingsAdmin,
  renderPeopleAdmin,
  renderProvisioningAdmin,
  renderSettingsAdmin,
  type AdministrationCapabilities,
} from './pages/admin';

export interface RenderUiInput {
  pathname: string;
  subject: Subject;
  roles: PlatformRole[];
  repositories: AccessControlRepositories;
}

export async function renderUiPage(input: RenderUiInput): Promise<string | null> {
  const settings = await requireSettings(input.repositories);
  if (input.pathname.startsWith('/admin/')) requireAdministrationRole(input.roles);
  const page = await pageContent(input, settings);
  if (page === null) return null;
  return renderPageShell({
    pathname: input.pathname,
    title: page.title,
    description: page.description,
    content: page.content,
    organizationSettings: settings,
    subject: input.subject,
    roles: input.roles,
  });
}

async function pageContent(
  input: RenderUiInput,
  settings: OrganizationSettings,
): Promise<{ title: string; description: string; content: string } | null> {
  const repositories = input.repositories;
  const capabilities = administrationCapabilities(input.roles);
  switch (input.pathname) {
    case '/applications':
      return page(
        'アプリケーション',
        '利用できるアプリケーションと、対応が必要な状態を確認します。',
        renderApplicationsPage(await applicationEntries(input.subject, repositories)),
      );
    case '/access': {
      const [grants, entitlements, applications, groups, states] = await Promise.all([
        repositories.catalog.listEffectiveGrants(input.subject.id),
        repositories.catalog.listApplicationEntitlements(),
        repositories.catalog.listApplications(),
        repositories.catalog.listSourceGroups(),
        repositories.provisioning.listProvisioningStates(input.subject.id),
      ]);
      return page(
        '自分のアクセス',
        '現在のアプリケーション権限と付与元の Google グループを確認します。',
        renderMyAccessPage({
          grants,
          entitlements: new Map(entitlements.map((item) => [item.id, item])),
          applications: new Map(applications.map((item) => [item.id, item])),
          sourceGroups: new Map(groups.map((item) => [item.id, item])),
          provisioningStates: states,
        }),
      );
    }
    case '/account': {
      const [identities, guestProfile, providerAccounts] = await Promise.all([
        repositories.identities.listExternalIdentities(input.subject.id),
        repositories.identities.getGuestProfile(input.subject.id),
        repositories.provisioning.listProviderAccounts(input.subject.id),
      ]);
      return page(
        'アカウント',
        '登録情報、認証 ID、外部サービスのアカウントを確認します。',
        renderAccountPage({
          subject: input.subject,
          identities,
          guestProfile,
          providerAccounts,
        }),
      );
    }
    case '/admin/people': {
      const [subjects, roleGrants] = await Promise.all([
        repositories.identities.listSubjects(),
        repositories.identities.listPlatformRoleGrants(),
      ]);
      return page(
        'ユーザーとサービス',
        '登録済みのユーザー、サービスアカウント、自動処理の利用状態と管理ロールを確認します。',
        renderPeopleAdmin({ subjects, roleGrants, capabilities }),
      );
    }
    case '/admin/guests': {
      const [guests, identities, subjects] = await Promise.all([
        repositories.identities.listGuestProfiles(),
        repositories.identities.listExternalIdentities(),
        repositories.identities.listSubjects(),
      ]);
      return page(
        'ゲスト',
        'ゲストのスポンサー、有効期限、レビュー状況を管理します。',
        renderGuestsAdmin({ guests, identities, subjects, capabilities }),
      );
    }
    case '/admin/applications': {
      const [applications, entitlements] = await Promise.all([
        repositories.catalog.listApplications(),
        repositories.catalog.listApplicationEntitlements(),
      ]);
      return page(
        'アプリケーション',
        'ポータルに表示するアプリケーションと権限を管理します。',
        renderApplicationsAdmin({ applications, entitlements, capabilities }),
      );
    }
    case '/admin/groups': {
      const [groups, runs, directorySources] = await Promise.all([
        repositories.catalog.listSourceGroups(),
        repositories.directory.listDirectorySyncRuns(),
        repositories.directory.listDirectorySources(),
      ]);
      return page(
        'Google グループ',
        'Google ディレクトリを同期し、グループと直接メンバー数を確認します。',
        renderGroupsAdmin({ groups, runs, directorySources, capabilities }),
      );
    }
    case '/admin/mappings': {
      const [mappings, groups, entitlements, provisioningTargets] = await Promise.all([
        repositories.catalog.listEntitlementMappings(),
        repositories.catalog.listSourceGroups(),
        repositories.catalog.listApplicationEntitlements(),
        repositories.provisioning.listProvisioningTargets(),
      ]);
      return page(
        '権限ルール',
        'Google グループとアプリケーション権限の対応を作成し、影響範囲を確認して有効化します。',
        renderMappingsAdmin({
          mappings,
          groups,
          entitlements,
          provisioningTargets,
          capabilities,
        }),
      );
    }
    case '/admin/provisioning': {
      const [states, plans, operations, exports] = await Promise.all([
        repositories.provisioning.listProvisioningStates(),
        repositories.provisioning.listOperationPlans(),
        repositories.provisioning.listOperations(),
        repositories.exports.listExportRecords(),
      ]);
      return page(
        '外部サービス連携',
        '外部サービスへの権限反映状況、変更プラン、実行結果を確認します。',
        renderProvisioningAdmin({ states, plans, operations, exports }),
      );
    }
    case '/admin/audit':
      return page(
        '監査',
        '設定やアクセス権を変更した操作を確認します。',
        renderAuditAdmin(await repositories.audit.listAuditEvents()),
      );
    case '/admin/settings': {
      const [
        directorySources,
        providerConnections,
        provisioningTargets,
        entitlements,
        auditEvents,
      ] = await Promise.all([
        repositories.directory.listDirectorySources(),
        repositories.provisioning.listProviderConnections(),
        repositories.provisioning.listProvisioningTargets(),
        repositories.catalog.listApplicationEntitlements(),
        repositories.audit.listAuditEvents(),
      ]);
      const lastConfigurationPlanHash = auditEvents.find(
        (event) =>
          typeof event.payload.configurationPlanHash === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(event.payload.configurationPlanHash),
      )?.payload.configurationPlanHash as string | undefined;
      return page(
        '設定',
        '組織設定、ディレクトリ、外部サービス接続、権限の反映先を管理します。',
        renderSettingsAdmin({
          settings,
          directorySources,
          providerConnections,
          provisioningTargets,
          entitlements,
          capabilities,
          ...(lastConfigurationPlanHash === undefined ? {} : { lastConfigurationPlanHash }),
        }),
      );
    }
    default:
      return null;
  }
}

function administrationCapabilities(roles: PlatformRole[]): AdministrationCapabilities {
  return {
    canManageConfiguration: roles.some((role) => role === 'admin' || role === 'operator'),
    canManageIdentities: roles.includes('admin'),
  };
}

async function applicationEntries(
  subject: Subject,
  repositories: AccessControlRepositories,
): Promise<ApplicationPortalEntry[]> {
  const [applications, entitlements, grants, states, targets, accounts, guest] = await Promise.all([
    repositories.catalog.listApplications(),
    repositories.catalog.listApplicationEntitlements(),
    repositories.catalog.listEffectiveGrants(subject.id),
    repositories.provisioning.listProvisioningStates(subject.id),
    repositories.provisioning.listProvisioningTargets(),
    repositories.provisioning.listProviderAccounts(subject.id),
    repositories.identities.getGuestProfile(subject.id),
  ]);
  const activeGrantEntitlementIds = new Set(
    grants.filter((grant) => grant.status === 'active').map((grant) => grant.entitlementId),
  );
  const relevantStateEntitlementIds = new Set(
    targets
      .filter((target) => states.some((state) => state.provisioningTargetId === target.id))
      .map((target) => target.applicationEntitlementId),
  );
  const entitlementsByApplication = groupEntitlements(entitlements);
  return applications
    .filter((application) => application.status === 'active')
    .flatMap((application) => {
      const candidates = entitlementsByApplication.get(application.id) ?? [];
      const effective = candidates.filter((entitlement) =>
        activeGrantEntitlementIds.has(entitlement.id),
      );
      const hasRelevantState = candidates.some((entitlement) =>
        relevantStateEntitlementIds.has(entitlement.id),
      );
      if (
        application.visibility !== 'all_active_subjects' &&
        effective.length === 0 &&
        !hasRelevantState
      ) {
        return [];
      }
      const availability = applicationAvailability({
        subject,
        ...(guest === null ? {} : { guestStatus: guest.status }),
        effectiveEntitlements: effective,
        states,
        applicationEntitlements: candidates,
        targets,
        providerAccounts: accounts,
      });
      return [
        {
          application,
          entitlements: effective,
          availability: availability.state,
          ...(availability.message === undefined ? {} : { actionMessage: availability.message }),
        },
      ];
    })
    .sort((left, right) => left.application.name.localeCompare(right.application.name));
}

export function applicationAvailability(input: {
  subject: Subject;
  guestStatus?: GuestProfile['status'];
  effectiveEntitlements: ApplicationEntitlement[];
  states: ProvisioningState[];
  applicationEntitlements: ApplicationEntitlement[];
  targets: ProvisioningTarget[];
  providerAccounts: ProviderAccount[];
}): { state: ApplicationPortalEntry['availability']; message?: string } {
  if (input.subject.status === 'suspended' || input.subject.directoryState === 'suspended')
    return { state: 'suspended' };
  if (input.guestStatus === 'expired') return { state: 'expired' };
  const entitlementIds = new Set(
    input.applicationEntitlements.map((entitlement) => entitlement.id),
  );
  const relatedTargets = input.targets.filter(
    (target) => target.status === 'active' && entitlementIds.has(target.applicationEntitlementId),
  );
  const targetIds = new Set(relatedTargets.map((target) => target.id));
  const providerConnectionIds = new Set(
    relatedTargets.map((target) => target.providerConnectionId),
  );
  const relevantStates = input.states.filter((state) => targetIds.has(state.provisioningTargetId));
  const pendingInvitation = input.providerAccounts.some(
    (account) =>
      account.subjectId === input.subject.id &&
      providerConnectionIds.has(account.providerConnectionId) &&
      account.status === 'pending_invitation',
  );
  if (relevantStates.some((state) => state.status === 'action_required'))
    return { state: 'action_required' };
  if (
    pendingInvitation ||
    relevantStates.some((state) =>
      ['pending', 'planned', 'waiting_for_invitation', 'waiting_for_login'].includes(state.status),
    )
  ) {
    return {
      state: 'pending',
      ...(pendingInvitation ? { message: '保留中の GitHub 組織招待を承認してください。' } : {}),
    };
  }
  if (
    input.effectiveEntitlements.length > 0 ||
    relevantStates.some((state) => state.status === 'converged')
  )
    return { state: 'available' };
  return { state: 'unavailable' };
}

function groupEntitlements(
  values: ApplicationEntitlement[],
): Map<string, ApplicationEntitlement[]> {
  const grouped = new Map<string, ApplicationEntitlement[]>();
  for (const entitlement of values) {
    const group = grouped.get(entitlement.applicationId) ?? [];
    group.push(entitlement);
    grouped.set(entitlement.applicationId, group);
  }
  return grouped;
}

function page(title: string, description: string, content: string) {
  return {
    title,
    description,
    content,
  };
}

async function requireSettings(
  repositories: AccessControlRepositories,
): Promise<OrganizationSettings> {
  const settings = await repositories.identities.getOrganizationSettings();
  if (settings === null) {
    throw new AccessControlError(
      503,
      'organization_not_bootstrapped',
      'Access Control has not been bootstrapped.',
    );
  }
  return settings;
}

function requireAdministrationRole(roles: PlatformRole[]): void {
  if (!roles.some((role) => ['admin', 'auditor', 'operator'].includes(role))) {
    throw new AccessControlError(
      403,
      'role_forbidden',
      'Administration requires an administrative role.',
    );
  }
}
