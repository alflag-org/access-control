import { z } from 'zod';
import {
  applicationAuthenticationSchema,
  bindingReferenceSchema,
  idSchema,
  httpsUrlSchema,
  jsonObjectSchema,
  keySchema,
  providerSchema,
  providerConfigurationSchemas,
  provisioningTargetConfigurationSchema,
  provisioningModeSchema,
  reconciliationModeSchema,
} from '@access-control/domain';

export const configurationEnvironmentSchema = z.enum(['development', 'staging', 'production']);

const lifecycleStatusSchema = z.enum(['active', 'disabled', 'retired']);
const entitlementReferenceSchema = z
  .object({
    applicationKey: keySchema,
    entitlementKey: keySchema,
  })
  .strict();

export const organizationManifestSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(160),
    supportUrl: httpsUrlSchema.optional(),
    brandMarkUrl: httpsUrlSchema.optional(),
    maxPlanChanges: z.int().min(1).max(10_000),
  })
  .strict();

export const directorySourceManifestSchema = z
  .object({
    id: idSchema,
    provider: z.literal('google'),
    customerId: z.string().trim().min(1).max(128),
    delegatedAdmin: z.email().max(320),
    credentialRef: bindingReferenceSchema,
    accessGroupPrefix: z.string().trim().min(1).max(100),
    status: lifecycleStatusSchema,
  })
  .strict();

export const entitlementManifestSchema = z
  .object({
    key: keySchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).optional(),
    requiresProvisioning: z.boolean(),
    status: lifecycleStatusSchema,
  })
  .strict();

export const applicationManifestSchema = z
  .object({
    key: keySchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).optional(),
    category: z.string().trim().min(1).max(100),
    launchUrl: httpsUrlSchema,
    visibility: z.enum(['entitled', 'all_active_subjects']),
    authentication: applicationAuthenticationSchema,
    provisioningMode: provisioningModeSchema,
    status: lifecycleStatusSchema,
    entitlements: z.array(entitlementManifestSchema).max(1_000),
  })
  .strict();

export const providerConnectionManifestSchema = z
  .object({
    id: idSchema,
    provider: providerSchema,
    name: z.string().trim().min(1).max(160),
    mode: reconciliationModeSchema,
    credentialRef: bindingReferenceSchema.optional(),
    configuration: jsonObjectSchema,
    status: lifecycleStatusSchema,
  })
  .strict()
  .superRefine((connection, context) => {
    forwardConfigurationIssues(
      providerConfigurationSchemas[connection.provider].safeParse(connection.configuration),
      context,
    );
  });

export const provisioningTargetManifestSchema = z
  .object({
    id: idSchema,
    providerConnectionId: idSchema,
    applicationKey: keySchema,
    entitlementKey: keySchema,
    targetType: z.enum([
      'github_organization_membership',
      'github_team_membership',
      'proxmox_group_membership',
      'zabbix_saml_mapping',
      'zabbix_scim_membership',
      'posix_account',
      'posix_group_membership',
      'posix_sudo',
    ]),
    providerTargetId: z.string().trim().min(1).max(500),
    mode: reconciliationModeSchema,
    protected: z.boolean(),
    configuration: jsonObjectSchema,
    status: lifecycleStatusSchema,
  })
  .strict()
  .superRefine((target, context) => {
    forwardConfigurationIssues(
      provisioningTargetConfigurationSchema.safeParse(target.configuration),
      context,
    );
  });

export const mappingManifestSchema = z
  .object({
    id: idSchema,
    sourceGroup: z
      .object({
        providerGroupId: z.string().trim().min(1).max(256),
        expectedEmail: z.email().max(320),
      })
      .strict(),
    entitlements: z.array(entitlementReferenceSchema).min(1).max(100),
    provisioningTargetIds: z.array(idSchema).max(100),
    status: z.enum(['active', 'retired']),
    validFrom: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (
      mapping.validFrom !== undefined &&
      mapping.validUntil !== undefined &&
      Date.parse(mapping.validUntil) <= Date.parse(mapping.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Mapping validity end must be after its start.',
      });
    }
  });

export const runtimeConfigurationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    organization: organizationManifestSchema,
    directorySources: z.array(directorySourceManifestSchema).max(100),
    applications: z.array(applicationManifestSchema).max(1_000),
    providerConnections: z.array(providerConnectionManifestSchema).max(100),
    provisioningTargets: z.array(provisioningTargetManifestSchema).max(1_000),
    mappings: z.array(mappingManifestSchema).max(10_000),
  })
  .strict()
  .superRefine(validateManifestRelationships);

export type ConfigurationEnvironment = z.infer<typeof configurationEnvironmentSchema>;
export type RuntimeConfigurationManifest = z.infer<typeof runtimeConfigurationManifestSchema>;
export type ApplicationManifest = z.infer<typeof applicationManifestSchema>;
export type EntitlementManifest = z.infer<typeof entitlementManifestSchema>;
export type MappingManifest = z.infer<typeof mappingManifestSchema>;
export type ProvisioningTargetManifest = z.infer<typeof provisioningTargetManifestSchema>;

function validateManifestRelationships(
  manifest: z.infer<typeof runtimeConfigurationManifestSchema>,
  context: z.RefinementCtx,
): void {
  unique(manifest.directorySources, (value) => value.id, ['directorySources'], context);
  unique(manifest.applications, (value) => value.key, ['applications'], context);
  unique(manifest.providerConnections, (value) => value.id, ['providerConnections'], context);
  unique(manifest.provisioningTargets, (value) => value.id, ['provisioningTargets'], context);
  unique(manifest.mappings, (value) => value.id, ['mappings'], context);

  const entitlementKeys = new Set<string>();
  const entitlements = new Map<string, EntitlementManifest>();
  const applications = new Map(
    manifest.applications.map((application) => [application.key, application]),
  );
  for (const [applicationIndex, application] of manifest.applications.entries()) {
    unique(
      application.entitlements,
      (value) => value.key,
      ['applications', applicationIndex, 'entitlements'],
      context,
    );
    for (const [entitlementIndex, entitlement] of application.entitlements.entries()) {
      const key = entitlementKey(application.key, entitlement.key);
      entitlementKeys.add(key);
      entitlements.set(key, entitlement);
      if (entitlement.requiresProvisioning && application.provisioningMode === 'none') {
        issue(
          context,
          [
            'applications',
            applicationIndex,
            'entitlements',
            entitlementIndex,
            'requiresProvisioning',
          ],
          'Provisioning-required entitlements cannot belong to an application with mode none.',
        );
      }
      if (application.status === 'retired' && entitlement.status !== 'retired') {
        issue(
          context,
          ['applications', applicationIndex, 'entitlements', entitlementIndex, 'status'],
          'Entitlements of a retired application must also be retired.',
        );
      }
    }
  }

  const connections = new Map(
    manifest.providerConnections.map((connection) => [connection.id, connection]),
  );
  const targets = new Map(manifest.provisioningTargets.map((target) => [target.id, target]));
  for (const [index, target] of manifest.provisioningTargets.entries()) {
    const connection = connections.get(target.providerConnectionId);
    const application = applications.get(target.applicationKey);
    const entitlement = entitlements.get(
      entitlementKey(target.applicationKey, target.entitlementKey),
    );
    if (connection === undefined) {
      issue(
        context,
        ['provisioningTargets', index, 'providerConnectionId'],
        'Unknown Provider Connection.',
      );
    } else {
      if (target.targetType.split('_')[0] !== connection.provider) {
        issue(
          context,
          ['provisioningTargets', index, 'targetType'],
          'Target type and provider do not match.',
        );
      }
      if (target.status === 'active' && connection.status !== 'active') {
        issue(
          context,
          ['provisioningTargets', index, 'status'],
          'An active target requires an active connection.',
        );
      }
      if (
        target.status === 'active' &&
        target.mode === 'automatic' &&
        connection.mode !== 'automatic'
      ) {
        issue(
          context,
          ['provisioningTargets', index, 'mode'],
          'An automatic target requires an automatic connection.',
        );
      }
    }
    if (application === undefined || entitlement === undefined) {
      issue(
        context,
        ['provisioningTargets', index, 'entitlementKey'],
        'Unknown Application Entitlement reference.',
      );
    } else if (
      target.status === 'active' &&
      (application.status !== 'active' || entitlement.status !== 'active')
    ) {
      issue(
        context,
        ['provisioningTargets', index, 'status'],
        'An active target requires an active Application Entitlement.',
      );
    }
  }

  for (const [index, mapping] of manifest.mappings.entries()) {
    unique(
      mapping.entitlements,
      (value) => entitlementKey(value.applicationKey, value.entitlementKey),
      ['mappings', index, 'entitlements'],
      context,
    );
    unique(
      mapping.provisioningTargetIds.map((id) => ({ id })),
      (value) => value.id,
      ['mappings', index, 'provisioningTargetIds'],
      context,
    );
    for (const [referenceIndex, reference] of mapping.entitlements.entries()) {
      const key = entitlementKey(reference.applicationKey, reference.entitlementKey);
      const entitlement = entitlements.get(key);
      if (!entitlementKeys.has(key)) {
        issue(
          context,
          ['mappings', index, 'entitlements', referenceIndex],
          'Unknown Application Entitlement reference.',
        );
      } else if (mapping.status === 'active' && entitlement?.status !== 'active') {
        issue(
          context,
          ['mappings', index, 'entitlements', referenceIndex],
          'An active mapping requires active entitlements.',
        );
      }
    }
    for (const [targetIndex, targetId] of mapping.provisioningTargetIds.entries()) {
      const target = targets.get(targetId);
      if (target === undefined) {
        issue(
          context,
          ['mappings', index, 'provisioningTargetIds', targetIndex],
          'Unknown Provisioning Target reference.',
        );
      } else if (mapping.status === 'active' && target.status !== 'active') {
        issue(
          context,
          ['mappings', index, 'provisioningTargetIds', targetIndex],
          'An active mapping requires active Provisioning Targets.',
        );
      }
    }
  }

  detectSecretLikeFields(manifest, context);
}

function unique<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const stableKey = key(value);
    const first = seen.get(stableKey);
    if (first === undefined) seen.set(stableKey, index);
    else
      issue(
        context,
        [...path, index],
        `Duplicate stable identifier ${stableKey}; first seen at index ${first}.`,
      );
  }
}

function detectSecretLikeFields(value: unknown, context: z.RefinementCtx): void {
  const forbidden =
    /(?:apikey|authorization|clientsecret|credential|password|privatekey|refreshtoken|secret|token)/;
  const visit = (candidate: unknown, path: PropertyKey[]): void => {
    if (
      typeof candidate === 'string' &&
      /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(candidate)
    ) {
      issue(
        context,
        path,
        'Credential-like values are forbidden; use a runtime binding reference.',
      );
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    for (const [field, item] of Object.entries(candidate)) {
      const normalized = field.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
      const isReference = normalized.endsWith('ref') || normalized.endsWith('binding');
      if (isReference && !bindingReferenceSchema.safeParse(item).success) {
        issue(context, [...path, field], 'Credential references must be runtime binding names.');
      } else if (!isReference && forbidden.test(normalized)) {
        issue(
          context,
          [...path, field],
          'Credential-like fields are forbidden; use credentialRef.',
        );
      }
      visit(item, [...path, field]);
    }
  };
  visit(value, []);
}

function forwardConfigurationIssues(
  result: z.ZodSafeParseResult<unknown>,
  context: z.RefinementCtx,
): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    context.addIssue({ ...issue, path: ['configuration', ...issue.path] });
  }
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

export function entitlementKey(applicationKey: string, entitlementKeyValue: string): string {
  return `${applicationKey}:${entitlementKeyValue}`;
}
