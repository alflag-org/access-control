import {
  AccessControlError,
  NotFoundError,
  RevisionConflictError,
  createExternalIdentityCandidate,
  createGuestProfileCandidate,
  createPlatformRoleGrantCandidate,
  createSubjectCandidate,
  isDirectoryManagedSubject,
  type GuestProfile,
  type ExternalIdentity,
  type PlatformRole,
  type PlatformRoleGrant,
  type Subject,
} from '@access-control/domain';
import { createMutationRecords } from './events';
import type { IdentityRepository } from './ports';
import type { ServiceRuntime } from './runtime';
import type { RequiredActorContext } from './catalog';

export interface CreateManagedGuestInput {
  displayName: string;
  primaryEmail?: string;
  sponsorSubjectId: string;
  externalContactEmail: string;
  externalOrganization: string;
  purpose: string;
  validFrom: string;
  expiresAt: string;
  nextReviewAt?: string;
}

export interface UpdateSubjectProfileInput {
  displayName: string;
  primaryEmail?: string | null | undefined;
  expectedRevision: number;
}

export interface UpdateManagedGuestProfileInput {
  displayName?: string | undefined;
  primaryEmail?: string | null | undefined;
  externalContactEmail: string;
  externalOrganization: string;
  purpose: string;
  expectedSubjectRevision: number;
  expectedGuestRevision: number;
}

export interface BindExternalIdentityInput {
  provider: 'google' | 'github';
  issuer: string;
  providerSubject: string;
  expectedSubjectRevision: number;
  confirmed: boolean;
}

export interface GrantAdministrationRoleInput {
  role: PlatformRole;
  expectedSubjectRevision: number;
}

export class IdentityService {
  public constructor(
    private readonly repository: IdentityRepository,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async createManagedGuest(
    input: CreateManagedGuestInput,
    context: RequiredActorContext,
  ): Promise<{ subject: Subject; guestProfile: GuestProfile }> {
    const sponsor = await this.repository.getSubject(input.sponsorSubjectId);
    if (sponsor === null) throw new NotFoundError('Sponsor Subject', input.sponsorSubjectId);
    if (sponsor.status !== 'active') {
      throw new AccessControlError(
        422,
        'active_sponsor_required',
        'A managed guest requires an active sponsor.',
      );
    }
    const now = this.runtime.now();
    if (Date.parse(input.expiresAt) <= Date.parse(now)) {
      throw new AccessControlError(
        422,
        'future_guest_expiration_required',
        'A managed guest requires a future expiration time.',
      );
    }
    const subject = createSubjectCandidate({
      id: this.runtime.id('subject'),
      kind: 'human',
      classification: 'managed_guest',
      displayName: input.displayName,
      ...(input.primaryEmail === undefined ? {} : { primaryEmail: input.primaryEmail }),
      status: 'pending',
      directoryState: 'pending',
      protected: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    const guestProfile = createGuestProfileCandidate({
      subjectId: subject.id,
      sponsorSubjectId: input.sponsorSubjectId,
      externalContactEmail: input.externalContactEmail,
      externalOrganization: input.externalOrganization,
      purpose: input.purpose,
      validFrom: input.validFrom,
      expiresAt: input.expiresAt,
      ...(input.nextReviewAt === undefined ? {} : { nextReviewAt: input.nextReviewAt }),
      status: 'pending',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.repository.createManagedGuest({
      subject,
      guestProfile,
      mutation: createMutationRecords(this.runtime, context, {
        eventType: 'access-control.guest.created',
        topic: 'access-control.guest.created',
        targetType: 'guest_profile',
        targetId: subject.id,
        action: 'create',
        resultingRevision: 1,
        payload: {
          sponsorSubjectId: guestProfile.sponsorSubjectId,
          expiresAt: guestProfile.expiresAt,
        },
      }),
    });
    return { subject, guestProfile };
  }

  public async updateSubjectProfile(
    subjectId: string,
    input: UpdateSubjectProfileInput,
    context: RequiredActorContext,
  ): Promise<Subject> {
    const current = await this.requireSubject(subjectId);
    assertSubjectProfileEditable(current);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    const subject = updateSubjectProfile(
      current,
      input,
      context.actorSubjectId,
      this.runtime.now(),
    );
    await this.repository.updateSubject(
      subject,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.subject.profile.updated',
        topic: 'access-control.subject.profile.updated',
        targetType: 'subject',
        targetId: subject.id,
        action: 'update_profile',
        previousRevision: current.revision,
        resultingRevision: subject.revision,
        payload: { changedFields: subjectProfileChangedFields(current, subject) },
      }),
      input.expectedRevision,
    );
    return subject;
  }

  public async updateManagedGuestProfile(
    subjectId: string,
    input: UpdateManagedGuestProfileInput,
    context: RequiredActorContext,
  ): Promise<{ subject: Subject; guestProfile: GuestProfile }> {
    const [currentSubject, currentGuest] = await Promise.all([
      this.requireSubject(subjectId),
      this.repository.getGuestProfile(subjectId),
    ]);
    if (currentGuest === null) throw new NotFoundError('Guest profile', subjectId);
    if (
      currentSubject.status === 'retired' ||
      currentGuest.status === 'expired' ||
      currentGuest.status === 'retired'
    ) {
      throw new AccessControlError(
        409,
        'guest_profile_not_editable',
        'An expired or retired managed guest profile cannot be edited.',
      );
    }
    if (currentSubject.revision !== input.expectedSubjectRevision) {
      throw new RevisionConflictError(input.expectedSubjectRevision, currentSubject.revision);
    }
    if (currentGuest.revision !== input.expectedGuestRevision) {
      throw new RevisionConflictError(input.expectedGuestRevision, currentGuest.revision);
    }
    const now = this.runtime.now();
    const subject = updateSubjectProfile(currentSubject, input, context.actorSubjectId, now);
    if (
      isDirectoryManagedSubject(currentSubject) &&
      subjectProfileChangedFields(currentSubject, subject).length > 0
    ) {
      throw new AccessControlError(
        409,
        'directory_managed_profile',
        'A Google Directory managed profile must be changed in Google Directory.',
      );
    }
    const guestProfile = createGuestProfileCandidate({
      ...currentGuest,
      externalContactEmail: input.externalContactEmail,
      externalOrganization: input.externalOrganization,
      purpose: input.purpose,
      revision: currentGuest.revision + 1,
      updatedAt: now,
      updatedBy: context.actorSubjectId,
    });
    await this.repository.updateManagedGuest(
      subject,
      guestProfile,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.guest.profile.updated',
        topic: 'access-control.guest.profile.updated',
        targetType: 'guest_profile',
        targetId: subjectId,
        action: 'update_profile',
        previousRevision: currentGuest.revision,
        resultingRevision: guestProfile.revision,
        payload: {
          subjectChangedFields: subjectProfileChangedFields(currentSubject, subject),
          guestChangedFields: guestProfileChangedFields(currentGuest, guestProfile),
        },
      }),
      input.expectedSubjectRevision,
      input.expectedGuestRevision,
    );
    return { subject, guestProfile };
  }

  public async updateSubjectStatus(
    subjectId: string,
    input: { status: Subject['status']; expectedRevision: number; confirmed: boolean },
    context: RequiredActorContext,
  ): Promise<Subject> {
    const current = await this.requireSubject(subjectId);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    if (current.status === 'active' && input.status !== 'active' && !input.confirmed) {
      throw new AccessControlError(
        422,
        'confirmation_required',
        'Subject deactivation requires explicit confirmation.',
      );
    }
    const subject = createSubjectCandidate({
      ...current,
      status: input.status,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.repository.updateSubject(
      subject,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.subject.updated',
        topic: 'access-control.subject.updated',
        targetType: 'subject',
        targetId: subject.id,
        action: 'change_status',
        previousRevision: current.revision,
        resultingRevision: subject.revision,
        payload: { previousStatus: current.status, status: subject.status },
      }),
      input.expectedRevision,
    );
    return subject;
  }

  public async bindExternalIdentity(
    subjectId: string,
    input: BindExternalIdentityInput,
    context: RequiredActorContext,
  ): Promise<{ subject: Subject; identity: ExternalIdentity }> {
    if (!input.confirmed) {
      throw new AccessControlError(
        422,
        'identity_binding_confirmation_required',
        'External identity binding requires explicit immutable-ID confirmation.',
      );
    }
    assertImmutableIdentityKey(input);
    const current = await this.requireSubject(subjectId);
    if (current.revision !== input.expectedSubjectRevision) {
      throw new RevisionConflictError(input.expectedSubjectRevision, current.revision);
    }
    if (current.classification !== 'managed_guest') {
      throw new AccessControlError(
        422,
        'managed_guest_required',
        'This identity binding operation is limited to managed guests.',
      );
    }
    if (current.status === 'retired') {
      throw new AccessControlError(
        422,
        'active_guest_identity_binding_required',
        'A retired managed guest cannot receive an external identity binding.',
      );
    }
    const [guestProfile, existingIdentity, subjectIdentities] = await Promise.all([
      this.repository.getGuestProfile(current.id),
      this.repository.findExternalIdentity(input.provider, input.issuer, input.providerSubject),
      this.repository.listExternalIdentities(current.id),
    ]);
    if (guestProfile === null) throw new NotFoundError('Guest profile', current.id);
    if (guestProfile.status === 'expired' || guestProfile.status === 'retired') {
      throw new AccessControlError(
        422,
        'active_guest_identity_binding_required',
        'An expired or retired managed guest cannot receive an external identity binding.',
      );
    }
    if (existingIdentity !== null) {
      throw new AccessControlError(
        409,
        'identity_binding_conflict',
        'The immutable provider identity is already bound.',
      );
    }
    if (
      subjectIdentities.some(
        (identity) =>
          identity.provider === input.provider &&
          identity.issuer === input.issuer &&
          (identity.status === 'pending' || identity.status === 'active'),
      )
    ) {
      throw new AccessControlError(
        409,
        'identity_provider_already_bound',
        'The managed guest already has an active identity for this provider and issuer.',
      );
    }
    const now = this.runtime.now();
    const subject = createSubjectCandidate({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      updatedBy: context.actorSubjectId,
    });
    const identity = createExternalIdentityCandidate({
      id: this.runtime.id('identity'),
      subjectId: current.id,
      provider: input.provider,
      issuer: input.issuer,
      providerSubject: input.providerSubject,
      displayName: current.displayName,
      status: 'active',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    try {
      await this.repository.bindExternalIdentity(
        subject,
        identity,
        createMutationRecords(this.runtime, context, {
          eventType: 'access-control.identity.bound',
          topic: 'access-control.identity.bound',
          targetType: 'external_identity',
          targetId: identity.id,
          action: 'bind',
          previousRevision: current.revision,
          resultingRevision: subject.revision,
          payload: {
            subjectId: current.id,
            provider: identity.provider,
            issuer: identity.issuer,
            providerSubject: identity.providerSubject,
          },
        }),
        input.expectedSubjectRevision,
      );
    } catch (error) {
      if (
        error instanceof AccessControlError &&
        (error.code === 'uniqueness_conflict' || error.code === 'persistence_conflict')
      ) {
        throw new AccessControlError(
          409,
          'identity_binding_conflict',
          'The immutable provider identity could not be bound because the records changed.',
        );
      }
      throw error;
    }
    return { subject, identity };
  }

  public async grantAdministrationRole(
    subjectId: string,
    input: GrantAdministrationRoleInput,
    context: RequiredActorContext,
  ): Promise<PlatformRoleGrant> {
    const [subject, grants] = await Promise.all([
      this.requireSubject(subjectId),
      this.repository.listPlatformRoleGrants(subjectId),
    ]);
    if (subject.status !== 'active') {
      throw new AccessControlError(
        422,
        'active_subject_required',
        'An administration role can be granted only to an active Subject.',
      );
    }
    if (subject.revision !== input.expectedSubjectRevision) {
      throw new RevisionConflictError(input.expectedSubjectRevision, subject.revision);
    }
    const current = grants.find((grant) => grant.role === input.role);
    if (current?.active === true) {
      throw new AccessControlError(
        409,
        'administration_role_already_granted',
        'The Subject already has this active administration role.',
      );
    }
    const now = this.runtime.now();
    const grant = createPlatformRoleGrantCandidate(
      current === undefined
        ? {
            id: this.runtime.id('role-grant'),
            subjectId,
            role: input.role,
            active: true,
            protected: false,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            createdBy: context.actorSubjectId,
            updatedBy: context.actorSubjectId,
          }
        : {
            ...current,
            active: true,
            revision: current.revision + 1,
            updatedAt: now,
            updatedBy: context.actorSubjectId,
          },
    );
    const mutation = createMutationRecords(this.runtime, context, {
      eventType: 'access-control.platform-role.granted',
      topic: 'access-control.platform-role.granted',
      targetType: 'platform_role_grant',
      targetId: grant.id,
      action: current === undefined ? 'grant' : 'reactivate',
      ...(current === undefined ? {} : { previousRevision: current.revision }),
      resultingRevision: grant.revision,
      payload: { subjectId: grant.subjectId, role: grant.role, active: true },
    });
    if (current === undefined) {
      await this.repository.createRoleGrant(grant, mutation, input.expectedSubjectRevision);
    } else {
      await this.repository.reactivateRoleGrant(
        grant,
        mutation,
        current.revision,
        input.expectedSubjectRevision,
      );
    }
    return grant;
  }

  public async deactivateAdministrationRole(
    grantId: string,
    input: { expectedRevision: number; confirmed: boolean },
    context: RequiredActorContext,
  ): Promise<PlatformRoleGrant> {
    const grants = await this.repository.listPlatformRoleGrants();
    const current = grants.find((grant) => grant.id === grantId);
    if (current === undefined) throw new NotFoundError('Platform role grant', grantId);
    if (!current.active) {
      throw new AccessControlError(
        409,
        'administration_role_already_inactive',
        'The administration role grant is already inactive.',
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    if (!input.confirmed) {
      throw new AccessControlError(
        422,
        'confirmation_required',
        'Platform role removal requires explicit confirmation.',
      );
    }
    const grant = createPlatformRoleGrantCandidate({
      ...current,
      active: false,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.repository.updateRoleGrant(
      grant,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.platform-role.updated',
        topic: 'access-control.platform-role.updated',
        targetType: 'platform_role_grant',
        targetId: grant.id,
        action: 'deactivate',
        previousRevision: current.revision,
        resultingRevision: grant.revision,
        payload: { subjectId: grant.subjectId, role: grant.role, active: false },
      }),
      input.expectedRevision,
    );
    return grant;
  }

  public async suspendManagedGuest(
    subjectId: string,
    input: { expectedSubjectRevision: number; expectedGuestRevision: number; confirmed: boolean },
    context: RequiredActorContext,
  ): Promise<{ subject: Subject; guestProfile: GuestProfile }> {
    if (!input.confirmed) {
      throw new AccessControlError(
        422,
        'confirmation_required',
        'Managed guest suspension requires explicit confirmation.',
      );
    }
    const [currentSubject, currentGuest] = await Promise.all([
      this.requireSubject(subjectId),
      this.repository.getGuestProfile(subjectId),
    ]);
    if (currentGuest === null) throw new NotFoundError('Guest profile', subjectId);
    if (currentSubject.revision !== input.expectedSubjectRevision) {
      throw new RevisionConflictError(input.expectedSubjectRevision, currentSubject.revision);
    }
    if (currentGuest.revision !== input.expectedGuestRevision) {
      throw new RevisionConflictError(input.expectedGuestRevision, currentGuest.revision);
    }
    const now = this.runtime.now();
    const subject = createSubjectCandidate({
      ...currentSubject,
      status: 'suspended',
      revision: currentSubject.revision + 1,
      updatedAt: now,
      updatedBy: context.actorSubjectId,
    });
    const guestProfile = createGuestProfileCandidate({
      ...currentGuest,
      status: 'suspended',
      revision: currentGuest.revision + 1,
      updatedAt: now,
      updatedBy: context.actorSubjectId,
    });
    await this.repository.updateManagedGuest(
      subject,
      guestProfile,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.guest.suspended',
        topic: 'access-control.guest.suspended',
        targetType: 'guest_profile',
        targetId: subjectId,
        action: 'suspend',
        previousRevision: currentGuest.revision,
        resultingRevision: guestProfile.revision,
        payload: { subjectRevision: subject.revision },
      }),
      input.expectedSubjectRevision,
      input.expectedGuestRevision,
    );
    return { subject, guestProfile };
  }

  private async requireSubject(id: string): Promise<Subject> {
    const subject = await this.repository.getSubject(id);
    if (subject === null) throw new NotFoundError('Subject', id);
    return subject;
  }
}

function assertSubjectProfileEditable(subject: Subject): void {
  if (subject.status === 'retired') {
    throw new AccessControlError(
      409,
      'retired_subject_profile',
      'A retired Subject profile cannot be edited.',
    );
  }
  if (isDirectoryManagedSubject(subject)) {
    throw new AccessControlError(
      409,
      'directory_managed_profile',
      'A Google Directory managed profile must be changed in Google Directory.',
    );
  }
}

function updateSubjectProfile(
  current: Subject,
  input: { displayName?: string | undefined; primaryEmail?: string | null | undefined },
  actorSubjectId: string,
  now: string,
): Subject {
  const { primaryEmail: currentPrimaryEmail, ...currentWithoutPrimaryEmail } = current;
  const primaryEmail =
    input.primaryEmail === undefined
      ? currentPrimaryEmail
      : input.primaryEmail === null
        ? undefined
        : input.primaryEmail;
  return createSubjectCandidate({
    ...currentWithoutPrimaryEmail,
    ...(primaryEmail === undefined ? {} : { primaryEmail }),
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    revision: current.revision + 1,
    updatedAt: now,
    updatedBy: actorSubjectId,
  });
}

function subjectProfileChangedFields(current: Subject, next: Subject): string[] {
  const changedFields: string[] = [];
  if (current.displayName !== next.displayName) changedFields.push('displayName');
  if (current.primaryEmail !== next.primaryEmail) changedFields.push('primaryEmail');
  return changedFields;
}

function guestProfileChangedFields(current: GuestProfile, next: GuestProfile): string[] {
  const changedFields: string[] = [];
  if (current.externalContactEmail !== next.externalContactEmail) {
    changedFields.push('externalContactEmail');
  }
  if (current.externalOrganization !== next.externalOrganization) {
    changedFields.push('externalOrganization');
  }
  if (current.purpose !== next.purpose) changedFields.push('purpose');
  return changedFields;
}

function assertImmutableIdentityKey(input: BindExternalIdentityInput): void {
  const googleIdentity =
    input.provider === 'google' &&
    /^urn:google-directory:customer:[^:\s]+$/.test(input.issuer) &&
    /^[A-Za-z0-9_-]{6,128}$/.test(input.providerSubject);
  const githubIdentity =
    input.provider === 'github' &&
    input.issuer === 'https://github.com' &&
    /^[1-9][0-9]{0,19}$/.test(input.providerSubject);
  if (!googleIdentity && !githubIdentity) {
    throw new AccessControlError(
      422,
      'immutable_provider_identity_required',
      'Use a Google Directory immutable user ID or GitHub numeric user ID with its canonical issuer.',
    );
  }
}
