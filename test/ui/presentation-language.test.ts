import { describe, expect, it } from 'vitest';
import {
  createOrganizationSettingsCandidate,
  createSubjectCandidate,
} from '@access-control/domain';
import {
  renderAccessRequiredShell,
  renderPageShell,
} from '../../apps/worker/src/ui/components/shell';
import { renderPeopleAdmin } from '../../apps/worker/src/ui/pages/admin';
import { renderAccountPage } from '../../apps/worker/src/ui/pages/portal';
import { FIXTURE_TIME, googleIdentity, memberSubject } from '../fixtures/domain-fixtures';

const settings = createOrganizationSettingsCandidate({
  id: 'organization:settings',
  organizationName: 'Example Organization',
  title: 'Example Access Control',
  supportUrl: 'https://support.example.org',
  maxPlanChanges: 25,
  revision: 1,
  createdAt: FIXTURE_TIME,
  updatedAt: FIXTURE_TIME,
  createdBy: 'subject:member',
  updatedBy: 'subject:member',
});

describe('Portal information architecture and language', () => {
  it('uses the signed-in user as the account link instead of a primary navigation item', () => {
    const html = renderPageShell({
      pathname: '/account',
      title: 'アカウント',
      description: 'ユーザー情報を確認します。',
      content: '<p>Account content</p>',
      organizationSettings: settings,
      subject: memberSubject(),
      roles: ['admin'],
    });
    const primaryNavigation = html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0];

    expect(primaryNavigation).toBeDefined();
    expect(primaryNavigation).not.toContain('/account');
    expect(html).toContain(
      '<a class="account-link" href="/account" aria-current="page" aria-label="アカウント: Ada Example">',
    );
    expect(html).not.toContain('title="Subject"');
    expect(html).not.toContain('ID プロバイダーではありません');
    expect(html).toContain(
      '<footer class="footer"><a href="https://support.example.org">サポート</a></footer>',
    );
  });

  it('separates users, service accounts, and automated workloads', () => {
    const html = renderPeopleAdmin({
      subjects: [
        memberSubject(),
        nonHumanSubject('service', 'service_account', 'Configuration Service'),
        nonHumanSubject('workload', 'automation', 'Directory Synchronizer'),
      ],
      roleGrants: [],
      capabilities: { canManageConfiguration: true, canManageIdentities: true },
    });

    expect(html).toContain('<h2>ユーザー</h2><span class="count">1</span>');
    expect(html).toContain('<h2>サービスと自動処理</h2><span class="count">2</span>');
    expect(html).toContain('サービスアカウント');
    expect(html).toContain('自動処理');
    expect(html).not.toContain('管理対象 Subject');
    expect(html).not.toContain('>Subject<');
  });

  it('distinguishes authentication IDs from external-service accounts', () => {
    const html = renderAccountPage({
      subject: memberSubject(),
      identities: [googleIdentity()],
      guestProfile: null,
      providerAccounts: [],
    });

    expect(html).toContain('<h2>ユーザー情報</h2>');
    expect(html).toContain('<h2>認証 ID</h2>');
    expect(html).toContain('プロバイダー内 ID');
    expect(html).toContain('<h2>外部サービスのアカウント</h2>');
    expect(html).not.toContain('Subject');
  });

  it('gives an unmapped identity an actionable, user-facing explanation', () => {
    const html = renderAccessRequiredShell({
      issuer: 'local://access-control',
      providerSubject: 'unmapped-user',
      canonicalIdentity: 'access:unmapped-user',
    });

    expect(html).toContain('Access Control の利用登録が見つかりません');
    expect(html).toContain('認証 ID');
    expect(html).not.toContain('Subject');
    expect(html).not.toContain('Issuer');
  });
});

function nonHumanSubject(
  kind: 'service' | 'workload',
  classification: 'automation' | 'service_account',
  displayName: string,
) {
  return createSubjectCandidate({
    id: `subject:${kind}`,
    kind,
    classification,
    displayName,
    status: 'active',
    directoryState: 'active',
    protected: true,
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    createdBy: 'subject:member',
    updatedBy: 'subject:member',
  });
}
