import { z } from 'zod';
import { AccessControlError } from '@access-control/domain';

const accessPrincipalSchema = z
  .object({
    provider: z.literal('cloudflare_access'),
    issuer: z.string().min(1).max(500),
    providerSubject: z.string().min(1).max(500),
    canonicalIdentity: z.string().min(1).max(520),
    kind: z.enum(['human', 'service']),
  })
  .strict();

export type AccessPrincipal = z.infer<typeof accessPrincipalSchema>;

export interface AccessEnvironment {
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ALLOW_LOCAL_AUTH: string;
  ENVIRONMENT: string;
  LOCAL_BOOTSTRAP_IDENTITY: string;
}

interface AccessJwtHeader {
  kid: string;
}

interface AccessJwtClaims {
  aud: string[];
  exp: number;
  nbf?: number;
  iss: string;
  sub?: string;
  common_name?: string;
}

interface AccessJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

const SIGNING_KEY_FETCH_ATTEMPTS = 2;

export async function authenticateAccessPrincipal(
  request: Request,
  env: AccessEnvironment,
): Promise<AccessPrincipal> {
  if (env.ALLOW_LOCAL_AUTH === 'true') {
    if (env.ENVIRONMENT !== 'development' || !isLoopbackRequest(request)) {
      throw new AccessControlError(
        503,
        'local_auth_not_allowed',
        'Development authentication is only permitted on the local loopback interface.',
      );
    }
    const identity =
      request.headers.get('x-access-control-dev-identity') ?? env.LOCAL_BOOTSTRAP_IDENTITY;
    if (identity === 'unset' || identity.length === 0) {
      throw new AccessControlError(
        401,
        'access_required',
        'Development requests require x-access-control-dev-identity or LOCAL_BOOTSTRAP_IDENTITY.',
      );
    }
    return localPrincipal(identity);
  }

  assertProductionAccessConfiguration(env);
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (assertion === null) {
    throw new AccessControlError(
      401,
      'access_required',
      'Cloudflare Access authentication is required.',
    );
  }
  return verifyAccessJwt(assertion, normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN), env.ACCESS_AUD);
}

export function assertProductionAccessConfiguration(
  env: AccessEnvironment,
): asserts env is AccessEnvironment & {
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
} {
  if (env.ALLOW_LOCAL_AUTH === 'true') {
    throw new AccessControlError(
      503,
      'local_auth_not_allowed',
      'Local authentication is forbidden outside development.',
    );
  }
  if (
    !isConfiguredAccessValue(env.ACCESS_TEAM_DOMAIN) ||
    !isConfiguredAccessValue(env.ACCESS_AUD)
  ) {
    throw new AccessControlError(
      503,
      'access_configuration_missing',
      'Cloudflare Access configuration has not been supplied.',
    );
  }
}

function isConfiguredAccessValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && value !== 'unset';
}

function isLoopbackRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  );
}

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessPrincipal> {
  const parts = token.split('.');
  if (parts.length !== 3) throw malformedToken();
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    throw malformedToken();
  }
  const header = parseHeader(parseJsonSegment(headerSegment));
  const claims = parseClaims(parseJsonSegment(payloadSegment));
  const currentSeconds = Math.floor(Date.now() / 1000);
  if (
    claims.exp <= currentSeconds ||
    (claims.nbf !== undefined && claims.nbf > currentSeconds) ||
    claims.iss !== `https://${teamDomain}` ||
    !claims.aud.includes(audience)
  ) {
    throw new AccessControlError(
      401,
      'access_required',
      'Cloudflare Access token is not valid for this application.',
    );
  }
  const jwk = (await getSigningKeys(teamDomain)).find((candidate) => candidate.kid === header.kid);
  if (
    jwk === undefined ||
    jwk.kty !== 'RSA' ||
    (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
    (jwk.use !== undefined && jwk.use !== 'sig')
  ) {
    throw new AccessControlError(
      401,
      'access_required',
      'Cloudflare Access signing key was not found.',
    );
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    asArrayBuffer(decodeBase64Url(signatureSegment)),
    asArrayBuffer(new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)),
  );
  if (!valid) {
    throw new AccessControlError(
      401,
      'access_required',
      'Cloudflare Access token signature is invalid.',
    );
  }
  if (claims.common_name !== undefined && claims.common_name.length > 0) {
    return accessPrincipalSchema.parse({
      provider: 'cloudflare_access',
      issuer: claims.iss,
      providerSubject: claims.common_name,
      canonicalIdentity: `service:${claims.common_name}`,
      kind: 'service',
    });
  }
  if (claims.sub !== undefined && claims.sub.length > 0) {
    return accessPrincipalSchema.parse({
      provider: 'cloudflare_access',
      issuer: claims.iss,
      providerSubject: claims.sub,
      canonicalIdentity: `access:${claims.sub}`,
      kind: 'human',
    });
  }
  throw new AccessControlError(
    401,
    'access_required',
    'Cloudflare Access token has no usable identity.',
  );
}

function localPrincipal(identity: string): AccessPrincipal {
  const match = /^(access|service):([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/.exec(identity);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new AccessControlError(
      401,
      'access_required',
      'The development identity must use access:<subject> or service:<common-name>.',
    );
  }
  return accessPrincipalSchema.parse({
    provider: 'cloudflare_access',
    issuer: match[1] === 'service' ? 'local://access-control/service' : 'local://access-control',
    providerSubject: match[2],
    canonicalIdentity: identity,
    kind: match[1] === 'service' ? 'service' : 'human',
  });
}

function normalizeTeamDomain(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('invalid URL');
    }
    return url.hostname;
  } catch {
    throw new AccessControlError(
      503,
      'access_configuration_invalid',
      'Cloudflare Access configuration is invalid.',
    );
  }
}

async function getSigningKeys(teamDomain: string): Promise<AccessJwk[]> {
  const certificateUrl = `https://${teamDomain}/cdn-cgi/access/certs`;
  // The Cache API is unavailable when this Worker is fronted by Cloudflare Access.
  // Let the Access endpoint's HTTP cache headers handle caching for the subrequest.
  for (let attempt = 1; attempt <= SIGNING_KEY_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(certificateUrl, {
        ...(attempt > 1 ? { cache: 'no-cache' as const } : {}),
        redirect: 'follow',
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      console.warn('cloudflare_access_signing_keys_fetch_failed', {
        teamDomain,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!response.ok) {
      console.warn('cloudflare_access_signing_keys_fetch_failed', {
        teamDomain,
        attempt,
        status: response.status,
        statusText: response.statusText,
      });
      continue;
    }
    try {
      return await parseSigningKeys(response);
    } catch (error) {
      if (
        !(error instanceof AccessControlError) ||
        error.code !== 'access_keys_invalid' ||
        attempt === SIGNING_KEY_FETCH_ATTEMPTS
      ) {
        throw error;
      }
      console.warn('cloudflare_access_signing_keys_fetch_failed', {
        teamDomain,
        attempt,
        reason: 'invalid_response',
      });
    }
  }
  throw new AccessControlError(
    503,
    'access_keys_unavailable',
    'Cloudflare Access signing keys are unavailable.',
  );
}

async function parseSigningKeys(response: Response): Promise<AccessJwk[]> {
  try {
    return parseJwks(await response.json<unknown>());
  } catch (error) {
    if (error instanceof AccessControlError && error.code === 'access_keys_invalid') {
      throw error;
    }
    throw new AccessControlError(
      503,
      'access_keys_invalid',
      'Cloudflare Access signing keys are invalid.',
    );
  }
}

function parseJwks(value: unknown): AccessJwk[] {
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new AccessControlError(
      503,
      'access_keys_invalid',
      'Cloudflare Access signing keys are invalid.',
    );
  }
  return value.keys.flatMap((key) => {
    if (
      !isRecord(key) ||
      typeof key.kid !== 'string' ||
      typeof key.kty !== 'string' ||
      typeof key.n !== 'string' ||
      typeof key.e !== 'string'
    ) {
      return [];
    }
    return [
      {
        kid: key.kid,
        kty: key.kty,
        n: key.n,
        e: key.e,
        ...(typeof key.alg === 'string' ? { alg: key.alg } : {}),
        ...(typeof key.use === 'string' ? { use: key.use } : {}),
      },
    ];
  });
}

function parseHeader(value: Record<string, unknown>): AccessJwtHeader {
  if (value.alg !== 'RS256' || typeof value.kid !== 'string' || value.kid.length === 0) {
    throw new AccessControlError(
      401,
      'access_required',
      'Cloudflare Access token uses an unsupported signature.',
    );
  }
  return { kid: value.kid };
}

function parseClaims(value: Record<string, unknown>): AccessJwtClaims {
  const aud = typeof value.aud === 'string' ? [value.aud] : value.aud;
  if (
    !Array.isArray(aud) ||
    !aud.every((item) => typeof item === 'string') ||
    typeof value.exp !== 'number' ||
    typeof value.iss !== 'string'
  ) {
    throw malformedToken();
  }
  return {
    aud,
    exp: value.exp,
    iss: value.iss,
    ...(typeof value.nbf === 'number' ? { nbf: value.nbf } : {}),
    ...(typeof value.sub === 'string' ? { sub: value.sub } : {}),
    ...(typeof value.common_name === 'string' ? { common_name: value.common_name } : {}),
  };
}

function parseJsonSegment(segment: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw malformedToken();
  }
}

function decodeBase64Url(segment: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw malformedToken();
  const normalized = segment.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw malformedToken();
  }
}

function malformedToken(): AccessControlError {
  return new AccessControlError(401, 'access_required', 'Cloudflare Access token is malformed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
