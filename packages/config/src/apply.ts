import { z } from 'zod';
import {
  canonicalJson,
  jsonObjectSchema,
  mappingPreviewSchema,
  type JsonObject,
} from '@access-control/domain';
import type { ConfigurationApi } from './client';
import { parseMappingPreviewResponse } from './client';
import {
  createConfigurationPlan,
  type ConfigurationChange,
  type ConfigurationPlan,
  type RuntimeConfigurationSnapshot,
} from './plan';
import {
  entitlementKey,
  type ConfigurationEnvironment,
  type RuntimeConfigurationManifest,
} from './schema';

export class ConfigurationApplyError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigurationApplyError';
  }
}

export async function applyRuntimeConfiguration(input: {
  environment: ConfigurationEnvironment;
  manifest: RuntimeConfigurationManifest;
  client: ConfigurationApi;
  planHash: string;
  now?: () => string;
}): Promise<ConfigurationPlan> {
  const now = input.now ?? (() => new Date().toISOString());
  let snapshot = await input.client.loadSnapshot();
  const initialPlan = await createConfigurationPlan({
    environment: input.environment,
    manifest: input.manifest,
    snapshot,
    generatedAt: now(),
  });
  if (initialPlan.planHash !== input.planHash) {
    throw new ConfigurationApplyError(
      'plan_hash_mismatch',
      `Current plan hash ${initialPlan.planHash} does not match the requested plan hash.`,
    );
  }
  if (initialPlan.blockedChanges.length > 0) {
    const codes = [
      ...new Set(initialPlan.blockedChanges.map((change) => change.blockedCode)),
    ].sort();
    throw new ConfigurationApplyError(
      'blocked_changes_present',
      `Configuration apply is blocked by: ${codes.join(', ')}.`,
    );
  }

  for (const configurationChange of [...initialPlan.changes].sort(compareApplyOrder)) {
    await applyChange(input.client, input.manifest, snapshot, configurationChange, input.planHash);
    if (configurationChange.action === 'mapping.preview') continue;
    snapshot = await input.client.loadSnapshot();
    const verificationPlan = await createConfigurationPlan({
      environment: input.environment,
      manifest: input.manifest,
      snapshot,
      generatedAt: now(),
    });
    const unapplied = [...verificationPlan.changes, ...verificationPlan.blockedChanges].some(
      (candidate) =>
        candidate.action === configurationChange.action &&
        candidate.stableKey === configurationChange.stableKey,
    );
    if (unapplied) {
      throw new ConfigurationApplyError(
        'change_verification_failed',
        `${configurationChange.action} ${configurationChange.stableKey} remained after apply.`,
      );
    }
  }

  snapshot = await input.client.loadSnapshot();
  const finalPlan = await createConfigurationPlan({
    environment: input.environment,
    manifest: input.manifest,
    snapshot,
    generatedAt: now(),
  });
  if (finalPlan.changes.length > 0 || finalPlan.blockedChanges.length > 0) {
    throw new ConfigurationApplyError(
      'configuration_not_converged',
      `Configuration did not converge; ${finalPlan.changes.length} changes and ${finalPlan.blockedChanges.length} blocked changes remain.`,
    );
  }
  return finalPlan;
}

async function applyChange(
  client: ConfigurationApi,
  manifest: RuntimeConfigurationManifest,
  snapshot: RuntimeConfigurationSnapshot,
  change: ConfigurationChange,
  planHash: string,
): Promise<void> {
  const applicationByKey = new Map(
    snapshot.applications.map((application) => [application.key, application]),
  );
  const applicationKeyById = new Map(
    snapshot.applications.map((application) => [application.id, application.key]),
  );
  const entitlementByKey = new Map(
    snapshot.entitlements.flatMap((entitlement) => {
      const applicationKey = applicationKeyById.get(entitlement.applicationId);
      return applicationKey === undefined
        ? []
        : [[entitlementKey(applicationKey, entitlement.key), entitlement] as const];
    }),
  );

  switch (change.action) {
    case 'directory-source.create': {
      const source = required(
        manifest.directorySources.find((value) => value.id === change.stableKey),
        change,
      );
      await client.create('/api/v1/directory-sources', jsonObjectSchema.parse(source), planHash);
      return;
    }
    case 'directory-source.update': {
      const source = required(
        manifest.directorySources.find((value) => value.id === change.stableKey),
        change,
      );
      await client.update(
        `/api/v1/directory-sources/${encodeURIComponent(source.id)}`,
        {
          customerId: source.customerId,
          delegatedAdmin: source.delegatedAdmin,
          credentialRef: source.credentialRef,
          accessGroupPrefix: source.accessGroupPrefix,
          status: source.status,
          expectedRevision: requiredRevision(change),
        },
        planHash,
      );
      return;
    }
    case 'application.create': {
      const application = required(
        manifest.applications.find((value) => value.key === change.stableKey),
        change,
      );
      await client.create('/api/v1/applications', applicationCreateBody(application), planHash);
      return;
    }
    case 'application.update': {
      const application = required(
        manifest.applications.find((value) => value.key === change.stableKey),
        change,
      );
      const current = required(applicationByKey.get(application.key), change);
      await client.update(
        `/api/v1/applications/${encodeURIComponent(current.id)}`,
        { ...applicationUpdateBody(application), expectedRevision: requiredRevision(change) },
        planHash,
      );
      return;
    }
    case 'entitlement.create': {
      const desired = requiredEntitlement(manifest, change.stableKey);
      const application = required(applicationByKey.get(desired.application.key), change);
      await client.create(
        `/api/v1/applications/${encodeURIComponent(application.id)}/entitlements`,
        entitlementCreateBody(desired.entitlement),
        planHash,
      );
      return;
    }
    case 'entitlement.update': {
      const desired = requiredEntitlement(manifest, change.stableKey);
      const application = required(applicationByKey.get(desired.application.key), change);
      const current = required(entitlementByKey.get(change.stableKey), change);
      await client.update(
        `/api/v1/applications/${encodeURIComponent(application.id)}/entitlements/${encodeURIComponent(current.id)}`,
        {
          ...entitlementUpdateBody(desired.entitlement),
          expectedRevision: requiredRevision(change),
        },
        planHash,
      );
      return;
    }
    case 'provider-connection.create': {
      const connection = required(
        manifest.providerConnections.find((value) => value.id === change.stableKey),
        change,
      );
      await client.create(
        '/api/v1/provider-connections',
        providerConnectionCreateBody(connection),
        planHash,
      );
      return;
    }
    case 'provider-connection.update': {
      const connection = required(
        manifest.providerConnections.find((value) => value.id === change.stableKey),
        change,
      );
      await client.update(
        `/api/v1/provider-connections/${encodeURIComponent(connection.id)}`,
        {
          ...providerConnectionUpdateBody(connection),
          expectedRevision: requiredRevision(change),
        },
        planHash,
      );
      return;
    }
    case 'provisioning-target.create':
    case 'provisioning-target.update': {
      const target = required(
        manifest.provisioningTargets.find((value) => value.id === change.stableKey),
        change,
      );
      const entitlement = required(
        entitlementByKey.get(entitlementKey(target.applicationKey, target.entitlementKey)),
        change,
      );
      const body: JsonObject = {
        applicationEntitlementId: entitlement.id,
        mode: target.mode,
        protected: target.protected,
        configuration: target.configuration,
        status: target.status,
      };
      if (change.action === 'provisioning-target.create') {
        await client.create(
          '/api/v1/provisioning-targets',
          {
            id: target.id,
            providerConnectionId: target.providerConnectionId,
            targetType: target.targetType,
            providerTargetId: target.providerTargetId,
            ...body,
          },
          planHash,
        );
      } else {
        await client.update(
          `/api/v1/provisioning-targets/${encodeURIComponent(target.id)}`,
          { ...body, expectedRevision: requiredRevision(change) },
          planHash,
        );
      }
      return;
    }
    case 'mapping.create': {
      const mapping = required(
        manifest.mappings.find((value) => value.id === change.stableKey),
        change,
      );
      const sourceGroup = required(
        snapshot.sourceGroups.find(
          (group) => group.providerGroupId === mapping.sourceGroup.providerGroupId,
        ),
        change,
      );
      const entitlementIds = mapping.entitlements.map(
        (reference) =>
          required(
            entitlementByKey.get(
              entitlementKey(reference.applicationKey, reference.entitlementKey),
            ),
            change,
          ).id,
      );
      await client.create(
        '/api/v1/mappings',
        {
          id: mapping.id,
          sourceGroupId: sourceGroup.id,
          entitlementIds,
          provisioningTargetIds: mapping.provisioningTargetIds,
          ...(mapping.validFrom === undefined ? {} : { validFrom: mapping.validFrom }),
          ...(mapping.validUntil === undefined ? {} : { validUntil: mapping.validUntil }),
        },
        planHash,
      );
      return;
    }
    case 'mapping.preview': {
      const expected = required(change.preview, change);
      const response = await client.invoke(
        `/api/v1/mappings/${encodeURIComponent(change.stableKey)}/preview`,
        { expectedRevision: requiredRevision(change) },
        planHash,
      );
      assertPreview(parseMappingPreviewResponse(response), expected, change);
      return;
    }
    case 'mapping.activate': {
      const expected = required(change.preview, change);
      const response = await client.invoke(
        `/api/v1/mappings/${encodeURIComponent(change.stableKey)}/activate`,
        {
          expectedRevision: requiredRevision(change),
          confirmedAffectedSubjectIds: expected.affectedSubjectIds,
        },
        planHash,
      );
      const activation = z
        .object({ data: z.object({ preview: mappingPreviewSchema }).passthrough() })
        .strict()
        .parse(response);
      assertPreview(activation.data.preview, expected, change);
      return;
    }
    case 'mapping.retire': {
      await client.invoke(
        `/api/v1/mappings/${encodeURIComponent(change.stableKey)}/retire`,
        { expectedRevision: requiredRevision(change) },
        planHash,
      );
      return;
    }
    default:
      throw new ConfigurationApplyError(
        'unsupported_configuration_action',
        `Unsupported configuration action ${change.action}.`,
      );
  }
}

function applicationCreateBody(
  application: RuntimeConfigurationManifest['applications'][number],
): JsonObject {
  return {
    key: application.key,
    name: application.name,
    ...(application.description === undefined ? {} : { description: application.description }),
    category: application.category,
    launchUrl: application.launchUrl,
    visibility: application.visibility,
    authentication: jsonObjectSchema.parse(application.authentication),
    provisioningMode: application.provisioningMode,
    status: application.status,
  };
}

function applicationUpdateBody(
  application: RuntimeConfigurationManifest['applications'][number],
): JsonObject {
  const { key: _key, ...body } = applicationCreateBody(application);
  void _key;
  return { ...body, description: application.description ?? null };
}

function entitlementCreateBody(
  entitlement: RuntimeConfigurationManifest['applications'][number]['entitlements'][number],
): JsonObject {
  return {
    key: entitlement.key,
    name: entitlement.name,
    ...(entitlement.description === undefined ? {} : { description: entitlement.description }),
    requiresProvisioning: entitlement.requiresProvisioning,
    status: entitlement.status,
  };
}

function entitlementUpdateBody(
  entitlement: RuntimeConfigurationManifest['applications'][number]['entitlements'][number],
): JsonObject {
  const { key: _key, ...body } = entitlementCreateBody(entitlement);
  void _key;
  return { ...body, description: entitlement.description ?? null };
}

function providerConnectionCreateBody(
  connection: RuntimeConfigurationManifest['providerConnections'][number],
): JsonObject {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    mode: connection.mode,
    ...(connection.credentialRef === undefined ? {} : { credentialRef: connection.credentialRef }),
    configuration: connection.configuration,
    status: connection.status,
  };
}

function providerConnectionUpdateBody(
  connection: RuntimeConfigurationManifest['providerConnections'][number],
): JsonObject {
  return {
    name: connection.name,
    mode: connection.mode,
    credentialRef: connection.credentialRef ?? null,
    configuration: connection.configuration,
    status: connection.status,
  };
}

function requiredEntitlement(manifest: RuntimeConfigurationManifest, stableKey: string) {
  for (const application of manifest.applications) {
    const entitlement = application.entitlements.find(
      (candidate) => entitlementKey(application.key, candidate.key) === stableKey,
    );
    if (entitlement !== undefined) return { application, entitlement };
  }
  throw new ConfigurationApplyError(
    'manifest_reference_missing',
    `Manifest entitlement ${stableKey} is unavailable.`,
  );
}

function required<T>(value: T | undefined, change: ConfigurationChange): T {
  if (value === undefined) {
    throw new ConfigurationApplyError(
      'manifest_reference_missing',
      `Required state for ${change.action} ${change.stableKey} is unavailable.`,
    );
  }
  return value;
}

function requiredRevision(change: ConfigurationChange): number {
  if (change.expectedRevision === undefined) {
    throw new ConfigurationApplyError(
      'expected_revision_missing',
      `Action ${change.action} ${change.stableKey} has no expected revision.`,
    );
  }
  return change.expectedRevision;
}

function assertPreview(
  actual: z.infer<typeof mappingPreviewSchema>,
  expected: NonNullable<ConfigurationChange['preview']>,
  change: ConfigurationChange,
): void {
  const actualValue = {
    affectedSubjectIds: [...actual.affectedSubjectIds].sort(),
    grantCountBefore: actual.grantCountBefore,
    grantCountAfter: actual.grantCountAfter,
    mappingExpectedRevision: actual.expectedRevision,
  };
  if (canonicalJson(actualValue) !== canonicalJson(expected)) {
    throw new ConfigurationApplyError(
      'mapping_preview_changed',
      `Mapping preview changed for ${change.stableKey}; regenerate the configuration plan.`,
    );
  }
}

function compareApplyOrder(left: ConfigurationChange, right: ConfigurationChange): number {
  const order: Record<string, number> = {
    'organization.update': 0,
    'directory-source.create': 10,
    'directory-source.update': 10,
    'application.create': 20,
    'application.update': 25,
    'entitlement.create': 30,
    'entitlement.update': 30,
    'provider-connection.create': 40,
    'provider-connection.update': 40,
    'provisioning-target.create': 50,
    'provisioning-target.update': 50,
    'mapping.retire': 55,
    'mapping.create': 60,
    'mapping.preview': 70,
    'mapping.activate': 70,
  };
  const rank = (change: ConfigurationChange): number => {
    if (change.action === 'mapping.retire') return 0;
    if (
      change.action === 'provisioning-target.update' &&
      (change.after?.status !== 'active' ||
        (change.before?.mode === 'automatic' && change.after.mode !== 'automatic'))
    ) {
      return 10;
    }
    if (change.action === 'entitlement.update' && change.after?.status !== 'active') return 20;
    if (
      change.action === 'application.update' &&
      (change.after?.status === 'retired' || change.after?.provisioningMode === 'none')
    ) {
      return 35;
    }
    if (
      change.action === 'provider-connection.update' &&
      (change.after?.status !== 'active' ||
        (change.before?.mode === 'automatic' && change.after.mode !== 'automatic'))
    ) {
      return 55;
    }
    return order[change.action] ?? Number.MAX_SAFE_INTEGER;
  };
  return (
    rank(left) - rank(right) ||
    compareText(left.stableKey, right.stableKey) ||
    compareText(right.action, left.action)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
