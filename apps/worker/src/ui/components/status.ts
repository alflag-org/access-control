import { escapeHtml } from '../formatting/html';

const successStates = new Set(['active', 'available', 'completed', 'converged', 'delivered']);
const warningStates = new Set([
  'action_required',
  'applying',
  'pending',
  'pending_invitation',
  'planned',
  'running',
  'verifying',
  'waiting_for_invitation',
  'waiting_for_login',
]);
const dangerStates = new Set(['blocked', 'expired', 'failed', 'retired', 'suspended']);

const displayLabels: Record<string, string> = {
  access: '権限付与',
  action_required: '操作が必要',
  active: '有効',
  admin: '管理者',
  all_active_subjects: 'すべての有効なユーザーとサービス',
  applying: '適用中',
  automatic: '自動反映',
  automation: '自動処理',
  available: '利用可能',
  blocked: 'ブロック',
  cancelled: 'キャンセル済み',
  complete: '完了',
  completed: '完了',
  converged: '同期済み',
  cloudflare_oidc: 'Cloudflare OIDC',
  cloudflare_saml: 'Cloudflare SAML',
  cloudflare_self_hosted: 'Cloudflare セルフホスト',
  cloudflare_access: 'Cloudflare Access',
  delivered: '配信済み',
  direct_google: 'Google 直接認証',
  disabled: '無効',
  dispatching: '配信中',
  draft: '下書き',
  drifted: '差分あり',
  entitled: '権限保有者',
  expired: '期限切れ',
  external_guest: '外部ゲスト',
  failed: '失敗',
  github: 'GitHub',
  github_organization_membership: 'GitHub 組織メンバー',
  github_team_membership: 'GitHub チームメンバー',
  google: 'Google',
  human: 'ユーザー',
  jit: '初回利用時に反映',
  managed_guest: 'ゲスト',
  member: 'メンバー',
  missing: '未検出',
  no: 'いいえ',
  none: 'なし',
  observe: '状態のみ確認',
  observed: '観測済み',
  operator: '運用担当',
  pending: '保留',
  pending_invitation: '招待承認待ち',
  persisted: '保存済み',
  posix: 'POSIX',
  posix_account: 'POSIX アカウント',
  posix_group_membership: 'POSIX グループメンバー',
  posix_sudo: 'POSIX sudo 権限',
  present: '付与済み',
  plan: '変更を計画',
  planned: '計画済み',
  proxmox: 'Proxmox VE',
  proxmox_group_membership: 'Proxmox グループメンバー',
  retired: '廃止',
  running: '実行中',
  service: 'サービスアカウント',
  service_account: 'サービスアカウント',
  skipped: 'スキップ',
  succeeded: '成功',
  suspended: '停止中',
  superseded: '置換済み',
  auditor: '監査担当',
  unavailable: '利用不可',
  unknown: '不明',
  unmanaged: '反映対象外',
  verifying: '検証中',
  waiting_for_invitation: '招待待ち',
  waiting_for_login: 'ログイン待ち',
  workload: '自動処理',
  yes: 'はい',
  absent: '未付与',
  zabbix: 'Zabbix',
  zabbix_saml_mapping: 'Zabbix SAML マッピング',
  zabbix_scim_membership: 'Zabbix SCIM メンバー',
};

export function renderStatus(value: string, label = formatDomainValue(value)): string {
  const tone = successStates.has(value)
    ? 'success'
    : warningStates.has(value)
      ? 'warning'
      : dangerStates.has(value)
        ? 'danger'
        : value === 'missing' || value === 'disabled' || value === 'unavailable'
          ? 'neutral'
          : 'info';
  return `<span class="status status-${tone}">${escapeHtml(label)}</span>`;
}

export function formatDomainValue(value: string): string {
  return displayLabels[value] ?? value;
}
