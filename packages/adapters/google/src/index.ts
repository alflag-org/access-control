import { z } from 'zod';
import {
  directoryObservationRequestSchema,
  directorySnapshotSchema,
  type DirectoryAdapter,
  type DirectoryObservationRequest,
  type DirectorySnapshot,
  type ObservedDirectoryGroup,
  type ObservedDirectoryMembership,
  type ObservedDirectoryUser,
} from '@access-control/contracts';
import { AccessControlError, canonicalJson, jsonValueSchema } from '@access-control/domain';

export const GOOGLE_DIRECTORY_READ_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
] as const;

export const GOOGLE_GROUP_MEMBERSHIP_CONCURRENCY = 4;

const serviceAccountCredentialSchema = z
  .object({
    client_email: z.email(),
    private_key: z.string().min(1),
    token_uri: z
      .literal('https://oauth2.googleapis.com/token')
      .default('https://oauth2.googleapis.com/token'),
  })
  .strict();

const googleUserSchema = z
  .object({
    id: z.string().min(1),
    primaryEmail: z.email(),
    name: z
      .object({
        fullName: z.string().min(1).optional(),
      })
      .passthrough()
      .optional(),
    aliases: z.array(z.email()).optional(),
    nonEditableAliases: z.array(z.email()).optional(),
    suspended: z.boolean().optional(),
    deletionTime: z.string().optional(),
  })
  .passthrough();

const googleGroupSchema = z
  .object({
    id: z.string().min(1),
    email: z.email(),
    name: z.string().min(1).optional(),
    aliases: z.array(z.email()).optional(),
    nonEditableAliases: z.array(z.email()).optional(),
  })
  .passthrough();

const googleMemberSchema = z
  .object({
    id: z.string().min(1).optional(),
    email: z.email().optional(),
    role: z.enum(['MEMBER', 'MANAGER', 'OWNER']).optional(),
    type: z.enum(['USER', 'GROUP', 'CUSTOMER']).optional(),
  })
  .passthrough();

const userPageSchema = z
  .object({
    users: z.array(googleUserSchema).optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .passthrough();

const groupPageSchema = z
  .object({
    groups: z.array(googleGroupSchema).optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .passthrough();

const memberPageSchema = z
  .object({
    members: z.array(googleMemberSchema).optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().positive(),
  })
  .passthrough();

type GoogleUser = z.infer<typeof googleUserSchema>;
type GoogleGroup = z.infer<typeof googleGroupSchema>;
type GoogleMember = z.infer<typeof googleMemberSchema>;

export interface GoogleDirectoryPage<T> {
  items: T[];
  nextPageToken?: string;
}

export interface GoogleDirectoryTransport {
  listUsers(input: {
    customerId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleUser>>;
  listGroups(input: {
    customerId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleGroup>>;
  listGroupMembers(input: {
    groupId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleMember>>;
}

export interface GoogleTransportContext {
  delegatedAdmin: string;
  credential: unknown;
  scopes: readonly string[];
}

export type GoogleTransportFactory = (
  context: GoogleTransportContext,
) => Promise<GoogleDirectoryTransport>;

export class GoogleDirectoryReadAdapter implements DirectoryAdapter {
  public constructor(
    private readonly resolveCredential: (bindingName: string) => unknown,
    private readonly createTransport: GoogleTransportFactory,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async observeDirectory(
    inputValue: DirectoryObservationRequest,
  ): Promise<DirectorySnapshot> {
    const input = directoryObservationRequestSchema.parse(inputValue);
    const credential = this.resolveCredential(input.credentialRef);
    if (credential === undefined || credential === null || credential === '') {
      throw new AccessControlError(
        503,
        'google_credential_unavailable',
        `The configured Google credential binding ${input.credentialRef} is unavailable.`,
      );
    }
    const transport = await this.createTransport({
      delegatedAdmin: input.delegatedAdmin,
      credential,
      scopes: GOOGLE_DIRECTORY_READ_SCOPES,
    });
    const [rawUsers, rawGroups] = await Promise.all([
      collectPages((pageToken) => transport.listUsers(pageInput(input.customerId, pageToken))),
      collectPages((pageToken) => transport.listGroups(pageInput(input.customerId, pageToken))),
    ]);
    const users = rawUsers.map(normalizeUser).sort(compareImmutableId);
    const groups = rawGroups.map(normalizeGroup).sort(compareImmutableId);
    const userIds = new Set(users.map((user) => user.immutableId));
    const memberships = (
      await mapWithConcurrencyLimit(groups, GOOGLE_GROUP_MEMBERSHIP_CONCURRENCY, async (group) => {
        const members = await collectPages((pageToken) =>
          transport.listGroupMembers(groupPageInput(group.immutableId, pageToken)),
        );
        return members.map((member) => normalizeMembership(group.immutableId, member, userIds));
      })
    )
      .flat()
      .sort((left, right) =>
        `${left.groupImmutableId}:${left.immutableId}`.localeCompare(
          `${right.groupImmutableId}:${right.immutableId}`,
        ),
      );
    const observedAt = this.now();
    const snapshotInput = {
      directorySourceId: input.directorySourceId,
      observedAt,
      users,
      groups,
      memberships,
    };
    const snapshotVersion = await sha256(canonicalJson(jsonValueSchema.parse(snapshotInput)));
    return directorySnapshotSchema.parse({ ...snapshotInput, snapshotVersion });
  }
}

export async function mapWithConcurrencyLimit<Input, Output>(
  inputs: readonly Input[],
  concurrencyLimit: number,
  mapper: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer.');
  }
  if (inputs.length === 0) return [];

  const entries = inputs.map((value, index) => [index, value] as const);
  const results = new Array<Output>(inputs.length);
  let nextEntry = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const entry = entries[nextEntry];
      if (entry === undefined) return;
      nextEntry += 1;
      try {
        results[entry[0]] = await mapper(entry[1], entry[0]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrencyLimit, entries.length) }, () => worker()),
  );
  if (failure !== undefined) throw failure.error;
  return results;
}

export function createGoogleTransportFactory(
  fetcher: typeof fetch = fetch,
): GoogleTransportFactory {
  return async ({ delegatedAdmin, credential, scopes }) => {
    const parsedCredential = parseCredential(credential);
    const accessToken = await requestDelegatedAccessToken(
      parsedCredential,
      delegatedAdmin,
      scopes,
      fetcher,
    );
    return new FetchGoogleDirectoryTransport(accessToken, fetcher);
  };
}

export class FetchGoogleDirectoryTransport implements GoogleDirectoryTransport {
  public constructor(
    private readonly accessToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async listUsers(input: {
    customerId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleUser>> {
    const response = userPageSchema.parse(
      await this.request('/admin/directory/v1/users', {
        customer: input.customerId,
        maxResults: '500',
        orderBy: 'email',
        projection: 'basic',
        showDeleted: 'true',
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      }),
    );
    return pageResult(response.users ?? [], response.nextPageToken);
  }

  public async listGroups(input: {
    customerId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleGroup>> {
    const response = groupPageSchema.parse(
      await this.request('/admin/directory/v1/groups', {
        customer: input.customerId,
        maxResults: '200',
        ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
      }),
    );
    return pageResult(response.groups ?? [], response.nextPageToken);
  }

  public async listGroupMembers(input: {
    groupId: string;
    pageToken?: string;
  }): Promise<GoogleDirectoryPage<GoogleMember>> {
    const response = memberPageSchema.parse(
      await this.request(
        `/admin/directory/v1/groups/${encodeURIComponent(input.groupId)}/members`,
        {
          includeDerivedMembership: 'false',
          maxResults: '200',
          ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
        },
      ),
    );
    return pageResult(response.members ?? [], response.nextPageToken);
  }

  private async request(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, 'https://admin.googleapis.com');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        redirect: 'error',
        headers: { authorization: `Bearer ${this.accessToken}` },
      });
    } catch {
      throw new AccessControlError(
        503,
        'google_directory_unavailable',
        'Google Directory could not be reached.',
      );
    }
    if (!response.ok) throw googleHttpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new AccessControlError(
        503,
        'google_directory_invalid_response',
        'Google Directory returned an invalid response.',
      );
    }
  }
}

async function collectPages<T>(
  readPage: (pageToken?: string) => Promise<GoogleDirectoryPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await readPage(pageToken);
    items.push(...page.items);
    pageToken = page.nextPageToken;
    if (pageToken !== undefined && seenTokens.has(pageToken)) {
      throw new AccessControlError(
        503,
        'google_pagination_cycle',
        'Google Directory repeated a pagination token.',
      );
    }
    if (pageToken !== undefined) seenTokens.add(pageToken);
  } while (pageToken !== undefined);
  return items;
}

function normalizeUser(userValue: GoogleUser): ObservedDirectoryUser {
  const user = googleUserSchema.parse(userValue);
  return {
    immutableId: user.id,
    primaryEmail: user.primaryEmail.toLowerCase(),
    aliases: normalizeEmails([...(user.aliases ?? []), ...(user.nonEditableAliases ?? [])]),
    displayName: user.name?.fullName ?? user.primaryEmail,
    suspended: user.suspended ?? false,
    lifecycle: user.deletionTime === undefined ? 'active' : 'deleted',
  };
}

function normalizeGroup(groupValue: GoogleGroup): ObservedDirectoryGroup {
  const group = googleGroupSchema.parse(groupValue);
  return {
    immutableId: group.id,
    email: group.email.toLowerCase(),
    aliases: normalizeEmails([...(group.aliases ?? []), ...(group.nonEditableAliases ?? [])]),
    name: group.name ?? group.email,
    lifecycle: 'active',
  };
}

function normalizeMembership(
  groupImmutableId: string,
  memberValue: GoogleMember,
  userIds: ReadonlySet<string>,
): ObservedDirectoryMembership {
  const member = googleMemberSchema.parse(memberValue);
  const memberKey = member.id ?? member.email;
  if (memberKey === undefined) {
    throw new AccessControlError(
      422,
      'google_membership_missing_immutable_id',
      'A Google group member did not include an immutable ID or email.',
    );
  }
  const memberType =
    member.type === 'GROUP'
      ? 'group'
      : member.id !== undefined && userIds.has(member.id)
        ? 'user'
        : 'external';
  return {
    immutableId: memberKey,
    groupImmutableId,
    memberImmutableId: memberKey,
    ...(member.email === undefined ? {} : { memberEmail: member.email.toLowerCase() }),
    memberType,
    role: member.role ?? 'MEMBER',
  };
}

function normalizeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((email) => email.toLowerCase()))].sort();
}

function compareImmutableId(left: { immutableId: string }, right: { immutableId: string }): number {
  return left.immutableId.localeCompare(right.immutableId);
}

function pageInput(customerId: string, pageToken?: string) {
  return pageToken === undefined ? { customerId } : { customerId, pageToken };
}

function groupPageInput(groupId: string, pageToken?: string) {
  return pageToken === undefined ? { groupId } : { groupId, pageToken };
}

function pageResult<T>(items: T[], nextPageToken?: string): GoogleDirectoryPage<T> {
  return nextPageToken === undefined ? { items } : { items, nextPageToken };
}

function parseCredential(value: unknown): z.infer<typeof serviceAccountCredentialSchema> {
  let candidate = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value);
    } catch {
      throw new AccessControlError(
        503,
        'google_credential_invalid',
        'The Google credential binding is not valid JSON.',
      );
    }
  }
  const result = serviceAccountCredentialSchema.safeParse(candidate);
  if (!result.success) {
    throw new AccessControlError(
      503,
      'google_credential_invalid',
      'The Google credential binding does not match the service-account contract.',
    );
  }
  return result.data;
}

async function requestDelegatedAccessToken(
  credential: z.infer<typeof serviceAccountCredentialSchema>,
  delegatedAdmin: string,
  scopes: readonly string[],
  fetcher: typeof fetch,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: credential.client_email,
      sub: delegatedAdmin,
      scope: [...scopes].sort().join(' '),
      aud: credential.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(credential.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new AccessControlError(
      503,
      'google_credential_invalid',
      'The Google private key could not be imported.',
    );
  }
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}`;
  let response: Response;
  try {
    response = await fetcher(credential.token_uri, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    throw new AccessControlError(
      503,
      'google_token_unavailable',
      'Google OAuth token exchange could not be reached.',
    );
  }
  if (!response.ok) throw googleHttpError(response.status, 'google_token_rejected');
  try {
    return tokenResponseSchema.parse(await response.json()).access_token;
  } catch {
    throw new AccessControlError(
      503,
      'google_token_invalid_response',
      'Google OAuth returned an invalid token response.',
    );
  }
}

function googleHttpError(
  status: number,
  fallbackCode = 'google_directory_error',
): AccessControlError {
  if (status === 429) {
    return new AccessControlError(
      429,
      'google_rate_limited',
      'Google Directory rate limited the request.',
    );
  }
  if (status === 401 || status === 403) {
    return new AccessControlError(
      503,
      'google_authorization_failed',
      'Google Directory authorization failed.',
    );
  }
  return new AccessControlError(503, fallbackCode, 'Google Directory returned an error.');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const encoded = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  return bytes.buffer;
}

function base64Url(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
