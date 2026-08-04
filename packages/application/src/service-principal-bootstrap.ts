import {
  AccessControlError,
  createExternalIdentityCandidate,
  createPlatformRoleGrantCandidate,
  createSubjectCandidate,
  type ExternalIdentity,
  type PlatformRoleGrant,
  type Subject,
} from '@access-control/domain';
import { createMutationRecords, type MutationRecords } from './events';
import type { ServiceRuntime } from './runtime';

export interface ServicePrincipalBootstrapRecords {
  subject: Subject;
  identity: ExternalIdentity;
  roleGrant: PlatformRoleGrant;
  mutation: MutationRecords;
}

export function assertServicePrincipalBootstrapAllowed(input: {
  activeAdministratorId?: string;
  duplicateIdentityExists: boolean;
}): string {
  if (input.activeAdministratorId === undefined) {
    throw new AccessControlError(
      409,
      'administrator_required',
      'An active administrator must exist before bootstrapping a service principal.',
    );
  }
  if (input.duplicateIdentityExists) {
    throw new AccessControlError(
      409,
      'service_identity_already_exists',
      'The Cloudflare Access service identity is already bound.',
    );
  }
  return input.activeAdministratorId;
}

export function createServicePrincipalBootstrapRecords(
  input: {
    administratorId: string;
    issuer: string;
    commonName: string;
    role: 'auditor' | 'operator';
    requestId: string;
  },
  runtime: ServiceRuntime,
): ServicePrincipalBootstrapRecords {
  const now = runtime.now();
  const subject = createSubjectCandidate({
    id: runtime.id('subject'),
    kind: 'service',
    classification: 'automation',
    displayName: input.commonName,
    status: 'active',
    directoryState: 'active',
    protected: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: input.administratorId,
    updatedBy: input.administratorId,
  });
  const identity = createExternalIdentityCandidate({
    id: runtime.id('identity'),
    subjectId: subject.id,
    provider: 'cloudflare_access',
    issuer: input.issuer,
    providerSubject: input.commonName,
    displayName: input.commonName,
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: input.administratorId,
    updatedBy: input.administratorId,
  });
  const roleGrant = createPlatformRoleGrantCandidate({
    id: runtime.id('role-grant'),
    subjectId: subject.id,
    role: input.role,
    active: true,
    protected: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: input.administratorId,
    updatedBy: input.administratorId,
  });
  return {
    subject,
    identity,
    roleGrant,
    mutation: createMutationRecords(
      runtime,
      { actorSubjectId: input.administratorId, requestId: input.requestId },
      {
        eventType: 'access-control.service-principal.bootstrapped',
        topic: 'access-control.service-principal.bootstrapped',
        targetType: 'subject',
        targetId: subject.id,
        action: 'bootstrap',
        resultingRevision: 1,
        payload: {
          externalIdentityId: identity.id,
          commonName: input.commonName,
          role: input.role,
        },
      },
    ),
  };
}
