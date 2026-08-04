import {
  AccessControlError,
  NotFoundError,
  RevisionConflictError,
  calculateEffectiveGrants,
  createApplicationCandidate,
  createApplicationEntitlementCandidate,
  createEntitlementMappingCandidate,
  mappingPreviewSchema,
  type Application,
  type ApplicationEntitlement,
  type EntitlementMapping,
  type MappingPreview,
} from '@access-control/domain';
import { createMutationRecords, type MutationContext } from './events';
import type { CatalogRepository, IdentityRepository, ProvisioningRepository } from './ports';
import type { ServiceRuntime } from './runtime';

export interface CreateApplicationInput {
  key: string;
  name: string;
  description?: string;
  category: string;
  launchUrl: string;
  status: 'active' | 'disabled';
  visibility: 'entitled' | 'all_active_subjects';
  authentication: Application['authentication'];
  provisioningMode: Application['provisioningMode'];
}

export interface UpdateApplicationInput extends Omit<
  CreateApplicationInput,
  'description' | 'key' | 'status'
> {
  description?: string | null;
  expectedRevision: number;
  status: Application['status'];
}

export interface CreateEntitlementInput {
  applicationId: string;
  key: string;
  name: string;
  description?: string;
  status?: 'active' | 'disabled';
  requiresProvisioning: boolean;
}

export interface UpdateEntitlementInput {
  name: string;
  description?: string | null;
  status: ApplicationEntitlement['status'];
  requiresProvisioning: boolean;
  expectedRevision: number;
}

export interface CreateMappingInput {
  id?: string;
  sourceGroupId: string;
  entitlementIds: string[];
  provisioningTargetIds?: string[];
  validFrom?: string;
  validUntil?: string;
}

export class CatalogService {
  public constructor(
    private readonly catalog: CatalogRepository,
    private readonly identities: IdentityRepository,
    private readonly runtime: ServiceRuntime,
    private readonly provisioning: ProvisioningRepository,
  ) {}

  public async createApplication(
    input: CreateApplicationInput,
    context: RequiredActorContext,
  ): Promise<Application> {
    const now = this.runtime.now();
    const application = createApplicationCandidate({
      id: this.runtime.id('application'),
      key: input.key,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      category: input.category,
      launchUrl: input.launchUrl,
      status: input.status,
      visibility: input.visibility,
      authentication: input.authentication,
      provisioningMode: input.provisioningMode,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.catalog.createApplication(
      application,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.application.created',
        topic: 'access-control.application.created',
        targetType: 'application',
        targetId: application.id,
        action: 'create',
        resultingRevision: 1,
        payload: { applicationKey: application.key },
      }),
    );
    return application;
  }

  public async updateApplication(
    id: string,
    input: UpdateApplicationInput,
    context: RequiredActorContext,
  ): Promise<Application> {
    const current = await this.requireApplication(id);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    const entitlements = await this.catalog.listApplicationEntitlements(current.id);
    if (
      input.provisioningMode === 'none' &&
      entitlements.some(
        (entitlement) => entitlement.status !== 'retired' && entitlement.requiresProvisioning,
      )
    ) {
      throw invalidConfigurationLifecycle(
        'An application with provisioning-required entitlements cannot use mode none.',
      );
    }
    if (
      input.status === 'retired' &&
      entitlements.some((entitlement) => entitlement.status !== 'retired')
    ) {
      throw invalidConfigurationLifecycle(
        'An application can be retired only after all of its entitlements are retired.',
      );
    }
    if (input.status !== 'active') {
      await this.assertNoActiveTargets(
        new Set(entitlements.map((entitlement) => entitlement.id)),
        'An application can be disabled or retired only after its active targets are disabled.',
      );
    }
    const { description: currentDescription, ...currentWithoutDescription } = current;
    const application = createApplicationCandidate({
      ...currentWithoutDescription,
      name: input.name,
      ...(input.description === undefined
        ? currentDescription === undefined
          ? {}
          : { description: currentDescription }
        : input.description === null
          ? {}
          : { description: input.description }),
      category: input.category,
      launchUrl: input.launchUrl,
      status: input.status,
      visibility: input.visibility,
      authentication: input.authentication,
      provisioningMode: input.provisioningMode,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.catalog.updateApplication(
      application,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.application.updated',
        topic: 'access-control.application.updated',
        targetType: 'application',
        targetId: application.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: application.revision,
        payload: { applicationKey: application.key, status: application.status },
      }),
      input.expectedRevision,
    );
    return application;
  }

  public async createEntitlement(
    input: CreateEntitlementInput,
    context: RequiredActorContext,
  ): Promise<ApplicationEntitlement> {
    const application = await this.requireApplication(input.applicationId);
    if (application.status === 'retired') {
      throw invalidConfigurationLifecycle(
        'A new entitlement cannot be added to a retired application.',
      );
    }
    if (input.requiresProvisioning && application.provisioningMode === 'none') {
      throw invalidConfigurationLifecycle(
        'A provisioning-required entitlement cannot belong to an application with mode none.',
      );
    }
    const now = this.runtime.now();
    const entitlement = createApplicationEntitlementCandidate({
      id: this.runtime.id('entitlement'),
      applicationId: input.applicationId,
      key: input.key,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      status: input.status ?? 'active',
      requiresProvisioning: input.requiresProvisioning,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.catalog.createApplicationEntitlement(
      entitlement,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.entitlement.created',
        topic: 'access-control.entitlement.created',
        targetType: 'application_entitlement',
        targetId: entitlement.id,
        action: 'create',
        resultingRevision: 1,
        payload: { applicationId: entitlement.applicationId, entitlementKey: entitlement.key },
      }),
    );
    return entitlement;
  }

  public async updateEntitlement(
    id: string,
    input: UpdateEntitlementInput,
    context: RequiredActorContext,
  ): Promise<ApplicationEntitlement> {
    const current = await this.requireEntitlement(id);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    const application = await this.requireApplication(current.applicationId);
    if (input.requiresProvisioning && application.provisioningMode === 'none') {
      throw invalidConfigurationLifecycle(
        'A provisioning-required entitlement cannot belong to an application with mode none.',
      );
    }
    if (application.status === 'retired' && input.status !== 'retired') {
      throw invalidConfigurationLifecycle(
        'Entitlements of a retired application must remain retired.',
      );
    }
    if (input.status !== 'active') {
      await this.assertNoActiveTargets(
        new Set([current.id]),
        'An entitlement can be disabled or retired only after its active targets are disabled.',
      );
    }
    const { description: currentDescription, ...currentWithoutDescription } = current;
    const entitlement = createApplicationEntitlementCandidate({
      ...currentWithoutDescription,
      name: input.name,
      ...(input.description === undefined
        ? currentDescription === undefined
          ? {}
          : { description: currentDescription }
        : input.description === null
          ? {}
          : { description: input.description }),
      status: input.status,
      requiresProvisioning: input.requiresProvisioning,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.catalog.updateApplicationEntitlement(
      entitlement,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.entitlement.updated',
        topic: 'access-control.entitlement.updated',
        targetType: 'application_entitlement',
        targetId: entitlement.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: entitlement.revision,
        payload: {
          applicationId: entitlement.applicationId,
          entitlementKey: entitlement.key,
          status: entitlement.status,
        },
      }),
      input.expectedRevision,
    );
    return entitlement;
  }

  public async createMapping(
    input: CreateMappingInput,
    context: RequiredActorContext,
  ): Promise<EntitlementMapping> {
    if ((await this.catalog.getSourceGroup(input.sourceGroupId)) === null) {
      throw new NotFoundError('Source group', input.sourceGroupId);
    }
    await this.requireEntitlements(input.entitlementIds);
    await this.requireProvisioningTargets(
      input.provisioningTargetIds ?? [],
      new Set(input.entitlementIds),
    );
    const now = this.runtime.now();
    const mapping = createEntitlementMappingCandidate({
      id: input.id ?? this.runtime.id('mapping'),
      sourceGroupId: input.sourceGroupId,
      entitlementIds: input.entitlementIds,
      provisioningTargetIds: input.provisioningTargetIds ?? [],
      status: 'draft',
      ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.catalog.createEntitlementMapping(
      mapping,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.mapping.created',
        topic: 'access-control.mapping.created',
        targetType: 'entitlement_mapping',
        targetId: mapping.id,
        action: 'create',
        resultingRevision: 1,
        payload: {
          sourceGroupId: mapping.sourceGroupId,
          entitlementIds: mapping.entitlementIds,
        },
      }),
    );
    return mapping;
  }

  public async previewMapping(id: string, expectedRevision: number): Promise<MappingPreview> {
    const calculatedAt = this.runtime.now();
    const snapshot = await this.loadGrantInputSnapshot(calculatedAt);
    const current = snapshot.mappings.find((mapping) => mapping.id === id);
    if (current === undefined) throw new NotFoundError('Entitlement mapping', id);
    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, current.revision);
    }
    const before = this.calculateGrants(snapshot, snapshot.mappings);
    const after = this.calculateGrants(
      snapshot,
      snapshot.mappings.map((mapping) =>
        mapping.id === current.id
          ? createEntitlementMappingCandidate({
              ...mapping,
              status: 'active',
              revision: mapping.revision + 1,
              updatedAt: calculatedAt,
            })
          : mapping,
      ),
    );
    return mappingPreviewSchema.parse({
      mappingId: current.id,
      expectedRevision,
      affectedSubjectIds: affectedGrantSubjectIds(before, after),
      grantCountBefore: before.length,
      grantCountAfter: after.length,
      calculatedAt,
    });
  }

  public async activateMapping(
    id: string,
    input: { expectedRevision: number; confirmedAffectedSubjectIds: string[] },
    context: RequiredActorContext,
  ): Promise<{ mapping: EntitlementMapping; preview: MappingPreview }> {
    const current = await this.requireMapping(id);
    const preview = await this.previewMapping(id, input.expectedRevision);
    const confirmed = [...new Set(input.confirmedAffectedSubjectIds)].sort();
    if (JSON.stringify(confirmed) !== JSON.stringify(preview.affectedSubjectIds)) {
      throw new AccessControlError(
        409,
        'mapping_preview_changed',
        'The affected Subjects changed after preview; review the new preview before activation.',
      );
    }
    const mapping = createEntitlementMappingCandidate({
      ...current,
      status: 'active',
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    const snapshot = await this.loadGrantInputSnapshot(preview.calculatedAt);
    const persisted = snapshot.mappings.find((candidate) => candidate.id === mapping.id);
    if (persisted === undefined) throw new NotFoundError('Entitlement mapping', mapping.id);
    if (persisted.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, persisted.revision);
    }
    const mappings = snapshot.mappings.map((candidate) =>
      candidate.id === mapping.id ? mapping : candidate,
    );
    const currentGrants = this.calculateGrants(snapshot, snapshot.mappings);
    const grants = this.calculateGrants(snapshot, mappings);
    if (
      JSON.stringify(affectedGrantSubjectIds(currentGrants, grants)) !==
        JSON.stringify(preview.affectedSubjectIds) ||
      currentGrants.length !== preview.grantCountBefore ||
      grants.length !== preview.grantCountAfter
    ) {
      throw new AccessControlError(
        409,
        'mapping_preview_changed',
        'The affected Subjects changed after preview; review the new preview before activation.',
      );
    }
    await this.catalog.activateEntitlementMapping(
      mapping,
      grants,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.mapping.activated',
        topic: 'access-control.mapping.activated',
        targetType: 'entitlement_mapping',
        targetId: mapping.id,
        action: 'activate',
        previousRevision: current.revision,
        resultingRevision: mapping.revision,
        payload: {
          affectedSubjectIds: preview.affectedSubjectIds,
          grantCountAfter: preview.grantCountAfter,
        },
      }),
      input.expectedRevision,
      snapshot.grantInputRevision,
    );
    return { mapping, preview };
  }

  public async retireMapping(
    id: string,
    input: { expectedRevision: number },
    context: RequiredActorContext,
  ): Promise<EntitlementMapping> {
    const current = await this.requireMapping(id);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, current.revision);
    }
    if (current.status === 'retired') {
      throw new AccessControlError(
        409,
        'mapping_already_retired',
        'The mapping is already retired.',
      );
    }
    const mapping = createEntitlementMappingCandidate({
      ...current,
      status: 'retired',
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    const snapshot = await this.loadGrantInputSnapshot(mapping.updatedAt);
    const persisted = snapshot.mappings.find((candidate) => candidate.id === mapping.id);
    if (persisted === undefined) throw new NotFoundError('Entitlement mapping', mapping.id);
    if (persisted.revision !== input.expectedRevision) {
      throw new RevisionConflictError(input.expectedRevision, persisted.revision);
    }
    const mappings = snapshot.mappings.map((candidate) =>
      candidate.id === mapping.id ? mapping : candidate,
    );
    const grants = this.calculateGrants(snapshot, mappings);
    await this.catalog.retireEntitlementMapping(
      mapping,
      grants,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.mapping.retired',
        topic: 'access-control.mapping.retired',
        targetType: 'entitlement_mapping',
        targetId: mapping.id,
        action: 'retire',
        previousRevision: current.revision,
        resultingRevision: mapping.revision,
        payload: { sourceGroupId: mapping.sourceGroupId },
      }),
      input.expectedRevision,
      snapshot.grantInputRevision,
    );
    return mapping;
  }

  private async loadGrantInputSnapshot(calculatedAt: string) {
    const beforeRevision = await this.catalog.getGrantInputRevision();
    const [
      subjects,
      externalIdentities,
      guestProfiles,
      sourceGroups,
      memberships,
      applications,
      entitlements,
      mappings,
    ] = await Promise.all([
      this.identities.listSubjects(),
      this.identities.listExternalIdentities(),
      this.identities.listGuestProfiles(),
      this.catalog.listSourceGroups(),
      this.catalog.listSourceGroupMemberships(),
      this.catalog.listApplications(),
      this.catalog.listApplicationEntitlements(),
      this.catalog.listEntitlementMappings(),
    ]);
    const grantInputRevision = await this.catalog.getGrantInputRevision();
    if (grantInputRevision !== beforeRevision) {
      throw new AccessControlError(
        409,
        'grant_inputs_changed',
        'Effective Grant inputs changed while they were being read; retry the operation.',
      );
    }
    return {
      grantInputRevision,
      subjects,
      externalIdentities,
      guestProfiles,
      sourceGroups,
      memberships,
      applications,
      entitlements,
      mappings,
      calculatedAt,
    };
  }

  private calculateGrants(
    snapshot: Awaited<ReturnType<CatalogService['loadGrantInputSnapshot']>>,
    mappings: EntitlementMapping[],
  ) {
    return calculateEffectiveGrants({ ...snapshot, mappings }).grants;
  }

  private async requireApplication(id: string): Promise<Application> {
    const application = await this.catalog.getApplication(id);
    if (application === null) throw new NotFoundError('Application', id);
    return application;
  }

  private async requireMapping(id: string): Promise<EntitlementMapping> {
    const mapping = await this.catalog.getEntitlementMapping(id);
    if (mapping === null) throw new NotFoundError('Entitlement mapping', id);
    return mapping;
  }

  private async requireEntitlements(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw new AccessControlError(
        422,
        'duplicate_entitlement',
        'A mapping cannot repeat an entitlement.',
      );
    }
    const entitlements = await Promise.all(
      uniqueIds.map((id) => this.catalog.getApplicationEntitlement(id)),
    );
    const missing = uniqueIds.filter((_, index) => entitlements[index] === null);
    if (missing.length > 0)
      throw new NotFoundError('Application entitlement', missing[0] ?? 'unknown');
    if (entitlements.some((entitlement) => entitlement?.status !== 'active')) {
      throw new AccessControlError(
        422,
        'inactive_entitlement',
        'Mappings require active entitlements.',
      );
    }
  }

  private async requireEntitlement(id: string): Promise<ApplicationEntitlement> {
    const entitlement = await this.catalog.getApplicationEntitlement(id);
    if (entitlement === null) throw new NotFoundError('Application entitlement', id);
    return entitlement;
  }

  private async requireProvisioningTargets(
    ids: string[],
    entitlementIds: ReadonlySet<string>,
  ): Promise<void> {
    if (ids.length === 0) return;
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw new AccessControlError(
        422,
        'duplicate_provisioning_target',
        'A mapping cannot repeat a Provisioning Target.',
      );
    }
    for (const id of uniqueIds) {
      const target = await this.provisioning.getProvisioningTarget(id);
      if (target === null) throw new NotFoundError('Provisioning Target', id);
      if (target.status !== 'active' || !entitlementIds.has(target.applicationEntitlementId)) {
        throw new AccessControlError(
          422,
          'invalid_mapping_target',
          'Mapping targets must be active and belong to one of the mapped entitlements.',
        );
      }
    }
  }

  private async assertNoActiveTargets(
    entitlementIds: ReadonlySet<string>,
    message: string,
  ): Promise<void> {
    const targets = await this.provisioning.listProvisioningTargets();
    if (
      targets.some(
        (target) =>
          target.status === 'active' && entitlementIds.has(target.applicationEntitlementId),
      )
    ) {
      throw invalidConfigurationLifecycle(message);
    }
  }
}

function affectedGrantSubjectIds(
  before: ReadonlyArray<{ subjectId: string; entitlementId: string }>,
  after: ReadonlyArray<{ subjectId: string; entitlementId: string }>,
): string[] {
  const beforeKeys = new Set(before.map((grant) => `${grant.subjectId}:${grant.entitlementId}`));
  const afterKeys = new Set(after.map((grant) => `${grant.subjectId}:${grant.entitlementId}`));
  const affectedSubjectIds = new Set<string>();
  for (const grant of before) {
    if (!afterKeys.has(`${grant.subjectId}:${grant.entitlementId}`)) {
      affectedSubjectIds.add(grant.subjectId);
    }
  }
  for (const grant of after) {
    if (!beforeKeys.has(`${grant.subjectId}:${grant.entitlementId}`)) {
      affectedSubjectIds.add(grant.subjectId);
    }
  }
  return [...affectedSubjectIds].sort();
}

function invalidConfigurationLifecycle(message: string): AccessControlError {
  return new AccessControlError(422, 'invalid_configuration_lifecycle', message);
}

export type RequiredActorContext = MutationContext & { actorSubjectId: string };
