import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import {
  assertProductionAccessConfiguration,
  authenticateAccessPrincipal,
} from '../../apps/worker/src/auth/access';
import { fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const localHeaders = { 'x-access-control-dev-identity': 'access:local-admin' };

describe('Worker authentication, authorization, and portal integration', () => {
  let administratorSubjectId: string;

  beforeAll(async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    administratorSubjectId = bootstrap.subject.id;
  });

  it('fails closed outside development when Access configuration is unset', () => {
    expect(() =>
      assertProductionAccessConfiguration({
        ENVIRONMENT: 'production',
        ALLOW_LOCAL_AUTH: 'false',
        ACCESS_TEAM_DOMAIN: 'unset',
        ACCESS_AUD: 'unset',
        LOCAL_BOOTSTRAP_IDENTITY: 'unset',
      }),
    ).toThrowError(expect.objectContaining({ code: 'access_configuration_missing' }));
    expect(() =>
      assertProductionAccessConfiguration({
        ENVIRONMENT: 'production',
        ALLOW_LOCAL_AUTH: 'false',
        LOCAL_BOOTSTRAP_IDENTITY: 'unset',
      }),
    ).toThrowError(expect.objectContaining({ code: 'access_configuration_missing' }));
  });

  it('permits local identity headers only in explicit loopback development requests', async () => {
    await expect(
      authenticateAccessPrincipal(new Request('http://localhost'), {
        ENVIRONMENT: 'development',
        ALLOW_LOCAL_AUTH: 'true',
        ACCESS_TEAM_DOMAIN: 'unset',
        ACCESS_AUD: 'unset',
        LOCAL_BOOTSTRAP_IDENTITY: 'unset',
      }),
    ).rejects.toMatchObject({ code: 'access_required' });
    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', { headers: localHeaders }),
        {
          ENVIRONMENT: 'development',
          ALLOW_LOCAL_AUTH: 'true',
          ACCESS_TEAM_DOMAIN: 'unset',
          ACCESS_AUD: 'unset',
          LOCAL_BOOTSTRAP_IDENTITY: 'unset',
        },
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed' });
    await expect(
      authenticateAccessPrincipal(new Request('http://localhost', { headers: localHeaders }), {
        ENVIRONMENT: 'development',
        ALLOW_LOCAL_AUTH: 'true',
        ACCESS_TEAM_DOMAIN: 'unset',
        ACCESS_AUD: 'unset',
        LOCAL_BOOTSTRAP_IDENTITY: 'unset',
      }),
    ).resolves.toMatchObject({ canonicalIdentity: 'access:local-admin' });
    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', { headers: localHeaders }),
        {
          ENVIRONMENT: 'staging',
          ALLOW_LOCAL_AUTH: 'true',
          ACCESS_TEAM_DOMAIN: 'unset',
          ACCESS_AUD: 'unset',
          LOCAL_BOOTSTRAP_IDENTITY: 'unset',
        },
      ),
    ).rejects.toMatchObject({ code: 'local_auth_not_allowed' });
  });

  it('shows an unmapped principal only the access-required surface', async () => {
    const accessRequired = await SELF.fetch('http://localhost/access-required', {
      headers: { 'x-access-control-dev-identity': 'access:unmapped-user' },
    });
    expect(accessRequired.status).toBe(200);
    const accessRequiredHtml = await accessRequired.text();
    expect(accessRequiredHtml).toContain('<html lang="ja">');
    expect(accessRequiredHtml).toContain('Access Control の利用登録が見つかりません');
    expect(accessRequiredHtml).toContain('unmapped-user');
    const api = await SELF.fetch('http://localhost/api/v1/me', {
      headers: { 'x-access-control-dev-identity': 'access:unmapped-user' },
    });
    expect(api.status).toBe(403);
    await expect(api.json()).resolves.toMatchObject({ error: { code: 'subject_not_mapped' } });
  });

  it('renders only relevant applications for a mapped Subject', async () => {
    const repositories = createD1Repositories(env.DB);
    const catalog = new CatalogService(
      repositories.catalog,
      repositories.identities,
      fixtureRuntime(),
      repositories.provisioning,
    );
    const context = {
      actorSubjectId: administratorSubjectId,
      requestId: 'request:portal-applications',
    };
    await catalog.createApplication(
      {
        key: 'public-documentation',
        name: 'Visible Documentation',
        category: 'Knowledge',
        launchUrl: 'https://docs.example.org',
        status: 'active',
        visibility: 'all_active_subjects',
        authentication: { type: 'direct_google' },
        provisioningMode: 'none',
      },
      context,
    );
    await catalog.createApplication(
      {
        key: 'private-console',
        name: 'Hidden Private Console',
        category: 'Infrastructure',
        launchUrl: 'https://private.example.org',
        status: 'active',
        visibility: 'entitled',
        authentication: { type: 'cloudflare_oidc', reference: 'example-reference' },
        provisioningMode: 'plan',
      },
      context,
    );
    const response = await SELF.fetch('http://localhost/applications?lang=en', {
      headers: localHeaders,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Visible Documentation');
    expect(html).not.toContain('Hidden Private Console');
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('アプリケーション');
    expect(html).toContain('<a class="account-link" href="/account"');
    expect(html.match(/<nav class="primary-nav"[\s\S]*?<\/nav>/)?.[0]).not.toContain('/account');
    expect(html).not.toContain('ID プロバイダーではありません');
    expect(html).not.toContain('?lang=');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('accepts the documented empty export request', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/exports', {
      method: 'POST',
      headers: {
        ...localHeaders,
        'content-type': 'application/json',
        'x-access-control-reason': 'integration_export_validation',
      },
      body: '{}',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: 'planned', schemaVersion: '1.0.0' },
    });
  });

  it('rejects cross-site browser mutations before route execution', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/applications', {
      method: 'POST',
      headers: {
        ...localHeaders,
        'content-type': 'application/json',
        origin: 'https://attacker.example.net',
        'sec-fetch-site': 'cross-site',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'cross_site_mutation' },
    });
  });

  it('keeps production Swagger read-only', async () => {
    const { swaggerUiOptions } = await import('../../apps/worker/src/api/app');
    expect(swaggerUiOptions('production').supportedSubmitMethods).toEqual([]);
    expect(swaggerUiOptions('staging').supportedSubmitMethods).toEqual([]);
    expect(swaggerUiOptions('development').supportedSubmitMethods).toBeUndefined();
  });
});
