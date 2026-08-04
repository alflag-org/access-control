import type { MiddlewareHandler } from 'hono';
import { createD1Repositories } from '@access-control/d1';
import { AccessControlError, type PlatformRole, type Subject } from '@access-control/domain';
import { authenticateAccessPrincipal } from '../auth/access';
import type { WorkerEnvironment } from './environment';

const MUTATING_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

export const requestContext: MiddlewareHandler<WorkerEnvironment> = async (context, next) => {
  context.set('requestId', context.req.header('cf-ray') ?? `request:${crypto.randomUUID()}`);
  // Static client code contains no Subject data and must not open a second D1 read during page load.
  if (new URL(context.req.url).pathname === '/assets/forms.js') {
    await next();
    return;
  }
  const repositories = createD1Repositories(context.env.DB);
  context.set('repositories', repositories);
  const principal = await authenticateAccessPrincipal(context.req.raw, context.env);
  context.set('accessPrincipal', principal);
  const identity = await repositories.identities.findExternalIdentity(
    principal.provider,
    principal.issuer,
    principal.providerSubject,
  );
  let subject: Subject | null = null;
  let roles: PlatformRole[] = [];
  if (identity !== null && identity.status === 'active') {
    subject = await repositories.identities.getSubject(identity.subjectId);
    if (subject?.classification === 'managed_guest') {
      const guest = await repositories.identities.getGuestProfile(subject.id);
      const sponsor =
        guest === null ? null : await repositories.identities.getSubject(guest.sponsorSubjectId);
      const now = Date.now();
      if (
        guest === null ||
        guest.status !== 'active' ||
        Date.parse(guest.validFrom) > now ||
        Date.parse(guest.expiresAt) <= now ||
        sponsor?.status !== 'active' ||
        sponsor.directoryState !== 'active'
      ) {
        subject = null;
      }
    }
    if (subject !== null) {
      roles = (await repositories.identities.listPlatformRoleGrants(subject.id))
        .filter((grant) => grant.active)
        .map((grant) => grant.role);
    }
  }
  context.set('subject', subject);
  context.set('roles', [...new Set(roles)].sort());
  await next();
};

export const mutationOrigin: MiddlewareHandler<WorkerEnvironment> = async (context, next) => {
  if (!MUTATING_METHODS.has(context.req.method)) {
    await next();
    return;
  }
  if (context.req.header('sec-fetch-site')?.toLowerCase() === 'cross-site') {
    throw new AccessControlError(
      403,
      'cross_site_mutation',
      'Cross-site browser mutation requests are not permitted.',
    );
  }
  const origin = context.req.header('origin');
  if (origin !== undefined && origin !== new URL(context.req.url).origin) {
    throw new AccessControlError(
      403,
      'cross_site_mutation',
      'Browser mutation requests must use the Access Control origin.',
    );
  }
  await next();
};

export function requireSubject(context: { get(name: 'subject'): Subject | null }): Subject {
  const subject = context.get('subject');
  if (subject === null) {
    throw new AccessControlError(
      403,
      'subject_not_mapped',
      'The authenticated identity is not mapped to an Access Control Subject.',
    );
  }
  if (subject.status !== 'active') {
    throw new AccessControlError(
      403,
      'subject_inactive',
      'The mapped Access Control Subject is not active.',
    );
  }
  return subject;
}

export function requireRoles(
  context: {
    get(name: 'roles'): PlatformRole[];
    get(name: 'subject'): Subject | null;
  },
  acceptedRoles: readonly PlatformRole[],
): Subject {
  const subject = requireSubject(context);
  const roles = context.get('roles');
  if (!roles.some((role) => acceptedRoles.includes(role))) {
    throw new AccessControlError(
      403,
      'role_forbidden',
      'The Subject roles cannot perform this operation.',
    );
  }
  return subject;
}
