import { describe, expect, it, vi } from 'vitest';
import { ConfigurationApiClient } from '@access-control/config';

describe('Configuration API client authentication', () => {
  it('allows HTTP only on loopback addresses', () => {
    expect(
      () =>
        new ConfigurationApiClient({
          baseUrl: 'http://access.example.org',
          accessClientId: 'client-id',
          accessClientSecret: 'client-secret',
        }),
    ).toThrow(/loopback/);
  });

  it('sends Cloudflare Access service-token headers and plan provenance', async () => {
    const fetchImplementation = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(request)).toBe('https://access.example.org/api/v1/directory-sources');
      expect(init?.redirect).toBe('error');
      expect(headers.get('CF-Access-Client-Id')).toBe('client-id.access');
      expect(headers.get('CF-Access-Client-Secret')).toBe('client-secret-value');
      expect(headers.get('x-access-control-plan-hash')).toBe(`sha256:${'a'.repeat(64)}`);
      return new Response('{"data":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new ConfigurationApiClient({
      baseUrl: 'https://access.example.org',
      accessClientId: 'client-id.access',
      accessClientSecret: 'client-secret-value',
      fetchImplementation,
    });

    await client.create(
      '/api/v1/directory-sources',
      { id: 'directory:google' },
      `sha256:${'a'.repeat(64)}`,
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('does not copy service-token values into API errors', async () => {
    const client = new ConfigurationApiClient({
      baseUrl: 'https://access.example.org',
      accessClientId: 'sensitive-client-id',
      accessClientSecret: 'sensitive-client-secret',
      fetchImplementation: async () =>
        new Response('{"error":{"code":"role_forbidden"}}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(
      client.create('/api/v1/directory-sources', {}, `sha256:${'b'.repeat(64)}`),
    ).rejects.toThrow('HTTP 403 (role_forbidden)');
    await expect(
      client.create('/api/v1/directory-sources', {}, `sha256:${'b'.repeat(64)}`),
    ).rejects.not.toThrow(/sensitive-client/);
  });
});
