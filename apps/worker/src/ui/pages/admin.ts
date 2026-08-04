import type {
  Application,
  AuditEvent,
  DirectorySource,
  DirectorySyncRun,
  EntitlementMapping,
  ExportRecord,
  GuestProfile,
  Operation,
  OperationPlan,
  OrganizationSettings,
  ProviderConnection,
  ProvisioningState,
  ProvisioningTarget,
  SourceGroup,
  Subject,
} from '@access-control/domain';
import { formatDomainValue, renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, formatIdentifier } from '../formatting/html';

export function renderPeopleAdmin(subjects: Subject[]): string {
  const users = subjects.filter((subject) => subject.kind === 'human');
  const services = subjects.filter((subject) => subject.kind !== 'human');
  return `<section class="section section-first"><div class="section-header"><h2>ユーザー</h2><span class="count">${users.length}</span></div>${
    users.length === 0
      ? emptyAdminState('ユーザーは登録されていません。')
      : renderTable(
          'ユーザー',
          [
            {
              label: 'ユーザー',
              render: (subject) =>
                `<strong>${escapeHtml(subject.displayName)}</strong>${subject.primaryEmail === undefined ? '' : `<br><span class="count">${escapeHtml(subject.primaryEmail)}</span>`}`,
            },
            { label: 'ユーザー ID', render: (subject) => formatIdentifier(subject.id) },
            {
              label: 'ユーザー種別',
              render: (subject) => escapeHtml(formatDomainValue(subject.classification)),
            },
            {
              label: 'ディレクトリ同期',
              render: (subject) => renderStatus(subject.directoryState),
            },
            { label: '利用状態', render: (subject) => renderStatus(subject.status) },
          ],
          users,
        )
  }</section>
  <section class="section"><div class="section-header"><h2>サービスと自動処理</h2><span class="count">${services.length}</span></div>${
    services.length === 0
      ? emptyAdminState('サービスアカウントや自動処理は登録されていません。')
      : renderTable(
          'サービスアカウントと自動処理',
          [
            {
              label: '名前',
              render: (subject) => `<strong>${escapeHtml(subject.displayName)}</strong>`,
            },
            { label: 'ID', render: (subject) => formatIdentifier(subject.id) },
            {
              label: '実行種別',
              render: (subject) => escapeHtml(formatDomainValue(subject.kind)),
            },
            {
              label: '用途',
              render: (subject) => escapeHtml(formatDomainValue(subject.classification)),
            },
            { label: '利用状態', render: (subject) => renderStatus(subject.status) },
          ],
          services,
        )
  }</section>`;
}

export function renderGuestsAdmin(guests: GuestProfile[]): string {
  return renderTable(
    'ゲスト',
    [
      { label: 'ユーザー ID', render: (guest) => formatIdentifier(guest.subjectId) },
      { label: 'スポンサー ID', render: (guest) => formatIdentifier(guest.sponsorSubjectId) },
      { label: '所属組織', render: (guest) => escapeHtml(guest.externalOrganization) },
      {
        label: '次回レビュー',
        render: (guest) =>
          escapeHtml(guest.nextReviewAt === undefined ? '未設定' : formatDate(guest.nextReviewAt)),
      },
      { label: '有効期限', render: (guest) => escapeHtml(formatDate(guest.expiresAt)) },
      { label: '利用状態', render: (guest) => renderStatus(guest.status) },
      { label: 'リビジョン', render: (guest) => String(guest.revision) },
    ],
    guests,
  );
}

export function renderApplicationsAdmin(applications: Application[]): string {
  return `<section class="form-panel" aria-labelledby="create-application-heading"><h2 id="create-application-heading">アプリケーションを作成</h2><form data-json-form action="/api/v1/applications" method="post"><div class="form-grid">
    ${field('key', 'アプリケーションキー（作成後は変更不可）', 'source-control', true)}
    ${field('name', '名前', 'ソース管理', true)}
    ${field('category', 'カテゴリ', '開発', true)}
    ${field('launchUrl', '起動 URL', 'https://source.example.org', true, 'url')}
    ${field('description', '説明', 'リポジトリとコードレビュー', false, 'text', true)}
    <div class="field"><label for="status">状態</label><select id="status" name="status"><option value="active">有効</option><option value="disabled">無効</option></select></div>
    <div class="field"><label for="visibility">表示対象</label><select id="visibility" name="visibility"><option value="entitled">権限を持つユーザーとサービス</option><option value="all_active_subjects">すべての有効なユーザーとサービス</option></select></div>
    <div class="field"><label for="authenticationType">認証</label><select id="authenticationType" name="authenticationType"><option value="cloudflare_oidc">Cloudflare OIDC</option><option value="cloudflare_saml">Cloudflare SAML</option><option value="cloudflare_self_hosted">Cloudflare セルフホスト</option><option value="direct_google">Google 直接認証</option><option value="none">なし</option></select></div>
    ${field('authenticationReference', '認証設定 ID', 'cloudflare-access-app-reference')}
    <div class="field"><label for="provisioningMode">権限の反映方法</label><select id="provisioningMode" name="provisioningMode"><option value="none">反映しない</option><option value="jit">初回利用時に反映</option><option value="observe">状態のみ確認</option><option value="plan">変更を計画</option><option value="automatic">自動で反映</option></select></div>
  </div><div class="form-actions"><button class="button button-primary" type="submit">アプリケーションを作成</button></div><p class="form-result" role="status" aria-live="polite"></p></form></section>
  <section class="section"><div class="section-header"><h2>カタログ</h2><span class="count">${applications.length}</span></div>${renderTable(
    'アプリケーションカタログ',
    [
      {
        label: 'アプリケーション',
        render: (application) =>
          `<strong>${escapeHtml(application.name)}</strong><br>${formatIdentifier(application.key)}`,
      },
      { label: 'カテゴリ', render: (application) => escapeHtml(application.category) },
      {
        label: '表示対象',
        render: (application) => escapeHtml(formatDomainValue(application.visibility)),
      },
      {
        label: '権限の反映',
        render: (application) => renderStatus(application.provisioningMode),
      },
      { label: '状態', render: (application) => renderStatus(application.status) },
      { label: 'リビジョン', render: (application) => String(application.revision) },
    ],
    applications,
  )}</section>`;
}

export function renderGroupsAdmin(groups: SourceGroup[], runs: DirectorySyncRun[]): string {
  const lastRun = runs[0];
  return `${
    lastRun === undefined
      ? ''
      : `<div class="notice"><span class="notice-symbol" aria-hidden="true">i</span><div><strong>最終同期: ${escapeHtml(formatDomainValue(lastRun.status))}</strong><p>ユーザー ${lastRun.userCount} 件 · グループ ${lastRun.groupCount} 件 · 要確認 ${lastRun.violationCount} 件</p></div></div>`
  }${renderTable(
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
    groups,
  )}`;
}

export function renderMappingsAdmin(mappings: EntitlementMapping[]): string {
  return `${renderTable(
    '権限ルール',
    [
      { label: 'ルール ID', render: (mapping) => formatIdentifier(mapping.id) },
      { label: 'Google グループ ID', render: (mapping) => formatIdentifier(mapping.sourceGroupId) },
      {
        label: 'アプリケーション権限 ID',
        render: (mapping) => mapping.entitlementIds.map(formatIdentifier).join('<br>'),
      },
      { label: '状態', render: (mapping) => renderStatus(mapping.status) },
      { label: 'リビジョン', render: (mapping) => String(mapping.revision) },
    ],
    mappings,
  )}<section class="section"><div class="notice notice-warning"><span class="notice-symbol" aria-hidden="true">!</span><div><strong>有効化前に影響範囲の確認が必要です</strong><p>最新のプレビューで、対象ユーザーと権限数が確認済みの内容と一致した場合だけ有効化されます。</p></div></div></section>`;
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
  lastConfigurationPlanHash?: string;
}): string {
  const settings = input.settings;
  return `<dl class="detail-list"><dt>組織名</dt><dd>${escapeHtml(settings.organizationName)}</dd><dt>ポータル名</dt><dd>${escapeHtml(settings.title)}</dd><dt>サポート URL</dt><dd>${escapeHtml(settings.supportUrl ?? '未設定')}</dd><dt>1 回の変更上限</dt><dd>${settings.maxPlanChanges}</dd><dt>リビジョン</dt><dd>${settings.revision}</dd><dt>最終適用プラン</dt><dd>${input.lastConfigurationPlanHash === undefined ? '未記録' : formatIdentifier(input.lastConfigurationPlanHash)}</dd></dl>
  <section class="section"><div class="section-header"><h2>Google ディレクトリ</h2><span class="count">${input.directorySources.length}</span></div>${renderTable(
    'Google ディレクトリ',
    [
      { label: 'ディレクトリ ID', render: (source) => formatIdentifier(source.id) },
      {
        label: 'サービス',
        render: (source) => escapeHtml(formatDomainValue(source.provider)),
      },
      { label: '状態', render: (source) => renderStatus(source.status) },
      { label: 'リビジョン', render: (source) => String(source.revision) },
    ],
    input.directorySources,
  )}</section>
  <section class="section"><div class="section-header"><h2>外部サービス接続</h2><span class="count">${input.providerConnections.length}</span></div>${renderTable(
    '外部サービス接続',
    [
      { label: '接続 ID', render: (connection) => formatIdentifier(connection.id) },
      {
        label: '外部サービス',
        render: (connection) => escapeHtml(formatDomainValue(connection.provider)),
      },
      { label: '変更モード', render: (connection) => renderStatus(connection.mode) },
      { label: '状態', render: (connection) => renderStatus(connection.status) },
      { label: 'リビジョン', render: (connection) => String(connection.revision) },
    ],
    input.providerConnections,
  )}</section>
  <section class="section"><div class="section-header"><h2>権限の反映先</h2><span class="count">${input.provisioningTargets.length}</span></div>${renderTable(
    '権限の反映先',
    [
      { label: '反映先 ID', render: (target) => formatIdentifier(target.id) },
      {
        label: '反映内容',
        render: (target) => escapeHtml(formatDomainValue(target.targetType)),
      },
      { label: '変更モード', render: (target) => renderStatus(target.mode) },
      { label: '保護', render: (target) => renderStatus(target.protected ? 'yes' : 'no') },
      { label: '状態', render: (target) => renderStatus(target.status) },
      { label: 'リビジョン', render: (target) => String(target.revision) },
    ],
    input.provisioningTargets,
  )}</section>`;
}

function field(
  name: string,
  label: string,
  placeholder: string,
  required = false,
  type = 'text',
  wide = false,
): string {
  return `<div class="field${wide ? ' field-wide' : ''}"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" placeholder="${escapeHtml(placeholder)}"${required ? ' required' : ''}></div>`;
}

function emptyAdminState(message: string): string {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}
