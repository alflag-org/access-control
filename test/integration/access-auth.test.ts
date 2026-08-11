import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticateAccessPrincipal } from '../../apps/worker/src/auth/access';

const ACCESS_AUD = 'access-audience';
const ACCESS_TEAM_DOMAIN = 'access-auth.example.org';
const ACCESS_ENVIRONMENT = {
  ACCESS_AUD,
  ACCESS_TEAM_DOMAIN,
  ALLOW_LOCAL_AUTH: 'false',
  ENVIRONMENT: 'production',
  LOCAL_BOOTSTRAP_IDENTITY: 'unset',
};
type SigningKeyFixture = JsonWebKey & { alg: string; kid: string; use: string };

describe('Cloudflare Access signing key retrieval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('follows redirects when retrieving signing keys', async () => {
    const fixture = await signingKeyFixture();
    const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
      expect(init?.redirect).toBe('follow');
      return jsonResponse(fixture.jwks);
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', {
          headers: { 'Cf-Access-Jwt-Assertion': fixture.assertion },
        }),
        ACCESS_ENVIRONMENT,
      ),
    ).resolves.toMatchObject({
      canonicalIdentity: 'access:access-subject',
      providerSubject: 'access-subject',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts an application token with a scalar audience claim', async () => {
    const fixture = await signingKeyFixture(ACCESS_AUD);
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(fixture.jwks));
    vi.stubGlobal('fetch', fetcher);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', {
          headers: { 'Cf-Access-Jwt-Assertion': fixture.assertion },
        }),
        ACCESS_ENVIRONMENT,
      ),
    ).resolves.toMatchObject({ canonicalIdentity: 'access:access-subject' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([42, [ACCESS_AUD, 42], null])(
    'rejects a malformed audience claim: %j',
    async (audience) => {
      const fetcher = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetcher);

      await expect(
        authenticateAccessPrincipal(
          new Request('https://access.example.org', {
            headers: { 'Cf-Access-Jwt-Assertion': unsignedAssertion({ aud: audience }) },
          }),
          ACCESS_ENVIRONMENT,
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: 'access_required',
        message: 'Cloudflare Access token is malformed.',
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('retries the signing key request with cache revalidation after an upstream failure', async () => {
    const fixture = await signingKeyFixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
      attempts += 1;
      expect(init?.redirect).toBe('follow');
      if (attempts === 1) return new Response('temporary failure', { status: 503 });
      expect(init?.cache).toBe('no-cache');
      return jsonResponse(fixture.jwks);
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', {
          headers: { 'Cf-Access-Jwt-Assertion': fixture.assertion },
        }),
        ACCESS_ENVIRONMENT,
      ),
    ).resolves.toMatchObject({ canonicalIdentity: 'access:access-subject' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      'cloudflare_access_signing_keys_fetch_failed',
      expect.objectContaining({ attempt: 1, status: 503 }),
    );
  });

  it('reports invalid key documents separately from unavailable key endpoints', async () => {
    const fixture = await signingKeyFixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>(async () => new Response('not-json'));
    vi.stubGlobal('fetch', fetcher);

    await expect(
      authenticateAccessPrincipal(
        new Request('https://access.example.org', {
          headers: { 'Cf-Access-Jwt-Assertion': fixture.assertion },
        }),
        ACCESS_ENVIRONMENT,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'access_keys_invalid' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      'cloudflare_access_signing_keys_fetch_failed',
      expect.objectContaining({ reason: 'invalid_response' }),
    );
  });
});

async function signingKeyFixture(audience: string | string[] = [ACCESS_AUD]): Promise<{
  assertion: string;
  jwks: { keys: SigningKeyFixture[] };
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const header = { alg: 'RS256', kid: 'test-access-signing-key', typ: 'JWT' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    sub: 'access-subject',
  };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedClaims = encodeBase64Url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return {
    assertion: `${signingInput}.${encodeBase64Url(signature)}`,
    jwks: {
      keys: [
        {
          ...publicJwk,
          alg: 'RS256',
          kid: 'test-access-signing-key',
          use: 'sig',
        },
      ],
    },
  };
}

function unsignedAssertion(claims: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: 'test-access-signing-key', typ: 'JWT' };
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 300,
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    sub: 'access-subject',
    ...claims,
  };
  return `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}.signature`;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function encodeBase64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
