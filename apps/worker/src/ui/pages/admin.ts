import type {
  Application,
  ApplicationEntitlement,
  AuditEvent,
  DirectorySource,
  DirectorySyncRun,
  EntitlementMapping,
  ExternalIdentity,
  ExportRecord,
  GuestProfile,
  Operation,
  OperationPlan,
  OrganizationSettings,
  PlatformRoleGrant,
  ProviderConnection,
  ProvisioningState,
  ProvisioningTarget,
  SourceGroup,
  Subject,
} from '@access-control/domain';
import {
  renderCheckbox,
  renderHiddenField,
  renderJsonForm,
  renderMultiSelectField,
  renderSelectField,
  renderTextArea,
  renderTextField,
  type SelectOption,
} from '../components/form';
import { formatDomainValue, renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, formatIdentifier } from '../formatting/html';

export interface AdministrationCapabilities {
  canManageConfiguration: boolean;
  canManageIdentities: boolean;
}

export function renderPeopleAdmin(input: {
  subjects: Subject[];
  roleGrants: PlatformRoleGrant[];
  capabilities: AdministrationCapabilities;
}): string {
  const users = input.subjects.filter((subject) => subject.kind === 'human');
  const services = input.subjects.filter((subject) => subject.kind !== 'human');
  return `${renderSubjectSection('ユーザー', users, input.roleGrants, input.capabilities)}
  ${renderSubjectSection('サービスと自動処理', services, input.roleGrants, input.capabilities)}`;
}

export function renderGuestsAdmin(input: {
  guests: GuestProfile[];
  identities: ExternalIdentity[];
  subjects: Subject[];
  capabilities: AdministrationCapabilities;
}): string {
  const subjects = new Map(input.subjects.map((subject) => [subject.id, subject]));
  const activeSponsors = input.subjects.filter((subject) => subject.status === 'active');
  const createForm = input.capabilities.canManageIdentities
    ? `<details class="create-disclosure create-disclosure-panel"><summary>ゲストを作成</summary>${renderJsonForm(
        {
          action: '/api/v1/guests',
          method: 'post',
          submitLabel: 'ゲストを作成',
          body: `<div class="form-grid">
            ${renderTextField({ id: 'guest-display-name', name: 'displayName', label: '名前', required: true, autocomplete: 'off' })}
            ${renderTextField({ id: 'guest-primary-email', name: 'primaryEmail', label: 'メールアドレス（任意）', type: 'email', autocomplete: 'off' })}
            ${renderSelectField({ id: 'guest-sponsor', name: 'sponsorSubjectId', label: 'スポンサー', value: activeSponsors[0]?.id ?? '', required: true, options: activeSponsors.map(subjectOption) })}
            ${renderTextField({ id: 'guest-contact-email', name: 'externalContactEmail', label: '外部連絡先メール', type: 'email', required: true, autocomplete: 'off' })}
            ${renderTextField({ id: 'guest-organization', name: 'externalOrganization', label: '所属組織', required: true, autocomplete: 'off' })}
            ${renderTextArea({ id: 'guest-purpose', name: 'purpose', label: '利用目的', required: true, wide: true, rows: 3 })}
            ${renderTextField({ id: 'guest-valid-from', name: 'validFrom', label: '利用開始', type: 'datetime-local', valueType: 'datetime', required: true })}
            ${renderTextField({ id: 'guest-expires-at', name: 'expiresAt', label: '有効期限', type: 'datetime-local', valueType: 'datetime', required: true })}
            ${renderTextField({ id: 'guest-next-review', name: 'nextReviewAt', label: '次回レビュー（任意）', type: 'datetime-local', valueType: 'datetime' })}
          </div>`,
        },
      )}</details>`
    : readOnlyNotice('ゲストの作成と停止には管理者ロールが必要です。');
  const records = input.guests.map((guest, index) => {
    const subject = subjects.get(guest.subjectId);
    const identities = input.identities.filter(
      (identity) => identity.subjectId === guest.subjectId,
    );
    const canSuspend =
      input.capabilities.canManageIdentities &&
      subject !== undefined &&
      !['suspended', 'expired', 'retired'].includes(guest.status);
    const suspension = canSuspend
      ? `<section class="editor-section"><h3>ゲストを停止</h3><p class="editor-help">停止すると、このゲストの利用状態とゲスト記録を同時に停止します。</p>${renderJsonForm(
          {
            action: `/api/v1/guests/${escapeHtml(guest.subjectId)}`,
            method: 'patch',
            submitLabel: 'ゲストを停止',
            submitTone: 'danger',
            confirmMessage: `${subject.displayName} のアクセスを停止します。よろしいですか？`,
            body: `${renderHiddenField({ name: 'expectedSubjectRevision', value: subject.revision, valueType: 'number' })}${renderHiddenField({ name: 'expectedGuestRevision', value: guest.revision, valueType: 'number' })}${renderHiddenField({ name: 'confirmed', value: true, valueType: 'boolean' })}`,
          },
        )}</section>`
      : '';
    const identityManagement =
      input.capabilities.canManageIdentities &&
      subject !== undefined &&
      !['expired', 'retired'].includes(guest.status)
        ? renderGuestIdentityForm(subject, identities, index)
        : renderGuestIdentities(identities);
    return renderRecord({
      title: subject?.displayName ?? guest.subjectId,
      identifier: guest.subjectId,
      metadata: [
        guest.externalOrganization,
        `スポンサー: ${subjectName(subjects, guest.sponsorSubjectId)}`,
      ],
      status: guest.status,
      actionLabel: canSuspend ? '管理' : '詳細',
      body: `<dl class="record-details"><dt>外部連絡先</dt><dd>${escapeHtml(guest.externalContactEmail)}</dd><dt>利用目的</dt><dd>${escapeHtml(guest.purpose)}</dd><dt>利用開始</dt><dd>${escapeHtml(formatDate(guest.validFrom))}</dd><dt>有効期限</dt><dd>${escapeHtml(formatDate(guest.expiresAt))}</dd><dt>次回レビュー</dt><dd>${guest.nextReviewAt === undefined ? '未設定' : escapeHtml(formatDate(guest.nextReviewAt))}</dd><dt>リビジョン</dt><dd>${guest.revision}</dd></dl>${identityManagement}${suspension}`,
    });
  });
  return `${createForm}<section class="section"><div class="section-header"><h2>登録済みゲスト</h2><span class="count">${input.guests.length}</span></div>${renderRecordList('登録済みゲスト', records, 'ゲストは登録されていません。')}</section>`;
}

export function renderApplicationsAdmin(input: {
  applications: Application[];
  entitlements: ApplicationEntitlement[];
  capabilities: AdministrationCapabilities;
}): string {
  const createForm = input.capabilities.canManageConfiguration
    ? `<details class="create-disclosure create-disclosure-panel"><summary>アプリケーションを作成</summary>${renderJsonForm(
        {
          action: '/api/v1/applications',
          method: 'post',
          submitLabel: 'アプリケーションを作成',
          body: `<div class="form-grid">${applicationFields({ prefix: 'create-application', capabilities: input.capabilities })}</div>`,
        },
      )}</details>`
    : readOnlyNotice('アプリケーション設定の変更には管理者または運用担当ロールが必要です。');
  const records = input.applications.map((application, index) => {
    const entitlements = input.entitlements.filter(
      (entitlement) => entitlement.applicationId === application.id,
    );
    const applicationForm = input.capabilities.canManageConfiguration
      ? `<section class="editor-section"><h3>アプリケーション設定</h3>${renderJsonForm({
          action: `/api/v1/applications/${escapeHtml(application.id)}`,
          method: 'patch',
          submitLabel: '設定を保存',
          body: `${renderHiddenField({ name: 'expectedRevision', value: application.revision, valueType: 'number' })}<div class="form-grid">${applicationFields({ prefix: `application-${index}`, application, capabilities: input.capabilities })}</div>`,
        })}</section>`
      : '';
    return renderRecord({
      title: application.name,
      identifier: application.key,
      metadata: [application.category, formatDomainValue(application.visibility)],
      status: application.status,
      actionLabel: input.capabilities.canManageConfiguration ? '編集' : '詳細',
      body: `${applicationForm}${renderEntitlements(
        application,
        entitlements,
        index,
        input.capabilities,
      )}`,
    });
  });
  return `${createForm}<section class="section"><div class="section-header"><h2>アプリケーションカタログ</h2><span class="count">${input.applications.length}</span></div>${renderRecordList('アプリケーションカタログ', records, 'アプリケーションは登録されていません。')}</section>`;
}

export function renderGroupsAdmin(input: {
  groups: SourceGroup[];
  runs: DirectorySyncRun[];
  directorySources: DirectorySource[];
  capabilities: AdministrationCapabilities;
}): string {
  const lastRun = input.runs[0];
  const syncSources = input.directorySources.filter((source) => source.status === 'active');
  const synchronize =
    input.capabilities.canManageConfiguration && syncSources.length > 0
      ? `<section class="form-panel compact-panel" aria-labelledby="sync-directory-heading"><h2 id="sync-directory-heading">Google ディレクトリを同期</h2><p class="editor-help">全ページを取得して検証し、完全なスナップショットだけを公開します。</p>${renderJsonForm(
          {
            action: '/api/v1/sync-runs/google-directory',
            method: 'post',
            submitLabel: '同期を開始',
            confirmMessage: 'Google ディレクトリの完全同期を開始します。よろしいですか？',
            body: `<div class="form-grid single-field">${renderSelectField({ id: 'sync-directory-source', name: 'directorySourceId', label: 'ディレクトリ', value: syncSources[0]?.id ?? '', required: true, options: syncSources.map(directorySourceOption) })}</div>`,
          },
        )}</section>`
      : '';
  return `${
    lastRun === undefined
      ? ''
      : `<div class="notice"><span class="notice-symbol" aria-hidden="true">i</span><div><strong>最終同期: ${escapeHtml(formatDomainValue(lastRun.status))}</strong><p>ユーザー ${lastRun.userCount} 件 · グループ ${lastRun.groupCount} 件 · 要確認 ${lastRun.violationCount} 件</p></div></div>`
  }${synchronize}<section class="section${lastRun === undefined && synchronize.length === 0 ? ' section-first' : ''}">${renderTable(
    'Google グループ',
    [
      {
        label: 'グループ',
        render: (group) =>
          `<strong>${escapeHtml(group.name)}</strong><br>${escapeHtml(group.email)}`,
      },
      { label: '用途', render: (group) => renderStatus(group.kind) },
      { label: '直接メンバー数', render: (group) => String(group.directMemberCount) },
      { label: '状態', render: (group) => renderStatus(group.status) },
      { label: 'リビジョン', render: (group) => String(group.revision) },
    ],
    input.groups,
  )}</section>`;
}

export function renderMappingsAdmin(input: {
  mappings: EntitlementMapping[];
  groups: SourceGroup[];
  entitlements: ApplicationEntitlement[];
  provisioningTargets: ProvisioningTarget[];
  capabilities: AdministrationCapabilities;
}): string {
  const activeGroups = input.groups.filter((group) => group.status === 'active');
  const activeEntitlements = input.entitlements.filter(
    (entitlement) => entitlement.status === 'active',
  );
  const canCreate =
    input.capabilities.canManageConfiguration &&
    activeGroups.length > 0 &&
    activeEntitlements.length > 0;
  const createForm = canCreate
    ? `<details class="create-disclosure create-disclosure-panel"><summary>権限ルールを作成</summary>${renderJsonForm(
        {
          action: '/api/v1/mappings',
          method: 'post',
          submitLabel: '下書きを作成',
          body: `<div class="form-grid">
            ${renderSelectField({ id: 'mapping-source-group', name: 'sourceGroupId', label: 'Google グループ', value: activeGroups[0]?.id ?? '', required: true, options: activeGroups.map(groupOption) })}
            ${renderMultiSelectField({ id: 'mapping-entitlements', name: 'entitlementIds', label: 'アプリケーション権限', values: [], required: true, wide: true, hint: 'Ctrl または Command キーを押しながら複数選択できます。', options: activeEntitlements.map(entitlementOption) })}
            ${renderMultiSelectField({ id: 'mapping-targets', name: 'provisioningTargetIds', label: '外部サービスへの反映先（任意）', values: [], wide: true, hint: '権限に対応する反映先だけを選択してください。', options: input.provisioningTargets.filter((target) => target.status === 'active').map(targetOption) })}
            ${renderTextField({ id: 'mapping-valid-from', name: 'validFrom', label: '有効期間の開始（任意）', type: 'datetime-local', valueType: 'datetime' })}
            ${renderTextField({ id: 'mapping-valid-until', name: 'validUntil', label: '有効期間の終了（任意）', type: 'datetime-local', valueType: 'datetime' })}
          </div>`,
        },
      )}</details>`
    : input.capabilities.canManageConfiguration
      ? readOnlyNotice(
          '権限ルールを作成するには、有効な Google グループとアプリケーション権限が必要です。',
        )
      : readOnlyNotice('権限ルールの変更には管理者または運用担当ロールが必要です。');
  const records = input.mappings.map((mapping, index) => {
    const group = input.groups.find((item) => item.id === mapping.sourceGroupId);
    const action = renderMappingAction(mapping, index, input.capabilities);
    return renderRecord({
      title: group?.name ?? mapping.sourceGroupId,
      identifier: mapping.id,
      metadata: [
        `権限 ${mapping.entitlementIds.length} 件`,
        `反映先 ${mapping.provisioningTargetIds.length} 件`,
      ],
      status: mapping.status,
      actionLabel: action.length > 0 ? '管理' : '詳細',
      body: `<dl class="record-details"><dt>Google グループ ID</dt><dd>${formatIdentifier(mapping.sourceGroupId)}</dd><dt>アプリケーション権限</dt><dd>${mapping.entitlementIds.map(formatIdentifier).join('<br>')}</dd><dt>外部サービスへの反映先</dt><dd>${mapping.provisioningTargetIds.length === 0 ? 'なし' : mapping.provisioningTargetIds.map(formatIdentifier).join('<br>')}</dd><dt>有効期間</dt><dd>${escapeHtml(mapping.validFrom === undefined ? '指定なし' : formatDate(mapping.validFrom))} 〜 ${escapeHtml(mapping.validUntil === undefined ? '指定なし' : formatDate(mapping.validUntil))}</dd><dt>リビジョン</dt><dd>${mapping.revision}</dd></dl>${action}`,
    });
  });
  return `${createForm}<section class="section"><div class="section-header"><h2>登録済みルール</h2><span class="count">${input.mappings.length}</span></div>${renderRecordList('権限ルール', records, '権限ルールは登録されていません。')}</section><section class="section"><div class="notice notice-warning"><span class="notice-symbol" aria-hidden="true">!</span><div><strong>有効化前に影響範囲の確認が必要です</strong><p>最新のプレビューで確認した対象ユーザーを、そのまま送信した場合だけ有効化されます。</p></div></div></section>`;
}

export function renderProvisioningAdmin(input: {
  states: ProvisioningState[];
  plans: OperationPlan[];
  operations: Operation[];
  exports: ExportRecord[];
}): string {
  return `<div class="notice"><span class="notice-symbol" aria-hidden="true">i</span><div><strong>外部サービスの変更は自動実行されません</strong><p>実行には、確認済みの変更プランと外部サービスの書き込み設定が必要です。保護対象を含む変更は実行できません。</p></div></div>
  <section class="section"><div class="section-header"><h2>反映状況</h2><span class="count">${input.states.length}</span></div>${renderTable(
    '外部サービスへの反映状況',
    [
      {
        label: 'ユーザー / サービス / 自動処理 ID',
        render: (state) => formatIdentifier(state.subjectId),
      },
      { label: '反映先 ID', render: (state) => formatIdentifier(state.provisioningTargetId) },
      {
        label: '期待する状態 / 確認した状態',
        render: (state) =>
          `${escapeHtml(formatDomainValue(state.desiredState))} / ${escapeHtml(formatDomainValue(state.observedState))}`,
      },
      { label: '状態', render: (state) => renderStatus(state.status) },
    ],
    input.states,
  )}</section>
  <section class="section"><div class="section-header"><h2>変更プラン</h2><span class="count">${input.plans.length}</span></div>${renderTable(
    '変更プラン',
    [
      { label: 'プラン ID', render: (plan) => formatIdentifier(plan.id) },
      { label: 'ハッシュ', render: (plan) => formatIdentifier(plan.planHash) },
      {
        label: '破壊的変更',
        render: (plan) => renderStatus(plan.destructive ? 'action_required' : 'no'),
      },
      {
        label: '保護対象',
        render: (plan) => renderStatus(plan.protected ? 'blocked' : 'no'),
      },
    ],
    input.plans,
  )}</section>
  <section class="section"><div class="section-header"><h2>実行結果</h2><span class="count">${input.operations.length}</span></div>${renderTable(
    '実行結果',
    [
      { label: '実行 ID', render: (operation) => formatIdentifier(operation.id) },
      { label: 'プラン ID', render: (operation) => formatIdentifier(operation.operationPlanId) },
      { label: '状態', render: (operation) => renderStatus(operation.status) },
      { label: 'リビジョン', render: (operation) => String(operation.revision) },
    ],
    input.operations,
  )}</section>
  <section class="section"><div class="section-header"><h2>エクスポート</h2><span class="count">${input.exports.length}</span></div>${renderTable(
    'エクスポート',
    [
      { label: 'エクスポート', render: (record) => formatIdentifier(record.id) },
      { label: '状態', render: (record) => renderStatus(record.status) },
      {
        label: 'オブジェクトキー',
        render: (record) => escapeHtml(record.objectKey ?? '未生成'),
      },
      { label: 'リビジョン', render: (record) => String(record.revision) },
    ],
    input.exports,
  )}</section>`;
}

export function renderAuditAdmin(events: AuditEvent[]): string {
  return renderTable(
    '監査イベント',
    [
      { label: '発生日時', render: (event) => escapeHtml(formatDate(event.occurredAt)) },
      {
        label: 'イベント',
        render: (event) =>
          `<strong>${escapeHtml(event.eventType)}</strong><br>${escapeHtml(event.action)}`,
      },
      {
        label: '実行者',
        render: (event) =>
          event.actorSubjectId === undefined ? 'システム' : formatIdentifier(event.actorSubjectId),
      },
      {
        label: '対象',
        render: (event) => `${escapeHtml(event.targetType)}<br>${formatIdentifier(event.targetId)}`,
      },
      { label: '結果', render: (event) => renderStatus(event.result) },
    ],
    events,
  );
}

export function renderSettingsAdmin(input: {
  settings: OrganizationSettings;
  directorySources: DirectorySource[];
  providerConnections: ProviderConnection[];
  provisioningTargets: ProvisioningTarget[];
  entitlements: ApplicationEntitlement[];
  capabilities: AdministrationCapabilities;
  lastConfigurationPlanHash?: string;
}): string {
  return `${renderOrganizationSettings(input)}
  ${renderDirectorySources(input.directorySources, input.capabilities)}
  ${renderProviderConnections(input.providerConnections, input.capabilities)}
  ${renderProvisioningTargets(
    input.provisioningTargets,
    input.providerConnections,
    input.entitlements,
    input.capabilities,
  )}`;
}

function renderGuestIdentityForm(
  subject: Subject,
  identities: ExternalIdentity[],
  index: number,
): string {
  return `<section class="editor-section"><h3>認証 ID</h3>${renderIdentityList(identities)}<details class="sub-editor"><summary>認証 ID を追加</summary>${renderJsonForm(
    {
      action: `/api/v1/subjects/${escapeHtml(subject.id)}/identities`,
      method: 'post',
      submitLabel: '認証 ID を追加',
      confirmMessage:
        'プロバイダー内の変更できない ID を、このゲストに関連付けます。よろしいですか？',
      body: `${renderHiddenField({ name: 'expectedSubjectRevision', value: subject.revision, valueType: 'number' })}${renderHiddenField({ name: 'confirmed', value: true, valueType: 'boolean' })}<div class="form-grid">${renderSelectField({ id: `guest-identity-provider-${index}`, name: 'provider', label: 'ID プロバイダー', value: 'google', required: true, identityProvider: true, options: identityProviderOptions })}${renderTextField({ id: `guest-identity-issuer-${index}`, name: 'issuer', label: '発行元', placeholder: 'urn:google-directory:customer:customer-id', required: true, wide: true, hint: 'Google は Customer ID を含む URN、GitHub は https://github.com を使います。' })}${renderTextField({ id: `guest-identity-subject-${index}`, name: 'providerSubject', label: 'プロバイダー内の変更できない ID', required: true, wide: true, autocomplete: 'off' })}</div>`,
    },
  )}</details></section>`;
}

function renderGuestIdentities(identities: ExternalIdentity[]): string {
  return `<section class="editor-section"><h3>認証 ID</h3>${renderIdentityList(identities)}</section>`;
}

function renderIdentityList(identities: ExternalIdentity[]): string {
  if (identities.length === 0) {
    return '<p class="editor-help">認証 ID は関連付けられていません。</p>';
  }
  return `<ul class="identity-list">${identities
    .map(
      (identity) =>
        `<li><span><strong>${escapeHtml(formatDomainValue(identity.provider))}</strong><br><code>${escapeHtml(identity.issuer)}</code> · <code>${escapeHtml(identity.providerSubject)}</code></span>${renderStatus(identity.status)}</li>`,
    )
    .join('')}</ul>`;
}

function renderSubjectSection(
  title: string,
  subjects: Subject[],
  roleGrants: PlatformRoleGrant[],
  capabilities: AdministrationCapabilities,
): string {
  const records = subjects.map((subject, index) => {
    const grants = roleGrants.filter((grant) => grant.subjectId === subject.id);
    const activeGrants = grants.filter((grant) => grant.active);
    const body = `<dl class="record-details"><dt>種別</dt><dd>${escapeHtml(formatDomainValue(subject.classification))}</dd><dt>ディレクトリ同期</dt><dd>${renderStatus(subject.directoryState)}</dd><dt>保護対象</dt><dd>${renderStatus(subject.protected ? 'yes' : 'no')}</dd><dt>管理ロール</dt><dd>${activeGrants.length === 0 ? 'なし' : activeGrants.map((grant) => `<span class="tag">${escapeHtml(formatDomainValue(grant.role))}</span>`).join(' ')}</dd><dt>リビジョン</dt><dd>${subject.revision}</dd></dl>${
      capabilities.canManageIdentities ? renderSubjectActions(subject, grants, index) : ''
    }`;
    return renderRecord({
      title: subject.displayName,
      identifier: subject.id,
      metadata: [
        subject.primaryEmail ?? formatDomainValue(subject.classification),
        formatDomainValue(subject.directoryState),
      ],
      status: subject.status,
      actionLabel: capabilities.canManageIdentities ? '管理' : '詳細',
      body,
    });
  });
  return `<section class="section${title === 'ユーザー' ? ' section-first' : ''}"><div class="section-header"><h2>${escapeHtml(title)}</h2><span class="count">${subjects.length}</span></div>${renderRecordList(title, records, `${title}は登録されていません。`)}</section>`;
}

function renderSubjectActions(
  subject: Subject,
  grants: PlatformRoleGrant[],
  index: number,
): string {
  const activeRoles = new Set<string>(
    grants.filter((grant) => grant.active).map((grant) => grant.role),
  );
  const availableRoles = roleOptions.filter((option) => !activeRoles.has(option.value));
  const statusForm = renderJsonForm({
    action: `/api/v1/subjects/${escapeHtml(subject.id)}`,
    method: 'patch',
    submitLabel: '利用状態を保存',
    confirmMessage: `${subject.displayName} の利用状態を変更します。よろしいですか？`,
    body: `${renderHiddenField({ name: 'expectedRevision', value: subject.revision, valueType: 'number' })}${renderHiddenField({ name: 'confirmed', value: true, valueType: 'boolean' })}<div class="form-grid single-field">${renderSelectField({ id: `subject-status-${index}`, name: 'status', label: '利用状態', value: subject.status, required: true, options: subjectStatusOptions })}</div>`,
  });
  const grantForm =
    subject.status !== 'active'
      ? '<p class="editor-help">ロールを付与する前に、利用状態を有効にしてください。</p>'
      : availableRoles.length === 0
        ? '<p class="editor-help">すべての管理ロールが付与されています。</p>'
        : renderJsonForm({
            action: `/api/v1/subjects/${escapeHtml(subject.id)}/platform-role-grants`,
            method: 'post',
            submitLabel: 'ロールを付与',
            body: `${renderHiddenField({ name: 'expectedSubjectRevision', value: subject.revision, valueType: 'number' })}<div class="form-grid single-field">${renderSelectField({ id: `subject-role-${index}`, name: 'role', label: '付与する管理ロール', value: availableRoles[0]?.value ?? '', required: true, options: availableRoles })}</div>`,
          });
  const removalForms = grants
    .filter((grant) => grant.active)
    .map(
      (grant) =>
        `<div class="role-action"><span>${escapeHtml(formatDomainValue(grant.role))}${grant.protected ? ' · 保護対象' : ''}</span>${
          grant.protected
            ? ''
            : renderJsonForm({
                action: `/api/v1/platform-role-grants/${escapeHtml(grant.id)}`,
                method: 'patch',
                submitLabel: '解除',
                submitTone: 'danger',
                className: 'inline-action-form',
                confirmMessage: `${subject.displayName} の ${formatDomainValue(grant.role)} ロールを解除します。よろしいですか？`,
                body: `${renderHiddenField({ name: 'expectedRevision', value: grant.revision, valueType: 'number' })}${renderHiddenField({ name: 'confirmed', value: true, valueType: 'boolean' })}`,
              })
        }</div>`,
    )
    .join('');
  return `<section class="editor-section"><h3>利用状態</h3>${statusForm}</section><section class="editor-section"><h3>管理ロール</h3>${grantForm}${removalForms.length === 0 ? '' : `<div class="role-actions">${removalForms}</div>`}</section>`;
}

function applicationFields(input: {
  prefix: string;
  capabilities: AdministrationCapabilities;
  application?: Application;
}): string {
  const application = input.application;
  const authentication = application?.authentication;
  const statusOptions = application === undefined ? activeDisabledOptions : lifecycleStatusOptions;
  const automaticDisabled =
    !input.capabilities.canManageIdentities && application?.provisioningMode !== 'automatic';
  return `${
    application === undefined
      ? renderTextField({
          id: `${input.prefix}-key`,
          name: 'key',
          label: 'アプリケーションキー（作成後は変更不可）',
          placeholder: 'source-control',
          required: true,
        })
      : ''
  }${renderTextField({ id: `${input.prefix}-name`, name: 'name', label: '名前', value: application?.name, required: true })}${renderTextField({ id: `${input.prefix}-category`, name: 'category', label: 'カテゴリ', value: application?.category, required: true })}${renderTextField({ id: `${input.prefix}-launch-url`, name: 'launchUrl', label: '起動 URL', value: application?.launchUrl, type: 'url', required: true })}${renderTextArea({ id: `${input.prefix}-description`, name: 'description', label: '説明', value: application?.description, wide: true, nullable: application !== undefined, rows: 3 })}${renderSelectField({ id: `${input.prefix}-status`, name: 'status', label: '状態', value: application?.status ?? 'active', required: true, options: statusOptions })}${renderSelectField({ id: `${input.prefix}-visibility`, name: 'visibility', label: '表示対象', value: application?.visibility ?? 'entitled', required: true, options: visibilityOptions })}${renderSelectField({ id: `${input.prefix}-authentication-type`, name: 'authenticationType', label: '認証', value: authentication?.type ?? 'cloudflare_oidc', required: true, options: authenticationOptions })}${renderTextField({ id: `${input.prefix}-authentication-reference`, name: 'authenticationReference', label: '認証設定 ID', value: authentication?.reference, hint: 'Cloudflare 認証では必須です。認証情報そのものは入力しません。' })}${renderSelectField({ id: `${input.prefix}-provisioning-mode`, name: 'provisioningMode', label: '権限の反映方法', value: application?.provisioningMode ?? 'none', required: true, options: provisioningModeOptions.map((option) => ({ ...option, disabled: option.value === 'automatic' && automaticDisabled })) })}`;
}

function renderEntitlements(
  application: Application,
  entitlements: ApplicationEntitlement[],
  applicationIndex: number,
  capabilities: AdministrationCapabilities,
): string {
  const create = capabilities.canManageConfiguration
    ? `<details class="sub-editor"><summary>アプリケーション権限を追加</summary>${renderJsonForm({
        action: `/api/v1/applications/${escapeHtml(application.id)}/entitlements`,
        method: 'post',
        submitLabel: '権限を追加',
        body: `<div class="form-grid">${renderTextField({ id: `entitlement-key-${applicationIndex}`, name: 'key', label: '権限キー（作成後は変更不可）', required: true })}${renderTextField({ id: `entitlement-name-${applicationIndex}`, name: 'name', label: '名前', required: true })}${renderTextArea({ id: `entitlement-description-${applicationIndex}`, name: 'description', label: '説明（任意）', wide: true, rows: 2 })}${renderSelectField({ id: `entitlement-status-${applicationIndex}`, name: 'status', label: '状態', value: 'active', required: true, options: activeDisabledOptions })}${renderCheckbox({ id: `entitlement-provisioning-${applicationIndex}`, name: 'requiresProvisioning', label: '外部サービスへの権限反映が必要', checked: false })}</div>`,
      })}</details>`
    : '';
  const rows = entitlements
    .map((entitlement, entitlementIndex) => {
      const form = capabilities.canManageConfiguration
        ? renderJsonForm({
            action: `/api/v1/applications/${escapeHtml(application.id)}/entitlements/${escapeHtml(entitlement.id)}`,
            method: 'patch',
            submitLabel: '権限を保存',
            body: `${renderHiddenField({ name: 'expectedRevision', value: entitlement.revision, valueType: 'number' })}<div class="form-grid">${renderTextField({ id: `entitlement-name-${applicationIndex}-${entitlementIndex}`, name: 'name', label: '名前', value: entitlement.name, required: true })}${renderTextArea({ id: `entitlement-description-${applicationIndex}-${entitlementIndex}`, name: 'description', label: '説明', value: entitlement.description, wide: true, nullable: true, rows: 2 })}${renderSelectField({ id: `entitlement-status-${applicationIndex}-${entitlementIndex}`, name: 'status', label: '状態', value: entitlement.status, required: true, options: lifecycleStatusOptions })}${renderCheckbox({ id: `entitlement-provisioning-${applicationIndex}-${entitlementIndex}`, name: 'requiresProvisioning', label: '外部サービスへの権限反映が必要', checked: entitlement.requiresProvisioning })}</div>`,
          })
        : '';
      return `<details class="sub-editor"><summary><span><strong>${escapeHtml(entitlement.name)}</strong> <code>${escapeHtml(entitlement.key)}</code></span>${renderStatus(entitlement.status)}</summary><div class="sub-editor-body"><p class="editor-help">${escapeHtml(entitlement.description ?? '説明はありません。')} · リビジョン ${entitlement.revision}</p>${form}</div></details>`;
    })
    .join('');
  return `<section class="editor-section"><div class="section-header"><h3>アプリケーション権限</h3><span class="count">${entitlements.length}</span></div>${create}${rows.length === 0 ? emptyAdminState('アプリケーション権限は登録されていません。') : `<div class="sub-editor-list">${rows}</div>`}</section>`;
}

function renderMappingAction(
  mapping: EntitlementMapping,
  index: number,
  capabilities: AdministrationCapabilities,
): string {
  if (!capabilities.canManageConfiguration || mapping.status === 'retired') return '';
  if (mapping.status === 'active') {
    return `<section class="editor-section"><h3>権限ルールを廃止</h3>${renderJsonForm({
      action: `/api/v1/mappings/${escapeHtml(mapping.id)}/retire`,
      method: 'post',
      submitLabel: 'ルールを廃止',
      submitTone: 'danger',
      confirmMessage: 'この権限ルールを廃止し、影響する権限を再計算します。よろしいですか？',
      body: renderHiddenField({
        name: 'expectedRevision',
        value: mapping.revision,
        valueType: 'number',
      }),
    })}</section>`;
  }
  const previewId = `mapping-preview-${index}`;
  return `<section class="editor-section"><h3>影響範囲を確認して有効化</h3><p class="editor-help">確認後に表示される対象件数を読み、有効化を明示的に実行してください。</p>${renderJsonForm(
    {
      action: `/api/v1/mappings/${escapeHtml(mapping.id)}/preview`,
      method: 'post',
      submitLabel: '影響範囲を確認',
      submitTone: 'secondary',
      reload: false,
      previewOutputId: previewId,
      body: renderHiddenField({
        name: 'expectedRevision',
        value: mapping.revision,
        valueType: 'number',
      }),
    },
  )}<div class="preview-result" id="${previewId}" tabindex="-1" hidden><strong data-preview-summary></strong>${renderJsonForm(
    {
      action: `/api/v1/mappings/${escapeHtml(mapping.id)}/activate`,
      method: 'post',
      submitLabel: '確認した内容で有効化',
      confirmMessage: '表示された対象ユーザーに権限を反映します。よろしいですか？',
      body: `${renderHiddenField({ name: 'expectedRevision', value: mapping.revision, valueType: 'number' })}${renderHiddenField({ name: 'confirmedAffectedSubjectIds', value: '[]', valueType: 'json' })}`,
    },
  )}</div></section>`;
}

function renderOrganizationSettings(input: {
  settings: OrganizationSettings;
  capabilities: AdministrationCapabilities;
  lastConfigurationPlanHash?: string;
}): string {
  const settings = input.settings;
  if (!input.capabilities.canManageIdentities) {
    return `<dl class="detail-list"><dt>組織名</dt><dd>${escapeHtml(settings.organizationName)}</dd><dt>ポータル名</dt><dd>${escapeHtml(settings.title)}</dd><dt>サポート URL</dt><dd>${escapeHtml(settings.supportUrl ?? '未設定')}</dd><dt>ブランドマーク URL</dt><dd>${escapeHtml(settings.brandMarkUrl ?? '未設定')}</dd><dt>1 回の変更上限</dt><dd>${settings.maxPlanChanges}</dd><dt>リビジョン</dt><dd>${settings.revision}</dd><dt>最終適用プラン</dt><dd>${input.lastConfigurationPlanHash === undefined ? '未記録' : formatIdentifier(input.lastConfigurationPlanHash)}</dd></dl>${readOnlyNotice('組織設定の変更には管理者ロールが必要です。')}`;
  }
  return `<section class="form-panel" aria-labelledby="organization-settings-heading"><div class="section-header"><h2 id="organization-settings-heading">組織設定</h2><span class="count">リビジョン ${settings.revision}</span></div>${renderJsonForm(
    {
      action: '/api/v1/organization-settings',
      method: 'patch',
      submitLabel: '組織設定を保存',
      body: `${renderHiddenField({ name: 'expectedRevision', value: settings.revision, valueType: 'number' })}<div class="form-grid">${renderTextField({ id: 'organization-name', name: 'organizationName', label: '組織名', value: settings.organizationName, required: true })}${renderTextField({ id: 'organization-title', name: 'title', label: 'ポータル名', value: settings.title, required: true })}${renderTextField({ id: 'organization-support-url', name: 'supportUrl', label: 'サポート URL', value: settings.supportUrl, type: 'url', nullable: true })}${renderTextField({ id: 'organization-brand-mark-url', name: 'brandMarkUrl', label: 'ブランドマーク URL', value: settings.brandMarkUrl, type: 'url', nullable: true })}${renderTextField({ id: 'organization-max-plan-changes', name: 'maxPlanChanges', label: '1 回の変更上限', value: settings.maxPlanChanges, type: 'number', valueType: 'number', required: true })}</div>`,
    },
  )}<p class="editor-help">最終適用プラン: ${input.lastConfigurationPlanHash === undefined ? '未記録' : formatIdentifier(input.lastConfigurationPlanHash)}</p></section>`;
}

function renderDirectorySources(
  sources: DirectorySource[],
  capabilities: AdministrationCapabilities,
): string {
  const create = capabilities.canManageConfiguration
    ? `<details class="create-disclosure"><summary>Google ディレクトリを追加</summary>${renderJsonForm(
        {
          action: '/api/v1/directory-sources',
          method: 'post',
          submitLabel: 'ディレクトリを追加',
          body: `${renderHiddenField({ name: 'provider', value: 'google' })}<div class="form-grid">${directorySourceFields('create-directory', undefined, capabilities)}</div>`,
        },
      )}</details>`
    : '';
  const records = sources.map((source, index) => {
    const form = capabilities.canManageConfiguration
      ? renderJsonForm({
          action: `/api/v1/directory-sources/${escapeHtml(source.id)}`,
          method: 'patch',
          submitLabel: 'ディレクトリを保存',
          body: `${renderHiddenField({ name: 'expectedRevision', value: source.revision, valueType: 'number' })}<div class="form-grid">${directorySourceFields(`directory-${index}`, source, capabilities)}</div>`,
        })
      : '';
    return renderRecord({
      title: source.delegatedAdmin,
      identifier: source.id,
      metadata: [source.customerId, source.accessGroupPrefix],
      status: source.status,
      actionLabel: capabilities.canManageConfiguration ? '編集' : '詳細',
      body: `<dl class="record-details"><dt>認証情報の参照名</dt><dd>${formatIdentifier(source.credentialRef)}</dd><dt>リビジョン</dt><dd>${source.revision}</dd></dl>${form}`,
    });
  });
  return `<section class="section"><div class="section-header"><h2>Google ディレクトリ</h2><span class="count">${sources.length}</span></div>${create}${renderRecordList('Google ディレクトリ', records, 'Google ディレクトリは登録されていません。')}</section>`;
}

function directorySourceFields(
  prefix: string,
  source: DirectorySource | undefined,
  capabilities: AdministrationCapabilities,
): string {
  return `${source === undefined ? renderTextField({ id: `${prefix}-id`, name: 'id', label: 'ディレクトリ ID（作成後は変更不可）', required: true }) : ''}${renderTextField({ id: `${prefix}-customer`, name: 'customerId', label: 'Google Customer ID', value: source?.customerId, required: true, readonly: source !== undefined && !capabilities.canManageIdentities })}${renderTextField({ id: `${prefix}-delegated-admin`, name: 'delegatedAdmin', label: '委任管理者メール', value: source?.delegatedAdmin, type: 'email', required: true })}${renderTextField({ id: `${prefix}-credential`, name: 'credentialRef', label: '認証情報の参照名', value: source?.credentialRef, required: true, readonly: source !== undefined && !capabilities.canManageIdentities, hint: 'Worker の Secret バインディング名を入力します。' })}${renderTextField({ id: `${prefix}-group-prefix`, name: 'accessGroupPrefix', label: 'アクセスグループ接頭辞', value: source?.accessGroupPrefix, required: true })}${renderSelectField({ id: `${prefix}-status`, name: 'status', label: '状態', value: source?.status ?? 'active', required: true, options: source === undefined ? activeDisabledOptions : lifecycleStatusOptions })}`;
}

function renderProviderConnections(
  connections: ProviderConnection[],
  capabilities: AdministrationCapabilities,
): string {
  const create = capabilities.canManageConfiguration
    ? `<details class="create-disclosure"><summary>外部サービス接続を追加</summary>${renderJsonForm(
        {
          action: '/api/v1/provider-connections',
          method: 'post',
          submitLabel: '接続を追加',
          body: `<div class="form-grid">${providerConnectionFields('create-connection', undefined, capabilities)}</div>`,
        },
      )}</details>`
    : '';
  const records = connections.map((connection, index) => {
    const form = capabilities.canManageConfiguration
      ? renderJsonForm({
          action: `/api/v1/provider-connections/${escapeHtml(connection.id)}`,
          method: 'patch',
          submitLabel: '接続を保存',
          body: `${renderHiddenField({ name: 'expectedRevision', value: connection.revision, valueType: 'number' })}<div class="form-grid">${providerConnectionFields(`connection-${index}`, connection, capabilities)}</div>`,
        })
      : '';
    return renderRecord({
      title: connection.name,
      identifier: connection.id,
      metadata: [formatDomainValue(connection.provider), formatDomainValue(connection.mode)],
      status: connection.status,
      actionLabel: capabilities.canManageConfiguration ? '編集' : '詳細',
      body: `<dl class="record-details"><dt>認証情報の参照名</dt><dd>${connection.credentialRef === undefined ? '未設定' : formatIdentifier(connection.credentialRef)}</dd><dt>構成</dt><dd><code>${escapeHtml(JSON.stringify(connection.configuration))}</code></dd><dt>リビジョン</dt><dd>${connection.revision}</dd></dl>${form}`,
    });
  });
  return `<section class="section"><div class="section-header"><h2>外部サービス接続</h2><span class="count">${connections.length}</span></div>${create}${renderRecordList('外部サービス接続', records, '外部サービス接続は登録されていません。')}</section>`;
}

function providerConnectionFields(
  prefix: string,
  connection: ProviderConnection | undefined,
  capabilities: AdministrationCapabilities,
): string {
  const automaticDisabled = !capabilities.canManageIdentities && connection?.mode !== 'automatic';
  return `${connection === undefined ? renderTextField({ id: `${prefix}-id`, name: 'id', label: '接続 ID（作成後は変更不可）', required: true }) + renderSelectField({ id: `${prefix}-provider`, name: 'provider', label: '外部サービス', value: 'google', required: true, options: providerOptions }) : ''}${renderTextField({ id: `${prefix}-name`, name: 'name', label: '名前', value: connection?.name, required: true })}${renderSelectField({ id: `${prefix}-mode`, name: 'mode', label: '変更モード', value: connection?.mode ?? 'observe', required: true, options: reconciliationModeOptions.map((option) => ({ ...option, disabled: option.value === 'automatic' && automaticDisabled })) })}${renderTextField({ id: `${prefix}-credential`, name: 'credentialRef', label: '認証情報の参照名（任意）', value: connection?.credentialRef, nullable: connection !== undefined && capabilities.canManageIdentities, readonly: connection !== undefined && !capabilities.canManageIdentities, hint: 'Worker の Secret バインディング名だけを入力します。' })}${renderTextArea({ id: `${prefix}-configuration`, name: 'configuration', label: '非機密の構成（JSON）', value: JSON.stringify(connection?.configuration ?? {}, null, 2), valueType: 'json', wide: true, required: true, rows: 5, hint: 'GitHub 接続では organization と、必要に応じて teamSlugs を指定します。' })}${renderSelectField({ id: `${prefix}-status`, name: 'status', label: '状態', value: connection?.status ?? 'active', required: true, options: connection === undefined ? activeDisabledOptions : lifecycleStatusOptions })}`;
}

function renderProvisioningTargets(
  targets: ProvisioningTarget[],
  connections: ProviderConnection[],
  entitlements: ApplicationEntitlement[],
  capabilities: AdministrationCapabilities,
): string {
  const canCreate =
    capabilities.canManageConfiguration && connections.length > 0 && entitlements.length > 0;
  const create = canCreate
    ? `<details class="create-disclosure"><summary>権限の反映先を追加</summary>${renderJsonForm({
        action: '/api/v1/provisioning-targets',
        method: 'post',
        submitLabel: '反映先を追加',
        body: `<div class="form-grid">${provisioningTargetFields('create-target', undefined, connections, entitlements, capabilities)}</div>`,
      })}</details>`
    : '';
  const records = targets.map((target, index) => {
    const connection = connections.find((item) => item.id === target.providerConnectionId);
    const form = capabilities.canManageConfiguration
      ? renderJsonForm({
          action: `/api/v1/provisioning-targets/${escapeHtml(target.id)}`,
          method: 'patch',
          submitLabel: '反映先を保存',
          body: `${renderHiddenField({ name: 'expectedRevision', value: target.revision, valueType: 'number' })}<div class="form-grid">${provisioningTargetFields(`target-${index}`, target, connections, entitlements, capabilities)}</div>`,
        })
      : '';
    return renderRecord({
      title: formatDomainValue(target.targetType),
      identifier: target.id,
      metadata: [connection?.name ?? target.providerConnectionId, target.providerTargetId],
      status: target.status,
      actionLabel: capabilities.canManageConfiguration ? '編集' : '詳細',
      body: `<dl class="record-details"><dt>アプリケーション権限</dt><dd>${formatIdentifier(target.applicationEntitlementId)}</dd><dt>変更モード</dt><dd>${renderStatus(target.mode)}</dd><dt>保護対象</dt><dd>${renderStatus(target.protected ? 'yes' : 'no')}</dd><dt>構成</dt><dd><code>${escapeHtml(JSON.stringify(target.configuration))}</code></dd><dt>リビジョン</dt><dd>${target.revision}</dd></dl>${form}`,
    });
  });
  const dependencyNotice =
    capabilities.canManageConfiguration && !canCreate
      ? '<p class="editor-help">反映先を追加するには、外部サービス接続とアプリケーション権限が必要です。</p>'
      : '';
  return `<section class="section"><div class="section-header"><h2>権限の反映先</h2><span class="count">${targets.length}</span></div>${dependencyNotice}${create}${renderRecordList('権限の反映先', records, '権限の反映先は登録されていません。')}</section>`;
}

function provisioningTargetFields(
  prefix: string,
  target: ProvisioningTarget | undefined,
  connections: ProviderConnection[],
  entitlements: ApplicationEntitlement[],
  capabilities: AdministrationCapabilities,
): string {
  const automaticDisabled = !capabilities.canManageIdentities && target?.mode !== 'automatic';
  const protectedField =
    target !== undefined && target.protected && !capabilities.canManageIdentities
      ? `${renderHiddenField({ name: 'protected', value: true, valueType: 'boolean' })}<div class="field field-wide"><span class="field-label">保護対象</span><span class="field-hint">保護の解除には管理者ロールが必要です。</span></div>`
      : renderCheckbox({
          id: `${prefix}-protected`,
          name: 'protected',
          label: '保護対象にする',
          checked: target?.protected ?? false,
        });
  return `${target === undefined ? renderTextField({ id: `${prefix}-id`, name: 'id', label: '反映先 ID（作成後は変更不可）', required: true }) + renderSelectField({ id: `${prefix}-connection`, name: 'providerConnectionId', label: '外部サービス接続', value: connections[0]?.id ?? '', required: true, options: connections.map(connectionOption) }) + renderSelectField({ id: `${prefix}-target-type`, name: 'targetType', label: '反映内容', value: targetTypeOptions[0]?.value ?? '', required: true, options: targetTypeOptions }) + renderTextField({ id: `${prefix}-provider-target`, name: 'providerTargetId', label: '外部サービス内の対象 ID', required: true }) : ''}${renderSelectField({ id: `${prefix}-entitlement`, name: 'applicationEntitlementId', label: 'アプリケーション権限', value: target?.applicationEntitlementId ?? entitlements[0]?.id ?? '', required: true, options: entitlements.map(entitlementOption) })}${renderSelectField({ id: `${prefix}-mode`, name: 'mode', label: '変更モード', value: target?.mode ?? 'observe', required: true, options: reconciliationModeOptions.map((option) => ({ ...option, disabled: option.value === 'automatic' && automaticDisabled })) })}${protectedField}${renderTextArea({ id: `${prefix}-configuration`, name: 'configuration', label: '非機密の構成（JSON）', value: JSON.stringify(target?.configuration ?? {}, null, 2), valueType: 'json', wide: true, required: true, rows: 4 })}${renderSelectField({ id: `${prefix}-status`, name: 'status', label: '状態', value: target?.status ?? 'active', required: true, options: target === undefined ? activeDisabledOptions : lifecycleStatusOptions })}`;
}

function renderRecord(input: {
  title: string;
  identifier: string;
  metadata: string[];
  status: string;
  actionLabel: string;
  body: string;
}): string {
  return `<details class="record-editor" role="listitem"><summary><span class="record-summary-main"><strong>${escapeHtml(input.title)}</strong><code>${escapeHtml(input.identifier)}</code></span><span class="record-summary-meta">${input.metadata.map(escapeHtml).join('<span aria-hidden="true"> · </span>')}</span><span class="record-summary-status">${renderStatus(input.status)}</span><span class="record-summary-action">${escapeHtml(input.actionLabel)}</span></summary><div class="record-editor-body">${input.body}</div></details>`;
}

function renderRecordList(label: string, records: string[], emptyMessage: string): string {
  return records.length === 0
    ? emptyAdminState(emptyMessage)
    : `<div class="record-list" role="list" aria-label="${escapeHtml(label)}">${records.join('')}</div>`;
}

function readOnlyNotice(message: string): string {
  return `<div class="notice"><span class="notice-symbol" aria-hidden="true">i</span><p>${escapeHtml(message)}</p></div>`;
}

function emptyAdminState(message: string): string {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function subjectName(subjects: Map<string, Subject>, id: string): string {
  return subjects.get(id)?.displayName ?? id;
}

function subjectOption(subject: Subject): SelectOption {
  return { value: subject.id, label: `${subject.displayName} (${subject.id})` };
}

function directorySourceOption(source: DirectorySource): SelectOption {
  return { value: source.id, label: `${source.delegatedAdmin} (${source.id})` };
}

function groupOption(group: SourceGroup): SelectOption {
  return { value: group.id, label: `${group.name} (${group.email})` };
}

function entitlementOption(entitlement: ApplicationEntitlement): SelectOption {
  return { value: entitlement.id, label: `${entitlement.name} (${entitlement.key})` };
}

function targetOption(target: ProvisioningTarget): SelectOption {
  return { value: target.id, label: `${formatDomainValue(target.targetType)} (${target.id})` };
}

function connectionOption(connection: ProviderConnection): SelectOption {
  return {
    value: connection.id,
    label: `${connection.name} (${formatDomainValue(connection.provider)})`,
  };
}

const subjectStatusOptions: readonly SelectOption[] = [
  { value: 'pending', label: '保留' },
  { value: 'active', label: '有効' },
  { value: 'suspended', label: '停止中' },
  { value: 'retired', label: '廃止' },
];
const activeDisabledOptions: readonly SelectOption[] = [
  { value: 'active', label: '有効' },
  { value: 'disabled', label: '無効' },
];
const lifecycleStatusOptions: readonly SelectOption[] = [
  ...activeDisabledOptions,
  { value: 'retired', label: '廃止' },
];
const roleOptions: readonly SelectOption[] = [
  { value: 'admin', label: '管理者' },
  { value: 'operator', label: '運用担当' },
  { value: 'auditor', label: '監査担当' },
];
const visibilityOptions: readonly SelectOption[] = [
  { value: 'entitled', label: '権限を持つユーザーとサービス' },
  { value: 'all_active_subjects', label: 'すべての有効なユーザーとサービス' },
];
const authenticationOptions: readonly SelectOption[] = [
  { value: 'cloudflare_oidc', label: 'Cloudflare OIDC' },
  { value: 'cloudflare_saml', label: 'Cloudflare SAML' },
  { value: 'cloudflare_self_hosted', label: 'Cloudflare セルフホスト' },
  { value: 'direct_google', label: 'Google 直接認証' },
  { value: 'none', label: 'なし' },
];
const identityProviderOptions: readonly SelectOption[] = [
  { value: 'google', label: 'Google' },
  { value: 'github', label: 'GitHub' },
];
const provisioningModeOptions: readonly SelectOption[] = [
  { value: 'none', label: '反映しない' },
  { value: 'jit', label: '初回利用時に反映' },
  { value: 'observe', label: '状態のみ確認' },
  { value: 'plan', label: '変更を計画' },
  { value: 'automatic', label: '自動で反映' },
];
const reconciliationModeOptions: readonly SelectOption[] = [
  { value: 'observe', label: '状態のみ確認' },
  { value: 'plan', label: '変更を計画' },
  { value: 'automatic', label: '自動で反映' },
];
const providerOptions: readonly SelectOption[] = [
  { value: 'google', label: 'Google' },
  { value: 'github', label: 'GitHub' },
  { value: 'proxmox', label: 'Proxmox VE' },
  { value: 'zabbix', label: 'Zabbix' },
  { value: 'posix', label: 'POSIX' },
];
const targetTypeOptions: readonly SelectOption[] = [
  { value: 'github_organization_membership', label: 'GitHub 組織メンバー' },
  { value: 'github_team_membership', label: 'GitHub チームメンバー' },
  { value: 'proxmox_group_membership', label: 'Proxmox グループメンバー' },
  { value: 'zabbix_saml_mapping', label: 'Zabbix SAML マッピング' },
  { value: 'zabbix_scim_membership', label: 'Zabbix SCIM メンバー' },
  { value: 'posix_account', label: 'POSIX アカウント' },
  { value: 'posix_group_membership', label: 'POSIX グループメンバー' },
  { value: 'posix_sudo', label: 'POSIX sudo 権限' },
];
