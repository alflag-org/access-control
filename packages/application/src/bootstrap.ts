import {
  AccessControlError,
  createExternalIdentityCandidate,
  createOrganizationSettingsCandidate,
  createPlatformRoleGrantCandidate,
  createSubjectCandidate,
  type OrganizationSettings,
  type PlatformRoleGrant,
  type Subject,
} from '@access-control/domain';
import { createMutationRecords, type MutationContext } from './events';
import type { IdentityRepository } from './ports';
import type { ServiceRuntime } from './runtime';

export interface BootstrapInput {
  environment: 'development' | 'staging' | 'production';
  canonicalIdentity: string;
  accessIssuer?: string;
  displayName: string;
  organizationName: string;
  supportUrl?: string;
}

export interface BootstrapResult {
  organizationSettings: OrganizationSettings;
  subject: Subject;
  platformRoleGrant: PlatformRoleGrant;
}

export class BootstrapService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async execute(input: BootstrapInput, context: MutationContext): Promise<BootstrapResult> {
    if ((await this.repository.listSubjects()).length > 0) {
      throw new AccessControlError(
        409,
        'administrator_already_bootstrapped',
        'The first administrator has already been created.',
      );
    }
    const identity = parseBootstrapIdentity(input);
    if (identity.principalType !== 'human') {
      throw new AccessControlError(
        422,
        'human_bootstrap_identity_required',
        'The first administrator must use a human Access identity.',
      );
    }
    const now = this.runtime.now();
    const subjectId = this.runtime.id('subject');
    const subject = createSubjectCandidate({
      id: subjectId,
      kind: 'human',
      classification: 'member',
      displayName: input.displayName,
      status: 'active',
      directoryState: 'pending',
      protected: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: subjectId,
      updatedBy: subjectId,
    });
    const organizationSettings = createOrganizationSettingsCandidate({
      id: 'organization',
      organizationName: input.organizationName,
      title: input.organizationName,
      ...(input.supportUrl === undefined ? {} : { supportUrl: input.supportUrl }),
      maxPlanChanges: 20,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: subjectId,
      updatedBy: subjectId,
    });
    const externalIdentity = createExternalIdentityCandidate({
      id: this.runtime.id('identity'),
      subjectId,
      provider: 'cloudflare_access',
      issuer: identity.issuer,
      providerSubject: identity.providerSubject,
      displayName: input.displayName,
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: subjectId,
      updatedBy: subjectId,
    });
    const platformRoleGrant = createPlatformRoleGrantCandidate({
      id: this.runtime.id('role-grant'),
      subjectId,
      role: 'admin',
      active: true,
      protected: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: subjectId,
      updatedBy: subjectId,
    });
    const mutation = createMutationRecords(
      this.runtime,
      { ...context, actorSubjectId: subjectId },
      {
        eventType: 'access-control.organization.bootstrapped',
        topic: 'access-control.organization.bootstrapped',
        targetType: 'organization_settings',
        targetId: organizationSettings.id,
        action: 'bootstrap',
        resultingRevision: 1,
        payload: { subjectId, externalIdentityId: externalIdentity.id },
      },
    );
    await this.repository.bootstrap({
      organizationSettings,
      subject,
      externalIdentity,
      platformRoleGrant,
      mutation,
    });
    return { organizationSettings, subject, platformRoleGrant };
  }
}

function parseBootstrapIdentity(input: BootstrapInput): {
  principalType: 'human' | 'service';
  issuer: string;
  providerSubject: string;
} {
  const match = /^(access|service):([^\s].*)$/.exec(input.canonicalIdentity);
  if (match === null || match[2] === undefined || match[2].trim() !== match[2]) {
    throw new AccessControlError(
      422,
      'invalid_bootstrap_identity',
      'Bootstrap identity must use access:<subject> or service:<common-name>.',
    );
  }
  const issuer =
    input.environment === 'development'
      ? match[1] === 'access'
        ? 'local://access-control'
        : 'local://access-control/service'
      : input.accessIssuer;
  if (issuer === undefined) {
    throw new AccessControlError(
      422,
      'access_issuer_required',
      'Staging and production bootstrap require the Cloudflare Access issuer.',
    );
  }
  return {
    principalType: match[1] === 'access' ? 'human' : 'service',
    issuer,
    providerSubject: match[2],
  };
}
