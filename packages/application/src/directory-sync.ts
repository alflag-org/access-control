import type { DirectoryAdapter, DirectorySnapshot } from '@access-control/contracts';
import {
  AccessControlError,
  NotFoundError,
  calculateEffectiveGrants,
  createDirectorySyncRunCandidate,
  createDirectorySyncViolationCandidate,
  createExternalIdentityCandidate,
  createSourceGroupCandidate,
  createSourceGroupMembershipCandidate,
  createSubjectCandidate,
  type DirectorySource,
  type DirectorySyncRun,
  type ExternalIdentity,
  type SourceGroup,
  type SourceGroupMembership,
  type Subject,
} from '@access-control/domain';
import { createMutationRecords } from './events';
import type { AccessControlRepositories, DirectoryPublication } from './ports';
import type { ServiceRuntime } from './runtime';
import type { RequiredActorContext } from './catalog';

export class DirectorySyncService {
  public constructor(
    private readonly repositories: AccessControlRepositories,
    private readonly adapter: DirectoryAdapter,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async synchronize(
    directorySourceId: string,
    context: RequiredActorContext,
  ): Promise<DirectorySyncRun> {
    const source = await this.repositories.directory.getDirectorySource(directorySourceId);
    if (source === null) throw new NotFoundError('Directory source', directorySourceId);
    if (source.status !== 'active') {
      throw new AccessControlError(
        422,
        'directory_source_inactive',
        'The directory source is disabled.',
      );
    }
    const runId = this.runtime.id('directory-sync');
    const startedAt = this.runtime.now();
    const running = createDirectorySyncRunCandidate({
      id: runId,
      directorySourceId,
      status: 'running',
      startedAt,
      userCount: 0,
      groupCount: 0,
      membershipCount: 0,
      violationCount: 0,
      requestId: context.requestId,
    });
    await this.repositories.directory.createDirectorySyncRun(
      running,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.directory.sync.started',
        topic: 'access-control.directory.sync.started',
        targetType: 'directory_sync_run',
        targetId: runId,
        action: 'start',
        payload: { directorySourceId },
      }),
    );

    try {
      const snapshot = await this.adapter.observeDirectory({
        directorySourceId: source.id,
        customerId: source.customerId,
        delegatedAdmin: source.delegatedAdmin,
        credentialRef: source.credentialRef,
        accessGroupPrefix: source.accessGroupPrefix,
      });
      if (snapshot.directorySourceId !== source.id) {
        throw new AccessControlError(
          422,
          'directory_snapshot_source_mismatch',
          'The directory snapshot belongs to another source.',
        );
      }
      const publication = await this.buildPublication(source, running, snapshot, context);
      await this.repositories.directory.publishDirectorySnapshot(publication);
      return publication.syncRun;
    } catch (error) {
      const failed = createDirectorySyncRunCandidate({
        ...running,
        status: 'failed',
        completedAt: this.runtime.now(),
        errorCode: stableDirectoryErrorCode(error),
      });
      await this.repositories.directory.failDirectorySyncRun(
        failed,
        createMutationRecords(this.runtime, context, {
          eventType: 'access-control.directory.sync.failed',
          topic: 'access-control.directory.sync.failed',
          targetType: 'directory_sync_run',
          targetId: runId,
          action: 'fail',
          result: 'failed',
          payload: { directorySourceId, errorCode: failed.errorCode ?? 'directory_sync_failed' },
        }),
      );
      if (error instanceof AccessControlError) throw error;
      throw new AccessControlError(
        503,
        'directory_sync_failed',
        'The complete Google Directory snapshot could not be read.',
      );
    }
  }

  private async buildPublication(
    source: DirectorySource,
    running: DirectorySyncRun,
    snapshot: DirectorySnapshot,
    context: RequiredActorContext,
  ): Promise<DirectoryPublication> {
    const grantInputRevision = await this.repositories.catalog.getGrantInputRevision();
    const [
      currentSubjects,
      currentIdentities,
      guests,
      currentGroups,
      currentMemberships,
      mappings,
      applications,
      entitlements,
    ] = await Promise.all([
      this.repositories.identities.listSubjects(),
      this.repositories.identities.listExternalIdentities(),
      this.repositories.identities.listGuestProfiles(),
      this.repositories.catalog.listSourceGroups(),
      this.repositories.catalog.listSourceGroupMemberships(),
      this.repositories.catalog.listEntitlementMappings(),
      this.repositories.catalog.listApplications(),
      this.repositories.catalog.listApplicationEntitlements(),
    ]);
    if ((await this.repositories.catalog.getGrantInputRevision()) !== grantInputRevision) {
      throw new AccessControlError(
        409,
        'grant_inputs_changed',
        'Effective Grant inputs changed while the directory snapshot was being built; retry the sync.',
      );
    }
    const issuer = googleDirectoryIssuer(source.customerId);
    const subjectsById = new Map(currentSubjects.map((subject) => [subject.id, subject]));
    const identitiesByProviderSubject = new Map(
      currentIdentities
        .filter((identity) => identity.provider === 'google' && identity.issuer === issuer)
        .map((identity) => [identity.providerSubject, identity]),
    );
    const publishedSubjects: Subject[] = [];
    const publishedIdentities: ExternalIdentity[] = [];
    const observedUserIds = new Set<string>();

    for (const user of snapshot.users) {
      observedUserIds.add(user.immutableId);
      const existingIdentity = identitiesByProviderSubject.get(user.immutableId);
      const existingSubject =
        existingIdentity === undefined ? undefined : subjectsById.get(existingIdentity.subjectId);
      const now = snapshot.observedAt;
      const subjectId = existingSubject?.id ?? this.runtime.id('subject');
      const directoryState =
        user.lifecycle === 'deleted' ? 'missing' : user.suspended ? 'suspended' : 'active';
      const status =
        user.lifecycle === 'deleted' ? 'retired' : user.suspended ? 'suspended' : 'active';
      const subject = createSubjectCandidate({
        id: subjectId,
        kind: 'human',
        classification: existingSubject?.classification ?? 'member',
        displayName: user.displayName,
        primaryEmail: user.primaryEmail,
        status,
        directoryState,
        protected: existingSubject?.protected ?? false,
        revision: existingSubject === undefined ? 1 : existingSubject.revision + 1,
        createdAt: existingSubject?.createdAt ?? now,
        updatedAt: now,
        createdBy: existingSubject?.createdBy ?? context.actorSubjectId,
        updatedBy: context.actorSubjectId,
      });
      const identity = createExternalIdentityCandidate({
        id: existingIdentity?.id ?? this.runtime.id('identity'),
        subjectId,
        provider: 'google',
        issuer,
        providerSubject: user.immutableId,
        displayName: user.displayName,
        email: user.primaryEmail,
        status: user.lifecycle === 'deleted' ? 'missing' : 'active',
        revision: existingIdentity === undefined ? 1 : existingIdentity.revision + 1,
        createdAt: existingIdentity?.createdAt ?? now,
        updatedAt: now,
        createdBy: existingIdentity?.createdBy ?? context.actorSubjectId,
        updatedBy: context.actorSubjectId,
      });
      publishedSubjects.push(subject);
      publishedIdentities.push(identity);
      subjectsById.set(subject.id, subject);
      identitiesByProviderSubject.set(identity.providerSubject, identity);
    }

    for (const identity of identitiesByProviderSubject.values()) {
      if (observedUserIds.has(identity.providerSubject)) continue;
      const subject = subjectsById.get(identity.subjectId);
      if (subject === undefined) continue;
      const missingSubject = createSubjectCandidate({
        ...subject,
        directoryState: 'missing',
        revision: subject.revision + 1,
        updatedAt: snapshot.observedAt,
        updatedBy: context.actorSubjectId,
      });
      const missingIdentity = createExternalIdentityCandidate({
        ...identity,
        status: 'missing',
        revision: identity.revision + 1,
        updatedAt: snapshot.observedAt,
        updatedBy: context.actorSubjectId,
      });
      publishedSubjects.push(missingSubject);
      publishedIdentities.push(missingIdentity);
      subjectsById.set(missingSubject.id, missingSubject);
      identitiesByProviderSubject.set(missingIdentity.providerSubject, missingIdentity);
    }

    const currentGroupsByProviderId = new Map(
      currentGroups
        .filter((group) => group.directorySourceId === source.id)
        .map((group) => [group.providerGroupId, group]),
    );
    const sourceGroups: SourceGroup[] = [];
    const groupsByProviderId = new Map<string, SourceGroup>();
    const observedGroupIds = new Set<string>();
    const membershipCounts = new Map<string, number>();
    for (const membership of snapshot.memberships) {
      membershipCounts.set(
        membership.groupImmutableId,
        (membershipCounts.get(membership.groupImmutableId) ?? 0) + 1,
      );
    }
    for (const group of snapshot.groups) {
      observedGroupIds.add(group.immutableId);
      const existing = currentGroupsByProviderId.get(group.immutableId);
      const sourceGroup = createSourceGroupCandidate({
        id: existing?.id ?? this.runtime.id('source-group'),
        directorySourceId: source.id,
        providerGroupId: group.immutableId,
        email: group.email,
        aliases: group.aliases,
        name: group.name,
        kind: group.email.toLowerCase().startsWith(source.accessGroupPrefix.toLowerCase())
          ? 'access'
          : 'unmanaged',
        status: group.lifecycle === 'active' ? 'active' : 'missing',
        directMemberCount: membershipCounts.get(group.immutableId) ?? 0,
        lastSyncRunId: running.id,
        lastObservedAt: snapshot.observedAt,
        revision: existing === undefined ? 1 : existing.revision + 1,
        createdAt: existing?.createdAt ?? snapshot.observedAt,
        updatedAt: snapshot.observedAt,
      });
      sourceGroups.push(sourceGroup);
      groupsByProviderId.set(group.immutableId, sourceGroup);
    }
    for (const existing of currentGroupsByProviderId.values()) {
      if (observedGroupIds.has(existing.providerGroupId)) continue;
      const missing = createSourceGroupCandidate({
        ...existing,
        status: 'missing',
        directMemberCount: 0,
        lastSyncRunId: running.id,
        lastObservedAt: snapshot.observedAt,
        revision: existing.revision + 1,
        updatedAt: snapshot.observedAt,
      });
      sourceGroups.push(missing);
      groupsByProviderId.set(missing.providerGroupId, missing);
    }

    const currentMembershipsByKey = new Map(
      currentMemberships.map((membership) => [
        `${membership.sourceGroupId}:${membership.providerMembershipId}`,
        membership,
      ]),
    );
    const memberships: SourceGroupMembership[] = [];
    const observedMembershipKeys = new Set<string>();
    const violations = [];
    for (const membership of snapshot.memberships) {
      const group = groupsByProviderId.get(membership.groupImmutableId);
      if (group === undefined) continue;
      const key = `${group.id}:${membership.immutableId}`;
      observedMembershipKeys.add(key);
      const existing = currentMembershipsByKey.get(key);
      memberships.push(
        createSourceGroupMembershipCandidate({
          id: existing?.id ?? this.runtime.id('source-group-membership'),
          sourceGroupId: group.id,
          providerMembershipId: membership.immutableId,
          memberType: membership.memberType,
          memberProviderId: membership.memberImmutableId,
          ...(membership.memberEmail === undefined ? {} : { memberEmail: membership.memberEmail }),
          role: membership.role,
          status: 'active',
          syncRunId: running.id,
          observedAt: snapshot.observedAt,
        }),
      );
      if (group.kind === 'access' && membership.memberType !== 'user') {
        violations.push(
          createDirectorySyncViolationCandidate({
            id: this.runtime.id('directory-violation'),
            syncRunId: running.id,
            code:
              membership.memberType === 'group'
                ? 'nested_access_group'
                : 'unmanaged_external_member',
            entityType: 'membership',
            entityId: membership.immutableId,
            field: 'memberType',
            message:
              membership.memberType === 'group'
                ? 'Nested access groups are not expanded.'
                : 'Unmanaged external members do not receive access.',
            recordedAt: snapshot.observedAt,
          }),
        );
      }
      if (
        group.kind === 'access' &&
        membership.memberType === 'user' &&
        !identitiesByProviderSubject.has(membership.memberImmutableId)
      ) {
        violations.push(
          createDirectorySyncViolationCandidate({
            id: this.runtime.id('directory-violation'),
            syncRunId: running.id,
            code: 'missing_subject',
            entityType: 'membership',
            entityId: membership.immutableId,
            field: 'memberImmutableId',
            message: 'The direct group member has no observed directory Subject.',
            recordedAt: snapshot.observedAt,
          }),
        );
      }
    }
    for (const existing of currentMemberships) {
      if (!sourceGroups.some((group) => group.id === existing.sourceGroupId)) continue;
      const key = `${existing.sourceGroupId}:${existing.providerMembershipId}`;
      if (observedMembershipKeys.has(key)) continue;
      memberships.push(
        createSourceGroupMembershipCandidate({
          ...existing,
          status: 'missing',
          syncRunId: running.id,
          observedAt: snapshot.observedAt,
        }),
      );
    }

    const mergedSubjects = mergeById(currentSubjects, publishedSubjects);
    const mergedIdentities = mergeById(currentIdentities, publishedIdentities);
    const mergedGroups = mergeById(currentGroups, sourceGroups);
    const mergedMemberships = mergeById(currentMemberships, memberships);
    const effectiveGrants = calculateEffectiveGrants({
      subjects: mergedSubjects,
      externalIdentities: mergedIdentities,
      guestProfiles: guests,
      sourceGroups: mergedGroups,
      memberships: mergedMemberships,
      mappings,
      applications,
      entitlements,
      calculatedAt: snapshot.observedAt,
    }).grants;
    const completed = createDirectorySyncRunCandidate({
      ...running,
      status: 'completed',
      completedAt: this.runtime.now(),
      snapshotVersion: snapshot.snapshotVersion,
      userCount: snapshot.users.length,
      groupCount: snapshot.groups.length,
      membershipCount: snapshot.memberships.length,
      violationCount: violations.length,
    });
    return {
      grantInputRevision,
      syncRun: completed,
      violations,
      subjects: publishedSubjects,
      externalIdentities: publishedIdentities,
      sourceGroups,
      memberships,
      effectiveGrants,
      mutation: createMutationRecords(this.runtime, context, {
        eventType: 'access-control.directory.sync.completed',
        topic: 'access-control.directory.sync.completed',
        targetType: 'directory_sync_run',
        targetId: running.id,
        action: 'publish_snapshot',
        payload: {
          directorySourceId: source.id,
          snapshotVersion: snapshot.snapshotVersion,
          userCount: completed.userCount,
          groupCount: completed.groupCount,
          membershipCount: completed.membershipCount,
          violationCount: completed.violationCount,
        },
      }),
    };
  }
}

function googleDirectoryIssuer(customerId: string): string {
  return `urn:google-directory:customer:${customerId}`;
}

function mergeById<Entity extends { id: string }>(current: Entity[], updates: Entity[]): Entity[] {
  const merged = new Map(current.map((entity) => [entity.id, entity]));
  for (const update of updates) merged.set(update.id, update);
  return [...merged.values()];
}

function stableDirectoryErrorCode(error: unknown): string {
  if (error instanceof AccessControlError) return error.code;
  return 'directory_dependency_unavailable';
}
