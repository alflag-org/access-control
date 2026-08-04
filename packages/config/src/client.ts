import { z } from 'zod';
import {
  applicationEntitlementSchema,
  applicationSchema,
  directorySourceSchema,
  entitlementMappingSchema,
  externalIdentitySchema,
  guestProfileSchema,
  mappingPreviewSchema,
  organizationSettingsSchema,
  providerConnectionSchema,
  provisioningTargetSchema,
  sourceGroupMembershipSchema,
  sourceGroupSchema,
  subjectSchema,
  type JsonObject,
} from '@access-control/domain';
import type { RuntimeConfigurationSnapshot } from './plan';

const paginationSchema = z.object({ nextCursor: z.string().optional() }).strict();

export interface ConfigurationClientOptions {
  baseUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  fetchImplementation?: typeof fetch;
}

export interface ConfigurationApi {
  loadSnapshot(): Promise<RuntimeConfigurationSnapshot>;
  create(path: string, body: JsonObject, planHash: string): Promise<unknown>;
  update(path: string, body: JsonObject, planHash: string): Promise<unknown>;
  invoke(path: string, body: JsonObject, planHash: string): Promise<unknown>;
}

export class ConfigurationApiClient implements ConfigurationApi {
  readonly #baseUrl: URL;
  readonly #accessClientId: string;
  readonly #accessClientSecret: string;
  readonly #fetch: typeof fetch;

  public constructor(options: ConfigurationClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#accessClientId = requireCredential(options.accessClientId, 'CF_ACCESS_CLIENT_ID');
    this.#accessClientSecret = requireCredential(
      options.accessClientSecret,
      'CF_ACCESS_CLIENT_SECRET',
    );
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  public async loadSnapshot(): Promise<RuntimeConfigurationSnapshot> {
    const [
      organization,
      directorySources,
      applications,
      providerConnections,
      provisioningTargets,
      mappings,
      sourceGroups,
      subjects,
      guestProfiles,
    ] = await Promise.all([
      this.#getData('/api/v1/organization-settings', organizationSettingsSchema),
      this.#getList('/api/v1/directory-sources', directorySourceSchema),
      this.#getList('/api/v1/applications', applicationSchema),
      this.#getList('/api/v1/provider-connections', providerConnectionSchema),
      this.#getList('/api/v1/provisioning-targets', provisioningTargetSchema),
      this.#getList('/api/v1/mappings', entitlementMappingSchema),
      this.#getList('/api/v1/source-groups', sourceGroupSchema),
      this.#getList('/api/v1/subjects', subjectSchema),
      this.#getList('/api/v1/guests', guestProfileSchema),
    ]);
    const [entitlementLists, membershipLists, identityLists] = await Promise.all([
      Promise.all(
        applications.map((application) =>
          this.#getList(
            `/api/v1/applications/${encodeURIComponent(application.id)}/entitlements`,
            applicationEntitlementSchema,
          ),
        ),
      ),
      Promise.all(
        sourceGroups.map((group) =>
          this.#getList(
            `/api/v1/source-groups/${encodeURIComponent(group.id)}/members`,
            sourceGroupMembershipSchema,
          ),
        ),
      ),
      Promise.all(
        subjects.map((subject) =>
          this.#getList(
            `/api/v1/subjects/${encodeURIComponent(subject.id)}/identities`,
            externalIdentitySchema,
          ),
        ),
      ),
    ]);
    return {
      organization,
      directorySources,
      applications,
      entitlements: entitlementLists.flat(),
      providerConnections,
      provisioningTargets,
      mappings,
      sourceGroups,
      sourceGroupMemberships: membershipLists.flat(),
      subjects,
      externalIdentities: identityLists.flat(),
      guestProfiles,
    };
  }

  public async create(path: string, body: JsonObject, planHash: string): Promise<unknown> {
    return this.#mutate('POST', path, body, planHash);
  }

  public async update(path: string, body: JsonObject, planHash: string): Promise<unknown> {
    return this.#mutate('PATCH', path, body, planHash);
  }

  public async invoke(path: string, body: JsonObject, planHash: string): Promise<unknown> {
    return this.#mutate('POST', path, body, planHash);
  }

  async #getData<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
    const response = await this.#request('GET', path);
    const envelope = z.object({ data: schema }).strict().parse(response) as { data: z.output<T> };
    return envelope.data;
  }

  async #getList<T extends z.ZodType>(path: string, schema: T): Promise<Array<z.output<T>>> {
    const values: Array<z.output<T>> = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (cursor !== undefined) query.set('cursor', cursor);
      const response = await this.#request('GET', `${path}?${query.toString()}`);
      const page = z
        .object({ data: z.array(schema), pagination: paginationSchema })
        .strict()
        .parse(response);
      values.push(...page.data);
      cursor = page.pagination.nextCursor;
    } while (cursor !== undefined);
    return values;
  }

  async #mutate(
    method: 'PATCH' | 'POST',
    path: string,
    body: JsonObject,
    planHash: string,
  ): Promise<unknown> {
    return this.#request(method, path, body, planHash);
  }

  async #request(
    method: 'GET' | 'PATCH' | 'POST',
    path: string,
    body?: JsonObject,
    planHash?: string,
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    const response = await this.#fetch(url, {
      method,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'CF-Access-Client-Id': this.#accessClientId,
        'CF-Access-Client-Secret': this.#accessClientSecret,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(planHash === undefined
          ? {}
          : {
              'x-access-control-plan-hash': planHash,
              'x-access-control-reason': `Declarative configuration ${planHash}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new Error(`Access Control API returned non-JSON data with HTTP ${response.status}.`);
    }
    if (!response.ok) {
      const code = errorCode(parsed);
      throw new Error(
        `Access Control API request failed with HTTP ${response.status}${code === undefined ? '' : ` (${code})`}.`,
      );
    }
    return parsed;
  }
}

function normalizeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ACCESS_CONTROL_BASE_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('ACCESS_CONTROL_BASE_URL must use HTTP or HTTPS.');
  }
  if (
    url.protocol === 'http:' &&
    url.hostname !== 'localhost' &&
    url.hostname !== '127.0.0.1' &&
    url.hostname !== '[::1]'
  ) {
    throw new Error('ACCESS_CONTROL_BASE_URL may use HTTP only for a loopback address.');
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url;
}

function requireCredential(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function errorCode(value: unknown): string | undefined {
  const parsed = z
    .object({ error: z.object({ code: z.string() }).passthrough() })
    .passthrough()
    .safeParse(value);
  return parsed.success ? parsed.data.error.code : undefined;
}

export function parseMappingPreviewResponse(value: unknown) {
  return z.object({ data: mappingPreviewSchema }).strict().parse(value).data;
}
