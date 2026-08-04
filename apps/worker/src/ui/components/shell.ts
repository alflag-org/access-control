import type { OrganizationSettings, PlatformRole, Subject } from '@access-control/domain';
import { escapeHtml } from '../formatting/html';
import { systemStyles } from '../styles/system';

interface NavigationItem {
  href: string;
  label: string;
}

const portalNavigation: NavigationItem[] = [
  { href: '/applications', label: 'アプリケーション' },
  { href: '/access', label: '自分のアクセス' },
];

const administrationNavigation: NavigationItem[] = [
  { href: '/admin/people', label: 'ユーザーとサービス' },
  { href: '/admin/guests', label: 'ゲスト' },
  { href: '/admin/applications', label: 'アプリケーション' },
  { href: '/admin/groups', label: 'Google グループ' },
  { href: '/admin/mappings', label: '権限ルール' },
  { href: '/admin/provisioning', label: '外部サービス連携' },
  { href: '/admin/audit', label: '監査' },
  { href: '/admin/settings', label: '設定' },
];

export interface PageShellInput {
  pathname: string;
  title: string;
  description: string;
  content: string;
  organizationSettings: OrganizationSettings;
  subject: Subject;
  roles: PlatformRole[];
}

export function renderPageShell(input: PageShellInput): string {
  const admin = input.pathname.startsWith('/admin/');
  const canAdmin = input.roles.some((role) => ['admin', 'auditor', 'operator'].includes(role));
  const organizationTitle = input.organizationSettings.title;
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${escapeHtml(input.description)}">
    <meta name="color-scheme" content="light">
    <link rel="icon" href="data:,">
    <title>${escapeHtml(input.title)} · ${escapeHtml(organizationTitle)}</title>
    <style>${systemStyles}</style>
  </head>
  <body>
    <a class="skip-link" href="#main">本文へ移動</a>
    <header class="app-header">
      <div class="header-inner">
        <a class="brand" href="/applications"><span class="brand-mark" aria-hidden="true">AC</span><span>${escapeHtml(organizationTitle)}</span></a>
        <nav class="primary-nav" aria-label="メインナビゲーション">
          ${portalNavigation.map((item) => navigationLink(item, input.pathname)).join('')}
          ${canAdmin ? navigationLink({ href: '/admin/people', label: '管理' }, input.pathname, admin) : ''}
        </nav>
        <div class="header-actions">
          <a class="account-link" href="/account"${input.pathname === '/account' ? ' aria-current="page"' : ''} aria-label="アカウント: ${escapeHtml(input.subject.displayName)}">
            <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18"><path d="M10 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0H3Z" fill="currentColor"/></svg>
            <span class="account-name">${escapeHtml(input.subject.displayName)}</span>
          </a>
        </div>
      </div>
    </header>
    <div class="layout">
      ${
        admin
          ? `<nav class="side-nav" aria-label="管理メニュー"><h2>管理</h2>${administrationNavigation
              .map((item) => navigationLink(item, input.pathname))
              .join('')}</nav>`
          : ''
      }
      <main id="main"${admin ? '' : ' style="grid-column: 1 / -1"'}>
        <header class="page-header"><div class="page-header-copy"><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.description)}</p></div></header>
        ${input.content}
      </main>
    </div>
    ${
      input.organizationSettings.supportUrl === undefined
        ? ''
        : `<footer class="footer"><a href="${escapeHtml(input.organizationSettings.supportUrl)}">サポート</a></footer>`
    }
    <script type="module" src="/assets/forms.js"></script>
  </body>
</html>`;
}

function navigationLink(item: NavigationItem, pathname: string, forceCurrent = false): string {
  const current = forceCurrent || pathname === item.href || pathname.startsWith(`${item.href}/`);
  return `<a href="${item.href}"${current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
}

export function renderAccessRequiredShell(input: {
  issuer: string;
  providerSubject: string;
  canonicalIdentity: string;
}): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="data:,"> <title>Access Control の利用登録が見つかりません</title><style>${systemStyles}</style></head><body><main class="access-required"><span class="brand-mark" aria-hidden="true">AC</span><h1>Access Control の利用登録が見つかりません</h1><p>認証 ID と一致する有効なユーザーまたはサービスアカウントがありません。</p><dl class="detail-list"><dt>発行元</dt><dd><code>${escapeHtml(input.issuer)}</code></dd><dt>プロバイダー内 ID</dt><dd><code>${escapeHtml(input.providerSubject)}</code></dd><dt>認証 ID</dt><dd><code>${escapeHtml(input.canonicalIdentity)}</code></dd></dl><div class="notice"><span class="notice-symbol" aria-hidden="true">i</span><p>この画面の認証 ID を Access Control 管理者へ伝えてください。</p></div></main></body></html>`;
}
