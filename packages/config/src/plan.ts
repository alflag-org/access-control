import { z } from 'zod';
import {
  calculateEffectiveGrants,
  canonicalJson,
  jsonObjectSchema,
  type Application,
  type ApplicationEntitlement,
  type DirectorySource,
  type EntitlementMapping,
  type ExternalIdentity,
  type GuestProfile,
  type JsonObject,
  type OrganizationSettings,
  type ProviderConnection,
  type ProvisioningTarget,
  type SourceGroup,
  type SourceGroupMembership,
  type Subject,
} from '@access-control/domain';
import {
  configurationEnvironmentSchema,
  entitlementKey,
  type ConfigurationEnvironment,
  type MappingManifest,
  type RuntimeConfigurationManifest,
} from './schema';

const configurationPreviewSchema = z
  .object({
    affectedSubjectIds: z.array(z.string()),
    grantCountBefore: z.int().nonnegative(),
    grantCountAfter: z.int().nonnegative(),
    mappingExpectedRevision: z.int().positive(),
  })
  .strict();

export const configurationChangeSchema = z
  .object({
    action: z.string().regex(/^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*$/),
    targetType: z.string().regex(/^[a-z]+(?:_[a-z]+)*$/),
    stableKey: z.string().min(1).max(500),
    expectedRevision: z.int().positive().optional(),
    before: jsonObjectSchema.optional(),
    after: jsonObjectSchema.optional(),
    preview: configurationPreviewSchema.optional(),
  })
  .strict();

export const blockedConfigurationChangeSchema = configurationChangeSchema
  .extend({
    blockedCode: z.string().regex(/^[a-z][a-z0-9_]*$/),
    blockedReason: z.string().trim().min(1).max(500),
  })
  .strict();

export const configurationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: configurationEnvironmentSchema,
    generatedAt: z.iso.datetime({ offset: true }),
    changes: z.array(configurationChangeSchema),
    blockedChanges: z.array(blockedConfigurationChangeSchema),
    planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface RuntimeConfigurationSnapshot {
  organization: OrganizationSettings | null;
  directorySources: DirectorySource[];
  applications: Application[];
  entitlements: ApplicationEntitlement[];
  providerConnections: ProviderConnection[];
  provisioningTargets: ProvisioningTarget[];
  mappings: EntitlementMapping[];
  sourceGroups: SourceGroup[];
  sourceGroupMemberships: SourceGroupMembership[];
  subjects: Subject[];
  externalIdentities: ExternalIdentity[];
  guestProfiles: GuestProfile[];
}

export type ConfigurationChange = z.infer<typeof configurationChangeSchema>;
export type BlockedConfigurationChange = z.infer<typeof blockedConfigurationChangeSchema>;
export type ConfigurationPlan = z.infer<typeof configurationPlanSchema>;

export async function createConfigurationPlan(input: {
  environment: ConfigurationEnvironment;
  manifest: RuntimeConfigurationManifest;
  snapshot: RuntimeConfigurationSnapshot;
  generatedAt: string;
}): Promise<ConfigurationPlan> {
  const changes: ConfigurationChange[] = [];
  const blockedChanges: BlockedConfigurationChange[] = [];
  planOrganization(input.manifest, input.snapshot, changes, blockedChanges);
  planDirectorySources(input.manifest, input.snapshot, changes, blockedChanges);
  planApplications(input.manifest, input.snapshot, changes, blockedChanges);
  planProviderConnections(input.manifest, input.snapshot, changes, blockedChanges);
  planProvisioningTargets(input.manifest, input.snapshot, changes, blockedChanges);
  planMappings(input, changes, blockedChanges);

  if (changes.length > input.manifest.organization.maxPlanChanges) {
    blockedChanges.push({
      action: 'configuration.change-limit',
      targetType: 'configuration',
      stableKey: input.environment,
      after: {
        changeCount: changes.length,
        maxPlanChanges: input.manifest.organization.maxPlanChanges,
      },
      blockedCode: 'max_plan_changes_exceeded',
      blockedReason: 'The configuration plan exceeds organization.maxPlanChanges.',
    });
  }

  const sortedChanges = [...changes].sort(compareChanges);
  const sortedBlockedChanges = [...blockedChanges].sort(compareChanges);
  const hashInput = {
    schemaVersion: 1 as const,
    environment: input.environment,
    changes: sortedChanges,
    blockedChanges: sortedBlockedChanges,
  };
  const hashValue = jsonObjectSchema.parse(JSON.parse(JSON.stringify(hashInput)));
  const planHash = await sha256(canonicalJson(hashValue));
  return configurationPlanSchema.parse({
    ...hashInput,
    generatedAt: input.generatedAt,
    planHash,
  });
}

function planOrganization(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const desired = organizationValue(manifest);
  const current = snapshot.organization;
  if (current === null) {
    blocked.push(
      blockedChange('organization.update', 'organization_settings', 'organization', {
        after: desired,
        code: 'organization_settings_missing',
        reason: 'Organization Settings must be created by the administrator bootstrap workflow.',
      }),
    );
    return;
  }
  const before = organizationSnapshotValue(current);
  if (!same(before, desired)) {
    blocked.push(
      blockedChange('organization.update', 'organization_settings', current.id, {
        expectedRevision: current.revision,
        before,
        after: desired,
        code: 'administrator_required',
        reason: 'Organization Settings updates require an administrator.',
      }),
    );
  }
  void changes;
}

function planDirectorySources(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const current = new Map(snapshot.directorySources.map((source) => [source.id, source]));
  for (const desiredSource of manifest.directorySources) {
    const desired = directorySourceValue(desiredSource);
    const existing = current.get(desiredSource.id);
    if (existing === undefined) {
      if (desiredSource.status === 'retired') {
        blocked.push(
          blockedChange('directory-source.create', 'directory_source', desiredSource.id, {
            after: desired,
            code: 'retired_record_missing',
            reason: 'A retired Directory Source cannot be created as a new tombstone.',
          }),
        );
      } else {
        changes.push(
          change('directory-source.create', 'directory_source', desiredSource.id, {
            after: desired,
          }),
        );
      }
      continue;
    }
    const before = directorySourceSnapshotValue(existing);
    if (same(before, desired)) continue;
    const protectedChange =
      existing.customerId !== desiredSource.customerId ||
      existing.credentialRef !== desiredSource.credentialRef;
    const candidate = change('directory-source.update', 'directory_source', desiredSource.id, {
      expectedRevision: existing.revision,
      before,
      after: desired,
    });
    if (protectedChange) {
      blocked.push({
        ...candidate,
        blockedCode: 'protected_directory_source_change',
        blockedReason: 'Directory customerId and credentialRef changes require an administrator.',
      });
    } else changes.push(candidate);
  }
}

function planApplications(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const currentApplications = new Map(
    snapshot.applications.map((application) => [application.key, application]),
  );
  const currentApplicationKeys = new Map(
    snapshot.applications.map((application) => [application.id, application.key]),
  );
  const currentEntitlements = new Map(
    snapshot.entitlements.flatMap((entitlement) => {
      const applicationKey = currentApplicationKeys.get(entitlement.applicationId);
      return applicationKey === undefined
        ? []
        : [[entitlementKey(applicationKey, entitlement.key), entitlement] as const];
    }),
  );

  for (const application of manifest.applications) {
    const desired = applicationValue(application);
    const existing = currentApplications.get(application.key);
    if (existing === undefined) {
      if (application.status === 'retired') {
        blocked.push(
          blockedChange('application.create', 'application', application.key, {
            after: desired,
            code: 'retired_record_missing',
            reason: 'A retired Application cannot be created as a new tombstone.',
          }),
        );
      } else {
        const candidate = change('application.create', 'application', application.key, {
          after: desired,
        });
        if (application.provisioningMode === 'automatic') {
          blocked.push({
            ...candidate,
            blockedCode: 'automatic_mode_protected',
            blockedReason: 'Automatic application mode requires an administrator.',
          });
        } else changes.push(candidate);
      }
    } else {
      const before = applicationSnapshotValue(existing);
      if (!same(before, desired)) {
        const candidate = change('application.update', 'application', application.key, {
          expectedRevision: existing.revision,
          before,
          after: desired,
        });
        if (
          existing.provisioningMode !== 'automatic' &&
          application.provisioningMode === 'automatic'
        ) {
          blocked.push({
            ...candidate,
            blockedCode: 'automatic_mode_protected',
            blockedReason: 'Automatic application mode changes require an administrator.',
          });
        } else changes.push(candidate);
      }
    }

    for (const entitlement of application.entitlements) {
      const stableKey = entitlementKey(application.key, entitlement.key);
      const desiredEntitlement = entitlementValue(entitlement);
      const existingEntitlement = currentEntitlements.get(stableKey);
      if (existingEntitlement === undefined) {
        if (entitlement.status === 'retired') {
          blocked.push(
            blockedChange('entitlement.create', 'application_entitlement', stableKey, {
              after: desiredEntitlement,
              code: 'retired_record_missing',
              reason: 'A retired Application Entitlement cannot be created as a new tombstone.',
            }),
          );
        } else {
          changes.push(
            change('entitlement.create', 'application_entitlement', stableKey, {
              after: desiredEntitlement,
            }),
          );
        }
      } else {
        const before = entitlementSnapshotValue(existingEntitlement);
        if (!same(before, desiredEntitlement)) {
          changes.push(
            change('entitlement.update', 'application_entitlement', stableKey, {
              expectedRevision: existingEntitlement.revision,
              before,
              after: desiredEntitlement,
            }),
          );
        }
      }
    }
  }
}

function planProviderConnections(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const current = new Map(
    snapshot.providerConnections.map((connection) => [connection.id, connection]),
  );
  for (const connection of manifest.providerConnections) {
    const desired = providerConnectionValue(connection);
    const existing = current.get(connection.id);
    if (existing === undefined) {
      const candidate = change('provider-connection.create', 'provider_connection', connection.id, {
        after: desired,
      });
      if (connection.status === 'retired') {
        blocked.push({
          ...candidate,
          blockedCode: 'retired_record_missing',
          blockedReason: 'A retired Provider Connection cannot be created as a new tombstone.',
        });
      } else if (connection.mode === 'automatic') {
        blocked.push({
          ...candidate,
          blockedCode: 'automatic_mode_protected',
          blockedReason: 'Automatic Provider Connection mode requires an administrator.',
        });
      } else changes.push(candidate);
      continue;
    }
    if (existing.provider !== connection.provider) {
      blocked.push(
        blockedChange('provider-connection.update', 'provider_connection', connection.id, {
          expectedRevision: existing.revision,
          before: providerConnectionSnapshotValue(existing),
          after: desired,
          code: 'immutable_provider_change',
          reason: 'ProviderConnection.provider is immutable; retire it and create a new record.',
        }),
      );
      continue;
    }
    const before = providerConnectionSnapshotValue(existing);
    if (same(before, desired)) continue;
    const candidate = change('provider-connection.update', 'provider_connection', connection.id, {
      expectedRevision: existing.revision,
      before,
      after: desired,
    });
    if (
      existing.credentialRef !== connection.credentialRef ||
      (existing.mode !== 'automatic' && connection.mode === 'automatic')
    ) {
      blocked.push({
        ...candidate,
        blockedCode: 'protected_provider_connection_change',
        blockedReason: 'Credential reference and automatic mode changes require an administrator.',
      });
    } else changes.push(candidate);
  }
}

function planProvisioningTargets(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const current = new Map(snapshot.provisioningTargets.map((target) => [target.id, target]));
  const logicalEntitlements = logicalEntitlementIds(snapshot);
  for (const target of manifest.provisioningTargets) {
    const desired = provisioningTargetValue(target);
    const existing = current.get(target.id);
    if (existing === undefined) {
      const candidate = change('provisioning-target.create', 'provisioning_target', target.id, {
        after: desired,
      });
      if (target.status === 'retired') {
        blocked.push({
          ...candidate,
          blockedCode: 'retired_record_missing',
          blockedReason: 'A retired Provisioning Target cannot be created as a new tombstone.',
        });
      } else if (target.mode === 'automatic') {
        blocked.push({
          ...candidate,
          blockedCode: 'automatic_mode_protected',
          blockedReason: 'Automatic Provisioning Target mode requires an administrator.',
        });
      } else changes.push(candidate);
      continue;
    }
    const currentLogicalEntitlement = logicalEntitlements.get(existing.applicationEntitlementId);
    const immutableChanged =
      existing.providerConnectionId !== target.providerConnectionId ||
      existing.targetType !== target.targetType ||
      existing.providerTargetId !== target.providerTargetId;
    const before = provisioningTargetSnapshotValue(existing, currentLogicalEntitlement);
    if (immutableChanged) {
      blocked.push(
        blockedChange('provisioning-target.update', 'provisioning_target', target.id, {
          expectedRevision: existing.revision,
          before,
          after: desired,
          code: 'immutable_target_change',
          reason:
            'Provisioning Target identity fields are immutable; retire it and create a new record.',
        }),
      );
      continue;
    }
    if (same(before, desired)) continue;
    const candidate = change('provisioning-target.update', 'provisioning_target', target.id, {
      expectedRevision: existing.revision,
      before,
      after: desired,
    });
    if (
      (existing.protected && !target.protected) ||
      (existing.mode !== 'automatic' && target.mode === 'automatic')
    ) {
      blocked.push({
        ...candidate,
        blockedCode: 'protected_provisioning_target_change',
        blockedReason:
          'Protected flag removal and automatic mode changes require an administrator.',
      });
    } else changes.push(candidate);
  }
}

function planMappings(
  input: {
    environment: ConfigurationEnvironment;
    manifest: RuntimeConfigurationManifest;
    snapshot: RuntimeConfigurationSnapshot;
    generatedAt: string;
  },
  changes: ConfigurationChange[],
  blocked: BlockedConfigurationChange[],
): void {
  const desiredById = new Map(input.manifest.mappings.map((mapping) => [mapping.id, mapping]));
  const currentById = new Map(input.snapshot.mappings.map((mapping) => [mapping.id, mapping]));
  const retireIntentIds = new Set(
    input.snapshot.mappings
      .filter(
        (mapping) =>
          mapping.status !== 'retired' &&
          (!desiredById.has(mapping.id) || desiredById.get(mapping.id)?.status === 'retired'),
      )
      .map((mapping) => mapping.id),
  );
  const bulkRetire = retireIntentIds.size > 1;
  const retireCandidates = input.snapshot.mappings.filter(
    (mapping) => mapping.status !== 'retired' && !desiredById.has(mapping.id),
  );
  for (const mapping of retireCandidates) {
    const candidate = change('mapping.retire', 'entitlement_mapping', mapping.id, {
      expectedRevision: mapping.revision,
      before: mappingSnapshotValue(mapping, input.snapshot),
      after: { status: 'retired' },
    });
    if (bulkRetire) {
      blocked.push({
        ...candidate,
        blockedCode: 'bulk_retire_protected',
        blockedReason:
          'Retiring more than one mapping in a plan requires individual administrator review.',
      });
    } else changes.push(candidate);
  }

  const activations: Array<{ manifest: MappingManifest; mapping: EntitlementMapping }> = [];
  const projected = projectedCatalog(input.manifest, input.snapshot, input.generatedAt);
  const workingMappings = input.snapshot.mappings.map((mapping) =>
    retireIntentIds.has(mapping.id) && !bulkRetire
      ? { ...mapping, status: 'retired' as const }
      : mapping,
  );

  for (const mappingManifest of [...input.manifest.mappings].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    const sourceGroup = input.snapshot.sourceGroups.find(
      (group) => group.providerGroupId === mappingManifest.sourceGroup.providerGroupId,
    );
    const current = currentById.get(mappingManifest.id);
    const desiredMapping = projectedMapping(
      mappingManifest,
      sourceGroup,
      projected.entitlementIds,
      input.generatedAt,
      current,
    );
    if (mappingManifest.status === 'retired') {
      if (current !== undefined && current.status !== 'retired') {
        const candidate = change('mapping.retire', 'entitlement_mapping', mappingManifest.id, {
          expectedRevision: current.revision,
          before: mappingSnapshotValue(current, input.snapshot),
          after: { status: 'retired' },
        });
        if (bulkRetire) {
          blocked.push({
            ...candidate,
            blockedCode: 'bulk_retire_protected',
            blockedReason:
              'Retiring more than one mapping in a plan requires individual administrator review.',
          });
        } else changes.push(candidate);
      }
      continue;
    }
    if (current?.status === 'retired') {
      blocked.push(
        blockedChange('mapping.activate', 'entitlement_mapping', mappingManifest.id, {
          expectedRevision: current.revision,
          before: mappingSnapshotValue(current, input.snapshot),
          after: mappingManifestValue(mappingManifest),
          code: 'mapping_id_retired',
          reason: 'A retired mapping identifier cannot be reused; create a mapping with a new ID.',
        }),
      );
      continue;
    }
    if (sourceGroup === undefined || sourceGroup.status !== 'active') {
      blocked.push(
        blockedChange('mapping.activate', 'entitlement_mapping', mappingManifest.id, {
          ...(current === undefined ? {} : { expectedRevision: current.revision }),
          after: mappingManifestValue(mappingManifest),
          code: 'source_group_not_observed',
          reason:
            'The Google immutable group ID has not been observed in a complete Directory snapshot.',
        }),
      );
      continue;
    }
    if (
      sourceGroup.email.toLowerCase() !== mappingManifest.sourceGroup.expectedEmail.toLowerCase()
    ) {
      blocked.push(
        blockedChange('mapping.activate', 'entitlement_mapping', mappingManifest.id, {
          ...(current === undefined ? {} : { expectedRevision: current.revision }),
          after: mappingManifestValue(mappingManifest),
          code: 'source_group_email_mismatch',
          reason: 'The observed Source Group email does not match expectedEmail metadata.',
        }),
      );
      continue;
    }
    if (desiredMapping === null) {
      blocked.push(
        blockedChange('mapping.create', 'entitlement_mapping', mappingManifest.id, {
          after: mappingManifestValue(mappingManifest),
          code: 'mapping_reference_unresolved',
          reason: 'Mapping references cannot be resolved against the projected catalog.',
        }),
      );
      continue;
    }
    if (current === undefined) {
      changes.push(
        change('mapping.create', 'entitlement_mapping', mappingManifest.id, {
          after: mappingManifestValue(mappingManifest),
        }),
      );
      workingMappings.push(desiredMapping);
      activations.push({ manifest: mappingManifest, mapping: desiredMapping });
      continue;
    }
    const currentValue = mappingSnapshotValue(current, input.snapshot);
    const desiredValue = mappingManifestValue(mappingManifest);
    const comparableCurrent = { ...currentValue, status: mappingManifest.status };
    if (!same(comparableCurrent, desiredValue)) {
      blocked.push(
        blockedChange('mapping.retire', 'entitlement_mapping', mappingManifest.id, {
          expectedRevision: current.revision,
          before: currentValue,
          after: desiredValue,
          code:
            current.status === 'active'
              ? 'active_mapping_content_change'
              : 'mapping_content_immutable',
          reason:
            'Mapping content is immutable; retire this mapping and declare the replacement with a new ID.',
        }),
      );
      continue;
    }
    if (current.status === 'draft')
      activations.push({ manifest: mappingManifest, mapping: current });
  }

  for (const activation of activations) {
    const currentIndex = workingMappings.findIndex(
      (mapping) => mapping.id === activation.mapping.id,
    );
    const beforeGrants = calculateProjectedGrants(
      input.snapshot,
      projected,
      workingMappings,
      input.generatedAt,
    );
    const activeMapping: EntitlementMapping = {
      ...activation.mapping,
      status: 'active',
      revision: activation.mapping.revision + 1,
      updatedAt: input.generatedAt,
    };
    if (currentIndex === -1) workingMappings.push(activeMapping);
    else workingMappings[currentIndex] = activeMapping;
    const afterGrants = calculateProjectedGrants(
      input.snapshot,
      projected,
      workingMappings,
      input.generatedAt,
    );
    const preview = previewValue(
      beforeGrants.map((grant) => ({
        subjectId: grant.subjectId,
        entitlementId: grant.entitlementId,
      })),
      afterGrants.map((grant) => ({
        subjectId: grant.subjectId,
        entitlementId: grant.entitlementId,
      })),
      activation.mapping.revision,
    );
    changes.push(
      change('mapping.preview', 'entitlement_mapping', activation.mapping.id, {
        expectedRevision: activation.mapping.revision,
        preview,
      }),
    );
    changes.push(
      change('mapping.activate', 'entitlement_mapping', activation.mapping.id, {
        expectedRevision: activation.mapping.revision,
        after: mappingManifestValue(activation.manifest),
        preview,
      }),
    );
  }
}

function projectedCatalog(
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  now: string,
): {
  applications: Application[];
  entitlements: ApplicationEntitlement[];
  entitlementIds: Map<string, string>;
} {
  const currentApplications = new Map(
    snapshot.applications.map((application) => [application.key, application]),
  );
  const currentApplicationKeys = new Map(
    snapshot.applications.map((application) => [application.id, application.key]),
  );
  const currentEntitlements = new Map(
    snapshot.entitlements.flatMap((entitlement) => {
      const applicationKey = currentApplicationKeys.get(entitlement.applicationId);
      return applicationKey === undefined
        ? []
        : [[entitlementKey(applicationKey, entitlement.key), entitlement] as const];
    }),
  );
  const applications: Application[] = [];
  const entitlements: ApplicationEntitlement[] = [];
  const entitlementIds = new Map<string, string>();
  for (const application of manifest.applications) {
    const current = currentApplications.get(application.key);
    const applicationId = current?.id ?? `planned:application:${application.key}`;
    applications.push({
      id: applicationId,
      key: application.key,
      name: application.name,
      ...(application.description === undefined ? {} : { description: application.description }),
      category: application.category,
      launchUrl: application.launchUrl,
      status: application.status,
      visibility: application.visibility,
      authentication: application.authentication,
      provisioningMode: application.provisioningMode,
      revision: current?.revision ?? 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      createdBy: current?.createdBy ?? 'planned:configuration',
      updatedBy: 'planned:configuration',
    });
    for (const entitlement of application.entitlements) {
      const logicalKey = entitlementKey(application.key, entitlement.key);
      const currentEntitlement = currentEntitlements.get(logicalKey);
      const id =
        currentEntitlement?.id ?? `planned:entitlement:${application.key}:${entitlement.key}`;
      entitlementIds.set(logicalKey, id);
      entitlements.push({
        id,
        applicationId,
        key: entitlement.key,
        name: entitlement.name,
        ...(entitlement.description === undefined ? {} : { description: entitlement.description }),
        status: entitlement.status,
        requiresProvisioning: entitlement.requiresProvisioning,
        revision: currentEntitlement?.revision ?? 1,
        createdAt: currentEntitlement?.createdAt ?? now,
        updatedAt: now,
        createdBy: currentEntitlement?.createdBy ?? 'planned:configuration',
        updatedBy: 'planned:configuration',
      });
    }
  }
  return { applications, entitlements, entitlementIds };
}

function projectedMapping(
  manifest: MappingManifest,
  sourceGroup: SourceGroup | undefined,
  entitlementIds: Map<string, string>,
  now: string,
  current: EntitlementMapping | undefined,
): EntitlementMapping | null {
  if (sourceGroup === undefined) return null;
  const resolvedEntitlements = manifest.entitlements.map((reference) =>
    entitlementIds.get(entitlementKey(reference.applicationKey, reference.entitlementKey)),
  );
  if (resolvedEntitlements.some((id) => id === undefined)) return null;
  return {
    id: manifest.id,
    sourceGroupId: sourceGroup.id,
    entitlementIds: (resolvedEntitlements as string[]).sort(compareText),
    provisioningTargetIds: [...manifest.provisioningTargetIds].sort(compareText),
    status: current?.status ?? 'draft',
    ...(manifest.validFrom === undefined ? {} : { validFrom: manifest.validFrom }),
    ...(manifest.validUntil === undefined ? {} : { validUntil: manifest.validUntil }),
    revision: current?.revision ?? 1,
    createdAt: current?.createdAt ?? now,
    updatedAt: current?.updatedAt ?? now,
    createdBy: current?.createdBy ?? 'planned:configuration',
    updatedBy: current?.updatedBy ?? 'planned:configuration',
  };
}

function calculateProjectedGrants(
  snapshot: RuntimeConfigurationSnapshot,
  projected: ReturnType<typeof projectedCatalog>,
  mappings: EntitlementMapping[],
  calculatedAt: string,
) {
  return calculateEffectiveGrants({
    subjects: snapshot.subjects,
    externalIdentities: snapshot.externalIdentities,
    guestProfiles: snapshot.guestProfiles,
    sourceGroups: snapshot.sourceGroups,
    memberships: snapshot.sourceGroupMemberships,
    mappings,
    applications: projected.applications,
    entitlements: projected.entitlements,
    calculatedAt,
  }).grants;
}

function previewValue(
  before: Array<{ subjectId: string; entitlementId: string }>,
  after: Array<{ subjectId: string; entitlementId: string }>,
  mappingExpectedRevision: number,
): z.infer<typeof configurationPreviewSchema> {
  const beforeKeys = new Set(before.map((grant) => `${grant.subjectId}:${grant.entitlementId}`));
  const afterKeys = new Set(after.map((grant) => `${grant.subjectId}:${grant.entitlementId}`));
  const affected = new Set<string>();
  for (const grant of before)
    if (!afterKeys.has(`${grant.subjectId}:${grant.entitlementId}`)) affected.add(grant.subjectId);
  for (const grant of after)
    if (!beforeKeys.has(`${grant.subjectId}:${grant.entitlementId}`)) affected.add(grant.subjectId);
  return {
    affectedSubjectIds: [...affected].sort(compareText),
    grantCountBefore: before.length,
    grantCountAfter: after.length,
    mappingExpectedRevision,
  };
}

function logicalEntitlementIds(snapshot: RuntimeConfigurationSnapshot): Map<string, string> {
  const applicationKeys = new Map(
    snapshot.applications.map((application) => [application.id, application.key]),
  );
  return new Map(
    snapshot.entitlements.flatMap((entitlement) => {
      const applicationKey = applicationKeys.get(entitlement.applicationId);
      return applicationKey === undefined
        ? []
        : [[entitlement.id, entitlementKey(applicationKey, entitlement.key)] as const];
    }),
  );
}

function mappingSnapshotValue(
  mapping: EntitlementMapping,
  snapshot: RuntimeConfigurationSnapshot,
): JsonObject {
  const groups = new Map(snapshot.sourceGroups.map((group) => [group.id, group]));
  const logicalEntitlements = logicalEntitlementIds(snapshot);
  const group = groups.get(mapping.sourceGroupId);
  return {
    sourceGroup: {
      providerGroupId: group?.providerGroupId ?? `unresolved:${mapping.sourceGroupId}`,
      expectedEmail: group?.email ?? 'unresolved@example.invalid',
    },
    entitlements: mapping.entitlementIds.map((id) => {
      const logical = logicalEntitlements.get(id);
      const separator = logical?.indexOf(':') ?? -1;
      return separator < 1
        ? { applicationKey: 'unresolved', entitlementKey: id }
        : {
            applicationKey: logical!.slice(0, separator),
            entitlementKey: logical!.slice(separator + 1),
          };
    }),
    provisioningTargetIds: [...mapping.provisioningTargetIds],
    status: mapping.status,
    validFrom: mapping.validFrom ?? null,
    validUntil: mapping.validUntil ?? null,
  };
}

function organizationValue(manifest: RuntimeConfigurationManifest): JsonObject {
  return {
    organizationName: manifest.organization.name,
    title: manifest.organization.title,
    supportUrl: manifest.organization.supportUrl ?? null,
    brandMarkUrl: manifest.organization.brandMarkUrl ?? null,
    maxPlanChanges: manifest.organization.maxPlanChanges,
  };
}

function organizationSnapshotValue(value: OrganizationSettings): JsonObject {
  return {
    organizationName: value.organizationName,
    title: value.title,
    supportUrl: value.supportUrl ?? null,
    brandMarkUrl: value.brandMarkUrl ?? null,
    maxPlanChanges: value.maxPlanChanges,
  };
}

function directorySourceValue(
  value: RuntimeConfigurationManifest['directorySources'][number],
): JsonObject {
  return { ...value };
}

function directorySourceSnapshotValue(value: DirectorySource): JsonObject {
  return {
    id: value.id,
    provider: value.provider,
    customerId: value.customerId,
    delegatedAdmin: value.delegatedAdmin,
    credentialRef: value.credentialRef,
    accessGroupPrefix: value.accessGroupPrefix,
    status: value.status,
  };
}

function applicationValue(value: RuntimeConfigurationManifest['applications'][number]): JsonObject {
  return {
    key: value.key,
    name: value.name,
    description: value.description ?? null,
    category: value.category,
    launchUrl: value.launchUrl,
    visibility: value.visibility,
    authentication: authenticationValue(value.authentication),
    provisioningMode: value.provisioningMode,
    status: value.status,
  };
}

function applicationSnapshotValue(value: Application): JsonObject {
  return {
    key: value.key,
    name: value.name,
    description: value.description ?? null,
    category: value.category,
    launchUrl: value.launchUrl,
    visibility: value.visibility,
    authentication: authenticationValue(value.authentication),
    provisioningMode: value.provisioningMode,
    status: value.status,
  };
}

function entitlementValue(
  value: RuntimeConfigurationManifest['applications'][number]['entitlements'][number],
): JsonObject {
  return {
    key: value.key,
    name: value.name,
    description: value.description ?? null,
    requiresProvisioning: value.requiresProvisioning,
    status: value.status,
  };
}

function entitlementSnapshotValue(value: ApplicationEntitlement): JsonObject {
  return {
    key: value.key,
    name: value.name,
    description: value.description ?? null,
    requiresProvisioning: value.requiresProvisioning,
    status: value.status,
  };
}

function providerConnectionValue(
  value: RuntimeConfigurationManifest['providerConnections'][number],
): JsonObject {
  return {
    id: value.id,
    provider: value.provider,
    name: value.name,
    mode: value.mode,
    credentialRef: value.credentialRef ?? null,
    configuration: value.configuration,
    status: value.status,
  };
}

function providerConnectionSnapshotValue(value: ProviderConnection): JsonObject {
  return {
    id: value.id,
    provider: value.provider,
    name: value.name,
    mode: value.mode,
    credentialRef: value.credentialRef ?? null,
    configuration: value.configuration,
    status: value.status,
  };
}

function provisioningTargetValue(
  value: RuntimeConfigurationManifest['provisioningTargets'][number],
): JsonObject {
  return {
    id: value.id,
    providerConnectionId: value.providerConnectionId,
    applicationKey: value.applicationKey,
    entitlementKey: value.entitlementKey,
    targetType: value.targetType,
    providerTargetId: value.providerTargetId,
    mode: value.mode,
    protected: value.protected,
    configuration: value.configuration,
    status: value.status,
  };
}

function provisioningTargetSnapshotValue(
  value: ProvisioningTarget,
  logicalEntitlement: string | undefined,
): JsonObject {
  const separator = logicalEntitlement?.indexOf(':') ?? -1;
  return {
    id: value.id,
    providerConnectionId: value.providerConnectionId,
    applicationKey: separator < 1 ? 'unresolved' : logicalEntitlement!.slice(0, separator),
    entitlementKey:
      separator < 1 ? value.applicationEntitlementId : logicalEntitlement!.slice(separator + 1),
    targetType: value.targetType,
    providerTargetId: value.providerTargetId,
    mode: value.mode,
    protected: value.protected,
    configuration: value.configuration,
    status: value.status,
  };
}

function mappingManifestValue(value: MappingManifest): JsonObject {
  return {
    sourceGroup: value.sourceGroup,
    entitlements: [...value.entitlements].sort((left, right) =>
      compareText(
        entitlementKey(left.applicationKey, left.entitlementKey),
        entitlementKey(right.applicationKey, right.entitlementKey),
      ),
    ),
    provisioningTargetIds: [...value.provisioningTargetIds].sort(compareText),
    status: value.status,
    validFrom: value.validFrom ?? null,
    validUntil: value.validUntil ?? null,
  };
}

function authenticationValue(value: Application['authentication']): JsonObject {
  return {
    type: value.type,
    ...(value.reference === undefined ? {} : { reference: value.reference }),
  };
}

function change(
  action: string,
  targetType: string,
  stableKey: string,
  values: Omit<ConfigurationChange, 'action' | 'stableKey' | 'targetType'>,
): ConfigurationChange {
  return configurationChangeSchema.parse({ action, targetType, stableKey, ...values });
}

function blockedChange(
  action: string,
  targetType: string,
  stableKey: string,
  values: Omit<ConfigurationChange, 'action' | 'stableKey' | 'targetType'> & {
    code: string;
    reason: string;
  },
): BlockedConfigurationChange {
  const { code, reason, ...changeValues } = values;
  return blockedConfigurationChangeSchema.parse({
    action,
    targetType,
    stableKey,
    ...changeValues,
    blockedCode: code,
    blockedReason: reason,
  });
}

function compareChanges(
  left: Pick<ConfigurationChange, 'action' | 'stableKey' | 'targetType'>,
  right: Pick<ConfigurationChange, 'action' | 'stableKey' | 'targetType'>,
): number {
  return (
    compareText(left.action, right.action) ||
    compareText(left.targetType, right.targetType) ||
    compareText(left.stableKey, right.stableKey)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function same(left: JsonObject, right: JsonObject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
