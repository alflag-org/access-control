import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_DIRECTORY_READ_SCOPES,
  GOOGLE_GROUP_MEMBERSHIP_CONCURRENCY,
  FetchGoogleDirectoryTransport,
  GoogleDirectoryReadAdapter,
  createGoogleTransportFactory,
  mapWithConcurrencyLimit,
  type GoogleDirectoryTransport,
  type GoogleTransportContext,
} from '@access-control/google';

const request = {
  directorySourceId: 'directory:google',
  customerId: 'example-customer',
  delegatedAdmin: 'directory-admin@example.org',
  credentialRef: 'GOOGLE_CREDENTIAL',
  accessGroupPrefix: 'access.',
};

describe('Google Directory read adapter', () => {
  it('publishes a complete, normalized paginated snapshot with direct member roles', async () => {
    let context: GoogleTransportContext | undefined;
    const transport: GoogleDirectoryTransport = {
      listUsers: async ({ pageToken }) =>
        pageToken === undefined
          ? {
              items: [
                {
                  id: 'user-2',
                  primaryEmail: 'BOB@EXAMPLE.ORG',
                  name: { fullName: 'Bob Example' },
                  aliases: ['B.EXAMPLE@EXAMPLE.ORG'],
                },
              ],
              nextPageToken: 'users-2',
            }
          : {
              items: [
                {
                  id: 'user-1',
                  primaryEmail: 'ADA@EXAMPLE.ORG',
                  suspended: true,
                  nonEditableAliases: ['ADA.ALIAS@EXAMPLE.ORG'],
                },
              ],
            },
      listGroups: async () => ({
        items: [
          {
            id: 'group-1',
            email: 'ACCESS.GITHUB.MEMBER@EXAMPLE.ORG',
            name: 'GitHub members',
          },
        ],
      }),
      listGroupMembers: async () => ({
        items: [
          { id: 'user-1', email: 'ADA@EXAMPLE.ORG', type: 'USER', role: 'MANAGER' },
          { id: 'nested-1', email: 'nested@example.org', type: 'GROUP', role: 'MEMBER' },
          { email: 'external@example.net', type: 'CUSTOMER', role: 'MEMBER' },
        ],
      }),
    };
    const adapter = new GoogleDirectoryReadAdapter(
      (binding) => (binding === 'GOOGLE_CREDENTIAL' ? { fictional: true } : undefined),
      async (value) => {
        context = value;
        return transport;
      },
      () => '2026-01-01T00:00:00.000Z',
    );
    const snapshot = await adapter.observeDirectory(request);
    expect(context?.scopes).toEqual(GOOGLE_DIRECTORY_READ_SCOPES);
    expect(snapshot.users.map((user) => user.immutableId)).toEqual(['user-1', 'user-2']);
    expect(snapshot.users[0]).toEqual(
      expect.objectContaining({
        primaryEmail: 'ada@example.org',
        aliases: ['ada.alias@example.org'],
        suspended: true,
      }),
    );
    expect(snapshot.memberships.map((membership) => membership.memberType)).toEqual([
      'external',
      'group',
      'user',
    ]);
    expect(snapshot.memberships.find((item) => item.memberType === 'user')?.role).toBe('MANAGER');
    expect(snapshot.snapshotVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('does not return a partial snapshot after a later page fails', async () => {
    const adapter = new GoogleDirectoryReadAdapter(
      () => ({ fictional: true }),
      async () => ({
        listUsers: async ({ pageToken }) => {
          if (pageToken !== undefined) throw new Error('later page failed');
          return {
            items: [{ id: 'user-1', primaryEmail: 'ada@example.org' }],
            nextPageToken: 'next',
          };
        },
        listGroups: async () => ({ items: [] }),
        listGroupMembers: async () => ({ items: [] }),
      }),
    );
    await expect(adapter.observeDirectory(request)).rejects.toThrow('later page failed');
  });

  it('bounds group membership reads and retains input order after out-of-order completion', async () => {
    let activeMembershipReads = 0;
    let maximumMembershipReads = 0;
    const groups = Array.from({ length: GOOGLE_GROUP_MEMBERSHIP_CONCURRENCY + 3 }, (_, index) => ({
      id: `group-${String(index).padStart(2, '0')}`,
      email: `access.group-${index}@example.org`,
    }));
    const adapter = new GoogleDirectoryReadAdapter(
      () => ({ fictional: true }),
      async () => ({
        listUsers: async () => ({ items: [] }),
        listGroups: async () => ({ items: groups }),
        listGroupMembers: async ({ groupId }) => {
          activeMembershipReads += 1;
          maximumMembershipReads = Math.max(maximumMembershipReads, activeMembershipReads);
          await delay(10);
          activeMembershipReads -= 1;
          return {
            items: [
              {
                email: `${groupId}@external.example.net`,
                type: 'CUSTOMER' as const,
                role: 'MEMBER' as const,
              },
            ],
          };
        },
      }),
    );

    const snapshot = await adapter.observeDirectory(request);
    expect(maximumMembershipReads).toBe(GOOGLE_GROUP_MEMBERSHIP_CONCURRENCY);
    expect(snapshot.memberships.map((membership) => membership.groupImmutableId)).toEqual(
      groups.map((group) => group.id),
    );

    const ordered = await mapWithConcurrencyLimit(['slow', 'fast'], 2, async (value) => {
      await delay(value === 'slow' ? 5 : 0);
      return `${value}:done`;
    });
    expect(ordered).toEqual(['slow:done', 'fast:done']);
  });

  it('requires a runtime credential binding and never accepts a missing value', async () => {
    const adapter = new GoogleDirectoryReadAdapter(
      () => undefined,
      async () => {
        throw new Error('transport must not be created');
      },
    );
    await expect(adapter.observeDirectory(request)).rejects.toMatchObject({
      code: 'google_credential_unavailable',
    });
  });

  it('rejects a service-account credential that redirects the OAuth exchange', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const createTransport = createGoogleTransportFactory(fetcher);

    await expect(
      createTransport({
        delegatedAdmin: request.delegatedAdmin,
        scopes: GOOGLE_DIRECTORY_READ_SCOPES,
        credential: {
          client_email: 'service-account@example.org',
          private_key: 'not-used',
          token_uri: 'https://attacker.example/token',
        },
      }),
    ).rejects.toMatchObject({ code: 'google_credential_invalid' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not follow redirects while sending a Directory access token', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_request, init) => {
      expect(init?.redirect).toBe('error');
      return new Response('{"users":[]}', {
        headers: { 'content-type': 'application/json' },
      });
    });
    const transport = new FetchGoogleDirectoryTransport('directory-token', fetcher);

    await expect(transport.listUsers({ customerId: 'example-customer' })).resolves.toEqual({
      items: [],
    });
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
