import {
  AccessControlError,
  NotFoundError,
  RevisionConflictError,
  bindingReferenceSchema,
  createDirectorySourceCandidate,
  createOrganizationSettingsCandidate,
  createProviderConnectionCandidate,
  createProvisioningTargetCandidate,
  providerConfigurationSchemas,
  provisioningTargetConfigurationSchema,
  type Application,
  type ApplicationEntitlement,
  type DirectorySource,
  type JsonObject,
  type OrganizationSettings,
  type PlatformRole,
  type ProviderConnection,
  type ProvisioningTarget,
} from '@access-control/domain';
import { createMutationRecords, type MutationContext } from './events';
import type {
  CatalogRepository,
  DirectoryRepository,
  IdentityRepository,
  ProvisioningRepository,
} from './ports';
import type { ServiceRuntime } from './runtime';

export type ConfigurationActorContext = MutationContext & {
  actorSubjectId: string;
  roles: PlatformRole[];
};

export interface UpdateOrganizationSettingsInput {
  organizationName: string;
  title: string;
  supportUrl?: string | null;
  brandMarkUrl?: string | null;
  maxPlanChanges: number;
  expectedRevision: number;
}

export interface CreateDirectorySourceInput {
  id: string;
  provider: DirectorySource['provider'];
  customerId: string;
  delegatedAdmin: string;
  credentialRef: string;
  accessGroupPrefix: string;
  status: Exclude<DirectorySource['status'], 'retired'>;
}

export interface UpdateDirectorySourceInput extends Omit<
  CreateDirectorySourceInput,
  'id' | 'provider' | 'status'
> {
  status: DirectorySource['status'];
  expectedRevision: number;
}

export interface CreateProviderConnectionInput {
  id: string;
  provider: ProviderConnection['provider'];
  name: string;
  mode: ProviderConnection['mode'];
  credentialRef?: string;
  configuration: JsonObject;
  status: Exclude<ProviderConnection['status'], 'retired'>;
}

export interface UpdateProviderConnectionInput extends Omit<
  CreateProviderConnectionInput,
  'credentialRef' | 'id' | 'provider' | 'status'
> {
  credentialRef?: string | null;
  status: ProviderConnection['status'];
  expectedRevision: number;
}

export interface CreateProvisioningTargetInput {
  id: string;
  providerConnectionId: string;
  applicationEntitlementId: string;
  targetType: ProvisioningTarget['targetType'];
  providerTargetId: string;
  mode: ProvisioningTarget['mode'];
  protected: boolean;
  configuration: JsonObject;
  status: Exclude<ProvisioningTarget['status'], 'retired'>;
}

export interface UpdateProvisioningTargetInput {
  applicationEntitlementId: string;
  mode: ProvisioningTarget['mode'];
  protected: boolean;
  configuration: JsonObject;
  status: ProvisioningTarget['status'];
  expectedRevision: number;
}

export class RuntimeConfigurationService {
  public constructor(
    private readonly identities: IdentityRepository,
    private readonly directory: DirectoryRepository,
    private readonly catalog: CatalogRepository,
    private readonly provisioning: ProvisioningRepository,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async updateOrganizationSettings(
    input: UpdateOrganizationSettingsInput,
    context: ConfigurationActorContext,
  ): Promise<OrganizationSettings> {
    requireAdministrator(context, 'Organization Settings updates require an administrator.');
    const current = await this.identities.getOrganizationSettings();
    if (current === null) throw new NotFoundError('Organization settings', 'organization');
    assertRevision(current.revision, input.expectedRevision);
    const {
      supportUrl: currentSupportUrl,
      brandMarkUrl: currentBrandMarkUrl,
      ...currentWithoutOptionalUrls
    } = current;
    const settings = createOrganizationSettingsCandidate({
      ...currentWithoutOptionalUrls,
      organizationName: input.organizationName,
      title: input.title,
      ...(input.supportUrl === undefined
        ? currentSupportUrl === undefined
          ? {}
          : { supportUrl: currentSupportUrl }
        : input.supportUrl === null
          ? {}
          : { supportUrl: input.supportUrl }),
      ...(input.brandMarkUrl === undefined
        ? currentBrandMarkUrl === undefined
          ? {}
          : { brandMarkUrl: currentBrandMarkUrl }
        : input.brandMarkUrl === null
          ? {}
          : { brandMarkUrl: input.brandMarkUrl }),
      maxPlanChanges: input.maxPlanChanges,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.identities.updateOrganizationSettings(
      settings,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.organization-settings.updated',
        topic: 'access-control.organization-settings.updated',
        targetType: 'organization_settings',
        targetId: settings.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: settings.revision,
        payload: { maxPlanChanges: settings.maxPlanChanges },
      }),
      input.expectedRevision,
    );
    return settings;
  }

  public async createDirectorySource(
    input: CreateDirectorySourceInput,
    context: ConfigurationActorContext,
  ): Promise<DirectorySource> {
    const now = this.runtime.now();
    const source = createDirectorySourceCandidate({
      ...input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.directory.createDirectorySource(
      source,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.directory-source.created',
        topic: 'access-control.directory-source.created',
        targetType: 'directory_source',
        targetId: source.id,
        action: 'create',
        resultingRevision: 1,
        payload: { provider: source.provider, status: source.status },
      }),
    );
    return source;
  }

  public async updateDirectorySource(
    id: string,
    input: UpdateDirectorySourceInput,
    context: ConfigurationActorContext,
  ): Promise<DirectorySource> {
    const current = await this.requireDirectorySource(id);
    assertRevision(current.revision, input.expectedRevision);
    if (current.customerId !== input.customerId || current.credentialRef !== input.credentialRef) {
      requireAdministrator(
        context,
        'Directory Source customer and credential reference changes require an administrator.',
      );
    }
    const source = createDirectorySourceCandidate({
      ...current,
      customerId: input.customerId,
      delegatedAdmin: input.delegatedAdmin,
      credentialRef: input.credentialRef,
      accessGroupPrefix: input.accessGroupPrefix,
      status: input.status,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.directory.updateDirectorySource(
      source,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.directory-source.updated',
        topic: 'access-control.directory-source.updated',
        targetType: 'directory_source',
        targetId: source.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: source.revision,
        payload: { provider: source.provider, status: source.status },
      }),
      input.expectedRevision,
    );
    return source;
  }

  public async createProviderConnection(
    input: CreateProviderConnectionInput,
    context: ConfigurationActorContext,
  ): Promise<ProviderConnection> {
    assertSafeConfiguration(input.configuration);
    providerConfigurationSchemas[input.provider].parse(input.configuration);
    if (input.mode === 'automatic') {
      requireAdministrator(
        context,
        'Automatic Provider Connection mode requires an administrator.',
      );
    }
    const now = this.runtime.now();
    const connection = createProviderConnectionCandidate({
      ...input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.provisioning.createProviderConnection(
      connection,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.provider-connection.created',
        topic: 'access-control.provider-connection.created',
        targetType: 'provider_connection',
        targetId: connection.id,
        action: 'create',
        resultingRevision: 1,
        payload: {
          provider: connection.provider,
          mode: connection.mode,
          status: connection.status,
        },
      }),
    );
    return connection;
  }

  public async updateProviderConnection(
    id: string,
    input: UpdateProviderConnectionInput,
    context: ConfigurationActorContext,
  ): Promise<ProviderConnection> {
    const current = await this.requireProviderConnection(id);
    assertRevision(current.revision, input.expectedRevision);
    assertSafeConfiguration(input.configuration);
    providerConfigurationSchemas[current.provider].parse(input.configuration);
    const credentialRef =
      input.credentialRef === undefined ? current.credentialRef : input.credentialRef;
    if (
      credentialRef !== current.credentialRef ||
      (current.mode !== 'automatic' && input.mode === 'automatic')
    ) {
      requireAdministrator(
        context,
        'Credential reference and automatic mode changes require an administrator.',
      );
    }
    await this.assertConnectionLifecycle(current.id, input.mode, input.status);
    const { credentialRef: _currentCredentialRef, ...currentWithoutCredentialRef } = current;
    void _currentCredentialRef;
    const connection = createProviderConnectionCandidate({
      ...currentWithoutCredentialRef,
      name: input.name,
      mode: input.mode,
      ...(credentialRef === null || credentialRef === undefined ? {} : { credentialRef }),
      configuration: input.configuration,
      status: input.status,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.provisioning.updateProviderConnection(
      connection,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.provider-connection.updated',
        topic: 'access-control.provider-connection.updated',
        targetType: 'provider_connection',
        targetId: connection.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: connection.revision,
        payload: {
          provider: connection.provider,
          mode: connection.mode,
          status: connection.status,
        },
      }),
      input.expectedRevision,
    );
    return connection;
  }

  public async createProvisioningTarget(
    input: CreateProvisioningTargetInput,
    context: ConfigurationActorContext,
  ): Promise<ProvisioningTarget> {
    assertSafeConfiguration(input.configuration);
    provisioningTargetConfigurationSchema.parse(input.configuration);
    const connection = await this.requireProviderConnection(input.providerConnectionId);
    const entitlement = await this.requireEntitlement(input.applicationEntitlementId);
    const application = await this.requireApplication(entitlement.applicationId);
    assertTargetProvider(connection.provider, input.targetType);
    if (input.mode === 'automatic') {
      requireAdministrator(
        context,
        'Automatic Provisioning Target mode requires an administrator.',
      );
    }
    assertTargetLifecycle(input, connection, application, entitlement);
    const now = this.runtime.now();
    const target = createProvisioningTargetCandidate({
      ...input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actorSubjectId,
      updatedBy: context.actorSubjectId,
    });
    await this.provisioning.createProvisioningTarget(
      target,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.provisioning-target.created',
        topic: 'access-control.provisioning-target.created',
        targetType: 'provisioning_target',
        targetId: target.id,
        action: 'create',
        resultingRevision: 1,
        payload: {
          mode: target.mode,
          protected: target.protected,
          status: target.status,
        },
      }),
    );
    return target;
  }

  public async updateProvisioningTarget(
    id: string,
    input: UpdateProvisioningTargetInput,
    context: ConfigurationActorContext,
  ): Promise<ProvisioningTarget> {
    const current = await this.requireProvisioningTarget(id);
    assertRevision(current.revision, input.expectedRevision);
    assertSafeConfiguration(input.configuration);
    provisioningTargetConfigurationSchema.parse(input.configuration);
    const connection = await this.requireProviderConnection(current.providerConnectionId);
    const entitlement = await this.requireEntitlement(input.applicationEntitlementId);
    const application = await this.requireApplication(entitlement.applicationId);
    assertTargetProvider(connection.provider, current.targetType);
    if (
      (current.protected && !input.protected) ||
      (current.mode !== 'automatic' && input.mode === 'automatic')
    ) {
      requireAdministrator(
        context,
        'Protected flag removal and automatic mode changes require an administrator.',
      );
    }
    assertTargetLifecycle(input, connection, application, entitlement);
    const target = createProvisioningTargetCandidate({
      ...current,
      applicationEntitlementId: input.applicationEntitlementId,
      mode: input.mode,
      protected: input.protected,
      configuration: input.configuration,
      status: input.status,
      revision: current.revision + 1,
      updatedAt: this.runtime.now(),
      updatedBy: context.actorSubjectId,
    });
    await this.provisioning.updateProvisioningTarget(
      target,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.provisioning-target.updated',
        topic: 'access-control.provisioning-target.updated',
        targetType: 'provisioning_target',
        targetId: target.id,
        action: 'update',
        previousRevision: current.revision,
        resultingRevision: target.revision,
        payload: {
          mode: target.mode,
          protected: target.protected,
          status: target.status,
        },
      }),
      input.expectedRevision,
    );
    return target;
  }

  private async requireDirectorySource(id: string): Promise<DirectorySource> {
    const source = await this.directory.getDirectorySource(id);
    if (source === null) throw new NotFoundError('Directory Source', id);
    return source;
  }

  private async requireProviderConnection(id: string): Promise<ProviderConnection> {
    const connection = await this.provisioning.getProviderConnection(id);
    if (connection === null) throw new NotFoundError('Provider Connection', id);
    return connection;
  }

  private async requireProvisioningTarget(id: string): Promise<ProvisioningTarget> {
    const target = await this.provisioning.getProvisioningTarget(id);
    if (target === null) throw new NotFoundError('Provisioning Target', id);
    return target;
  }

  private async requireEntitlement(id: string): Promise<ApplicationEntitlement> {
    const entitlement = await this.catalog.getApplicationEntitlement(id);
    if (entitlement === null) throw new NotFoundError('Application entitlement', id);
    return entitlement;
  }

  private async requireApplication(id: string): Promise<Application> {
    const application = await this.catalog.getApplication(id);
    if (application === null) throw new NotFoundError('Application', id);
    return application;
  }

  private async assertConnectionLifecycle(
    id: string,
    mode: ProviderConnection['mode'],
    status: ProviderConnection['status'],
  ): Promise<void> {
    const activeTargets = (await this.provisioning.listProvisioningTargets()).filter(
      (target) => target.providerConnectionId === id && target.status === 'active',
    );
    if (status !== 'active' && activeTargets.length > 0) {
      throw invalidConfigurationLifecycle(
        'A Provider Connection can be disabled or retired only after its active targets are disabled.',
      );
    }
    if (mode !== 'automatic' && activeTargets.some((target) => target.mode === 'automatic')) {
      throw invalidConfigurationLifecycle(
        'An automatic Provisioning Target requires an automatic Provider Connection.',
      );
    }
  }
}

function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new RevisionConflictError(expected, actual);
}

function requireAdministrator(context: ConfigurationActorContext, message: string): void {
  if (!context.roles.includes('admin')) {
    throw new AccessControlError(403, 'administrator_required', message);
  }
}

function assertTargetProvider(
  provider: ProviderConnection['provider'],
  targetType: ProvisioningTarget['targetType'],
): void {
  const prefix = targetType.split('_')[0];
  if (prefix !== provider) {
    throw new AccessControlError(
      422,
      'provider_target_type_mismatch',
      'The Provisioning Target type does not belong to its Provider Connection.',
    );
  }
}

function assertTargetLifecycle(
  target: Pick<UpdateProvisioningTargetInput, 'mode' | 'status'>,
  connection: ProviderConnection,
  application: Application,
  entitlement: ApplicationEntitlement,
): void {
  if (target.status !== 'active') return;
  if (
    connection.status !== 'active' ||
    application.status !== 'active' ||
    entitlement.status !== 'active'
  ) {
    throw invalidConfigurationLifecycle(
      'An active Provisioning Target requires an active connection, application, and entitlement.',
    );
  }
  if (target.mode === 'automatic' && connection.mode !== 'automatic') {
    throw invalidConfigurationLifecycle(
      'An automatic Provisioning Target requires an automatic Provider Connection.',
    );
  }
}

function invalidConfigurationLifecycle(message: string): AccessControlError {
  return new AccessControlError(422, 'invalid_configuration_lifecycle', message);
}

function assertSafeConfiguration(configuration: JsonObject): void {
  const forbidden =
    /(?:apikey|authorization|clientsecret|credential|password|privatekey|refreshtoken|secret|token)/;
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string' && /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(value)) {
      throw secretConfiguration(path);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
      const isReference = normalized.endsWith('ref') || normalized.endsWith('binding');
      if (isReference && !bindingReferenceSchema.safeParse(item).success) {
        throw secretConfiguration(path.length === 0 ? key : `${path}.${key}`);
      }
      if (!isReference && forbidden.test(normalized)) {
        throw secretConfiguration(path.length === 0 ? key : `${path}.${key}`);
      }
      visit(item, path.length === 0 ? key : `${path}.${key}`);
    }
  };
  visit(configuration, 'configuration');
}

function secretConfiguration(path: string): AccessControlError {
  return new AccessControlError(
    422,
    'secret_configuration_forbidden',
    'Provider configuration must contain references and non-secret settings only.',
    [
      {
        code: 'secret_like_value',
        path,
        message: 'Store the credential in a runtime secret binding and keep only its binding name.',
      },
    ],
  );
}
