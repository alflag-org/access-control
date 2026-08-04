import type {
  Application,
  ApplicationEntitlement,
  EffectiveGrant,
  ExternalIdentity,
  GuestProfile,
  ProviderAccount,
  ProvisioningState,
  SourceGroup,
  Subject,
} from '@access-control/domain';
import { formatDomainValue, renderStatus } from '../components/status';
import { renderTable } from '../components/table';
import { escapeHtml, formatDate, formatIdentifier } from '../formatting/html';

export interface ApplicationPortalEntry {
  application: Application;
  entitlements: ApplicationEntitlement[];
  availability:
    'action_required' | 'available' | 'expired' | 'pending' | 'suspended' | 'unavailable';
  actionMessage?: string;
}

export function renderApplicationsPage(entries: ApplicationPortalEntry[]): string {
  if (entries.length === 0) {
    return emptyState(
      '表示できるアプリケーションがありません',
      '利用可能になったアプリケーションはここに表示されます。',
    );
  }
  return `<div class="application-grid">${entries
    .map(({ application, entitlements, availability, actionMessage }) => {
      const canLaunch = availability === 'available';
      return `<article class="application-card">
        <div class="card-meta">${renderStatus(availability)}<span class="category">${escapeHtml(application.category)}</span></div>
        <div><h2>${escapeHtml(application.name)}</h2><p>${escapeHtml(application.description ?? '説明はありません。')}</p></div>
        <div class="card-meta" aria-label="権限">${
          entitlements.length === 0
            ? '<span class="tag">権限なし</span>'
            : entitlements
                .map((entitlement) => `<span class="tag">${escapeHtml(entitlement.name)}</span>`)
                .join('')
        }</div>
        ${actionMessage === undefined ? '' : `<p><strong>${escapeHtml(actionMessage)}</strong></p>`}
        <div class="card-actions"><span class="category">${escapeHtml(formatDomainValue(application.authentication.type))}</span>${
          canLaunch
            ? `<a class="button button-primary" href="${escapeHtml(application.launchUrl)}" rel="noopener">開く</a>`
            : '<span class="button button-secondary" aria-disabled="true">利用不可</span>'
        }</div>
      </article>`;
    })
    .join('')}</div>`;
}

export function renderMyAccessPage(input: {
  grants: EffectiveGrant[];
  entitlements: Map<string, ApplicationEntitlement>;
  applications: Map<string, Application>;
  sourceGroups: Map<string, SourceGroup>;
  provisioningStates: ProvisioningState[];
}): string {
  if (input.grants.length === 0) {
    return emptyState(
      '付与されている権限はありません',
      'Google グループの所属に応じて付与された権限はここに表示されます。',
    );
  }
  return `<div class="section">${input.grants
    .map((grant) => {
      const entitlement = input.entitlements.get(grant.entitlementId);
      const application =
        entitlement === undefined ? undefined : input.applications.get(entitlement.applicationId);
      const sourceGroup = input.sourceGroups.get(grant.sourceGroupId);
      const states = input.provisioningStates.filter(
        (state) => state.subjectId === grant.subjectId,
      );
      return `<article class="provenance">
        <div class="section-header"><h2>${escapeHtml(application?.name ?? grant.entitlementId)} · ${escapeHtml(entitlement?.name ?? grant.entitlementId)}</h2>${renderStatus(grant.status)}</div>
        <p>${escapeHtml(entitlement?.description ?? 'Google グループへの所属により付与されている権限です。')}</p>
        <details><summary>付与元の詳細</summary>
          <dl class="detail-list">
            <dt>アプリケーション</dt><dd>${escapeHtml(application?.name ?? '不明なアプリケーション')}</dd>
            <dt>権限</dt><dd>${escapeHtml(entitlement?.name ?? grant.entitlementId)}</dd>
            <dt>Google グループ</dt><dd>${sourceGroup === undefined ? formatIdentifier(grant.sourceGroupId) : escapeHtml(sourceGroup.email)}</dd>
            <dt>メンバーシップ ID</dt><dd>${formatIdentifier(grant.sourceGroupMembershipId)}</dd>
            <dt>権限ルール ID</dt><dd>${formatIdentifier(grant.mappingId)}</dd>
            <dt>外部サービスへの反映</dt><dd>${states.length === 0 ? renderStatus('unmanaged') : states.map((state) => renderStatus(state.status)).join(' ')}</dd>
          </dl>
        </details>
      </article>`;
    })
    .join('')}</div>`;
}

export function renderAccountPage(input: {
  subject: Subject;
  identities: ExternalIdentity[];
  guestProfile: GuestProfile | null;
  providerAccounts: ProviderAccount[];
}): string {
  const accountOwnerLabel =
    input.subject.kind === 'human'
      ? 'ユーザー'
      : input.subject.kind === 'service'
        ? 'サービスアカウント'
        : '自動処理';
  const guestWarning = renderGuestWarning(input.guestProfile);
  const invitation = input.providerAccounts.some(
    (account) => account.status === 'pending_invitation',
  )
    ? '<div class="notice notice-warning"><span class="notice-symbol" aria-hidden="true">!</span><div><strong>GitHub 組織への招待が保留中です</strong><p>権限を反映するには、GitHub で招待を承認してください。</p></div></div>'
    : '';
  return `${guestWarning}${invitation}<section class="section"><h2>${accountOwnerLabel}情報</h2><dl class="detail-list">
    <dt>表示名</dt><dd>${escapeHtml(input.subject.displayName)}</dd>
    <dt>メールアドレス</dt><dd>${escapeHtml(input.subject.primaryEmail ?? '未登録')}</dd>
    <dt>区分</dt><dd>${escapeHtml(formatDomainValue(input.subject.classification))}</dd>
    <dt>利用状態</dt><dd>${renderStatus(input.subject.status)}</dd>
    <dt>ディレクトリ同期</dt><dd>${renderStatus(input.subject.directoryState)}</dd>
    <dt>${accountOwnerLabel} ID</dt><dd>${formatIdentifier(input.subject.id)}</dd>
  </dl></section>
  <section class="section"><div class="section-header"><h2>認証 ID</h2><span class="count">${input.identities.length}</span></div>${renderTable(
    '認証 ID',
    [
      {
        label: '認証プロバイダー',
        render: (identity) => escapeHtml(formatDomainValue(identity.provider)),
      },
      { label: '発行元', render: (identity) => formatIdentifier(identity.issuer) },
      {
        label: 'プロバイダー内 ID',
        render: (identity) => formatIdentifier(identity.providerSubject),
      },
      { label: '状態', render: (identity) => renderStatus(identity.status) },
    ],
    input.identities,
  )}</section>
  <section class="section"><div class="section-header"><h2>外部サービスのアカウント</h2><span class="count">${input.providerAccounts.length}</span></div>${
    input.providerAccounts.length === 0
      ? emptyState(
          '連携済みのアカウントはありません',
          '外部サービスでアカウントが確認されると、ここに表示されます。',
        )
      : renderTable(
          '外部サービスのアカウント',
          [
            {
              label: '接続 ID',
              render: (account) => formatIdentifier(account.providerConnectionId),
            },
            { label: '外部 ID', render: (account) => formatIdentifier(account.externalId) },
            { label: 'ログイン名', render: (account) => escapeHtml(account.login ?? '未検出') },
            { label: '状態', render: (account) => renderStatus(account.status) },
            {
              label: '検出日時',
              render: (account) => escapeHtml(formatDate(account.observedAt)),
            },
          ],
          input.providerAccounts,
        )
  }</section>`;
}

function renderGuestWarning(guest: GuestProfile | null): string {
  if (guest === null) return '';
  const remainingDays = Math.ceil((Date.parse(guest.expiresAt) - Date.now()) / 86_400_000);
  const urgent = remainingDays <= 14;
  const message = urgent
    ? 'ゲストアクセスの有効期限が近づいています'
    : 'ゲストアクセスには有効期限があります';
  return `<div class="notice ${urgent ? 'notice-warning' : ''}"><span class="notice-symbol" aria-hidden="true">${urgent ? '!' : 'i'}</span><div><strong>${message}</strong><p>スポンサー ID: ${escapeHtml(guest.sponsorSubjectId)} · 有効期限: ${escapeHtml(formatDate(guest.expiresAt))}</p></div></div>`;
}

function emptyState(title: string, body: string): string {
  return `<div class="empty-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></div>`;
}
