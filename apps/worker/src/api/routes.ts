import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  CatalogService,
  DirectorySyncService,
  ExportService,
  IdentityService,
  ReconciliationService,
  RuntimeConfigurationService,
  workerServiceRuntime,
  type ConfigurationActorContext,
  type RequiredActorContext,
} from '@access-control/application';
import { paginationQuerySchema, type ProvisioningAdapter } from '@access-control/contracts';
import {
  AccessControlError,
  NotFoundError,
  jsonValueSchema,
  platformRoleSchema,
} from '@access-control/domain';
import { GitHubProvisioningAdapter, createGitHubAppTransport } from '@access-control/github';
import { GoogleDirectoryReadAdapter, createGoogleTransportFactory } from '@access-control/google';
import { PosixObservationAdapter } from '@access-control/posix';
import { ProxmoxObservationAdapter } from '@access-control/proxmox';
import { ZabbixObservationAdapter } from '@access-control/zabbix';
import type { WorkerEnvironment } from './environment';
import {
  apiRoutes,
  createApplicationSchema,
  createDirectorySourceSchema,
  createEntitlementSchema,
  createMappingSchema,
  createProviderConnectionSchema,
  createProvisioningTargetSchema,
  retireMappingSchema,
  updateDirectorySourceSchema,
  updateEntitlementSchema,
  updateOrganizationSettingsSchema,
  updateApplicationSchema,
  updateProviderConnectionSchema,
  updateProvisioningTargetSchema,
  type ApiRouteContract,
} from './route-contracts';
import { requireRoles, requireSubject } from './security';

export function registerApiRoutes(app: OpenAPIHono<WorkerEnvironment>): void {
  app.openapi(apiRoutes.session.definition, (context) =>
    respond(context, apiRoutes.session, {
      data: {
        principal: context.get('accessPrincipal'),
        mapped: context.get('subject') !== null,
        subject: context.get('subject'),
        roles: context.get('roles'),
      },
    }),
  );

  app.openapi(apiRoutes.me.definition, async (context) => {
    const subject = authorize(context, apiRoutes.me);
    const repository = context.get('repositories').identities;
    const [identities, guestProfile, grants] = await Promise.all([
      repository.listExternalIdentities(subject.id),
      repository.getGuestProfile(subject.id),
      repository.listPlatformRoleGrants(subject.id),
    ]);
    return respond(context, apiRoutes.me, {
      data: {
        subject,
        identities,
        guestProfile,
        roles: grants.filter((grant) => grant.active).map((grant) => grant.role),
      },
    });
  });

  app.openapi(apiRoutes.myApplications.definition, async (context) => {
    const subject = authorize(context, apiRoutes.myApplications);
    const repositories = context.get('repositories');
    const [applications, entitlements, grants] = await Promise.all([
      repositories.catalog.listApplications(),
      repositories.catalog.listApplicationEntitlements(),
      repositories.catalog.listEffectiveGrants(subject.id),
    ]);
    const activeEntitlementIds = new Set(
      grants.filter((grant) => grant.status === 'active').map((grant) => grant.entitlementId),
    );
    const entitledApplicationIds = new Set(
      entitlements
        .filter((entitlement) => activeEntitlementIds.has(entitlement.id))
        .map((entitlement) => entitlement.applicationId),
    );
    const visible = applications.filter(
      (application) =>
        application.status === 'active' &&
        (application.visibility === 'all_active_subjects' ||
          entitledApplicationIds.has(application.id)),
    );
    return respondList(context, apiRoutes.myApplications, visible);
  });

  app.openapi(apiRoutes.myEntitlements.definition, async (context) => {
    const subject = authorize(context, apiRoutes.myEntitlements);
    return respondList(
      context,
      apiRoutes.myEntitlements,
      await context.get('repositories').catalog.listEffectiveGrants(subject.id),
    );
  });

  app.openapi(apiRoutes.myProviderAccounts.definition, async (context) => {
    const subject = authorize(context, apiRoutes.myProviderAccounts);
    return respondList(
      context,
      apiRoutes.myProviderAccounts,
      await context.get('repositories').provisioning.listProviderAccounts(subject.id),
    );
  });

  app.openapi(apiRoutes.subjects.definition, async (context) => {
    authorize(context, apiRoutes.subjects);
    return respondList(
      context,
      apiRoutes.subjects,
      await context.get('repositories').identities.listSubjects(),
    );
  });

  app.openapi(apiRoutes.subject.definition, async (context) => {
    authorize(context, apiRoutes.subject);
    const subject = await requireEntity(
      context.get('repositories').identities.getSubject(routeParam(context, 'subjectId')),
      'Subject',
      routeParam(context, 'subjectId'),
    );
    return respond(context, apiRoutes.subject, { data: subject });
  });

  app.openapi(apiRoutes.updateSubject.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateSubject);
    const body = await validJson(
      context,
      z
        .object({
          status: z.enum(['pending', 'active', 'suspended', 'retired']),
          expectedRevision: z.int().positive(),
          confirmed: z.boolean(),
        })
        .strict(),
    );
    const service = new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    );
    const subject = await service.updateSubjectStatus(
      routeParam(context, 'subjectId'),
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateSubject, { data: subject });
  });

  app.openapi(apiRoutes.subjectIdentities.definition, async (context) => {
    authorize(context, apiRoutes.subjectIdentities);
    const id = routeParam(context, 'subjectId');
    await requireEntity(context.get('repositories').identities.getSubject(id), 'Subject', id);
    return respondList(
      context,
      apiRoutes.subjectIdentities,
      await context.get('repositories').identities.listExternalIdentities(id),
    );
  });

  app.openapi(apiRoutes.bindSubjectIdentity.definition, async (context) => {
    const actor = authorize(context, apiRoutes.bindSubjectIdentity);
    const body = await validJson(context, bindExternalIdentityInputSchema);
    const result = await new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    ).bindExternalIdentity(routeParam(context, 'subjectId'), body, actorContext(context, actor.id));
    return respond(context, apiRoutes.bindSubjectIdentity, { data: result });
  });

  app.openapi(apiRoutes.subjectRoleGrants.definition, async (context) => {
    authorize(context, apiRoutes.subjectRoleGrants);
    const subjectId = routeParam(context, 'subjectId');
    await requireEntity(
      context.get('repositories').identities.getSubject(subjectId),
      'Subject',
      subjectId,
    );
    return respondList(
      context,
      apiRoutes.subjectRoleGrants,
      await context.get('repositories').identities.listPlatformRoleGrants(subjectId),
    );
  });

  app.openapi(apiRoutes.grantSubjectRole.definition, async (context) => {
    const actor = authorize(context, apiRoutes.grantSubjectRole);
    const body = await validJson(context, grantAdministrationRoleInputSchema);
    const grant = await new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    ).grantAdministrationRole(
      routeParam(context, 'subjectId'),
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.grantSubjectRole, { data: grant });
  });

  app.openapi(apiRoutes.deactivateRoleGrant.definition, async (context) => {
    const actor = authorize(context, apiRoutes.deactivateRoleGrant);
    const body = await validJson(context, deactivateAdministrationRoleInputSchema);
    const grant = await new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    ).deactivateAdministrationRole(
      routeParam(context, 'roleGrantId'),
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.deactivateRoleGrant, { data: grant });
  });

  app.openapi(apiRoutes.guests.definition, async (context) => {
    authorize(context, apiRoutes.guests);
    return respondList(
      context,
      apiRoutes.guests,
      await context.get('repositories').identities.listGuestProfiles(),
    );
  });

  app.openapi(apiRoutes.createGuest.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createGuest);
    const body = await validJson(context, createGuestInputSchema);
    const result = await new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    ).createManagedGuest(
      {
        displayName: body.displayName,
        sponsorSubjectId: body.sponsorSubjectId,
        externalContactEmail: body.externalContactEmail,
        externalOrganization: body.externalOrganization,
        purpose: body.purpose,
        validFrom: body.validFrom,
        expiresAt: body.expiresAt,
        ...(body.primaryEmail === undefined ? {} : { primaryEmail: body.primaryEmail }),
        ...(body.nextReviewAt === undefined ? {} : { nextReviewAt: body.nextReviewAt }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createGuest, { data: result });
  });

  app.openapi(apiRoutes.guest.definition, async (context) => {
    authorize(context, apiRoutes.guest);
    const id = routeParam(context, 'subjectId');
    const identities = context.get('repositories').identities;
    const [subject, guestProfile] = await Promise.all([
      requireEntity(identities.getSubject(id), 'Subject', id),
      requireEntity(identities.getGuestProfile(id), 'Guest profile', id),
    ]);
    return respond(context, apiRoutes.guest, { data: { subject, guestProfile } });
  });

  app.openapi(apiRoutes.suspendGuest.definition, async (context) => {
    const actor = authorize(context, apiRoutes.suspendGuest);
    const body = await validJson(
      context,
      z
        .object({
          expectedSubjectRevision: z.int().positive(),
          expectedGuestRevision: z.int().positive(),
          confirmed: z.literal(true),
        })
        .strict(),
    );
    const result = await new IdentityService(
      context.get('repositories').identities,
      workerServiceRuntime,
    ).suspendManagedGuest(routeParam(context, 'subjectId'), body, actorContext(context, actor.id));
    return respond(context, apiRoutes.suspendGuest, { data: result });
  });

  app.openapi(apiRoutes.organizationSettings.definition, async (context) => {
    authorize(context, apiRoutes.organizationSettings);
    const settings = await requireEntity(
      context.get('repositories').identities.getOrganizationSettings(),
      'Organization settings',
      'organization',
    );
    return respond(context, apiRoutes.organizationSettings, { data: settings });
  });

  app.openapi(apiRoutes.updateOrganizationSettings.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateOrganizationSettings);
    const body = await validJson(context, updateOrganizationSettingsSchema);
    const settings = await runtimeConfigurationService(context).updateOrganizationSettings(
      {
        organizationName: body.organizationName,
        title: body.title,
        maxPlanChanges: body.maxPlanChanges,
        expectedRevision: body.expectedRevision,
        ...(body.supportUrl === undefined ? {} : { supportUrl: body.supportUrl }),
        ...(body.brandMarkUrl === undefined ? {} : { brandMarkUrl: body.brandMarkUrl }),
      },
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateOrganizationSettings, { data: settings });
  });

  app.openapi(apiRoutes.directorySources.definition, async (context) => {
    authorize(context, apiRoutes.directorySources);
    return respondList(
      context,
      apiRoutes.directorySources,
      await context.get('repositories').directory.listDirectorySources(),
    );
  });

  app.openapi(apiRoutes.createDirectorySource.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createDirectorySource);
    const body = await validJson(context, createDirectorySourceSchema);
    const source = await runtimeConfigurationService(context).createDirectorySource(
      body,
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createDirectorySource, { data: source });
  });

  app.openapi(apiRoutes.directorySource.definition, async (context) => {
    authorize(context, apiRoutes.directorySource);
    const id = routeParam(context, 'directorySourceId');
    const source = await requireEntity(
      context.get('repositories').directory.getDirectorySource(id),
      'Directory Source',
      id,
    );
    return respond(context, apiRoutes.directorySource, { data: source });
  });

  app.openapi(apiRoutes.updateDirectorySource.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateDirectorySource);
    const body = await validJson(context, updateDirectorySourceSchema);
    const source = await runtimeConfigurationService(context).updateDirectorySource(
      routeParam(context, 'directorySourceId'),
      body,
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateDirectorySource, { data: source });
  });

  app.openapi(apiRoutes.sourceGroups.definition, async (context) => {
    authorize(context, apiRoutes.sourceGroups);
    return respondList(
      context,
      apiRoutes.sourceGroups,
      await context.get('repositories').catalog.listSourceGroups(),
    );
  });

  app.openapi(apiRoutes.sourceGroup.definition, async (context) => {
    authorize(context, apiRoutes.sourceGroup);
    const id = routeParam(context, 'groupId');
    const group = await requireEntity(
      context.get('repositories').catalog.getSourceGroup(id),
      'Source group',
      id,
    );
    return respond(context, apiRoutes.sourceGroup, { data: group });
  });

  app.openapi(apiRoutes.sourceGroupMembers.definition, async (context) => {
    authorize(context, apiRoutes.sourceGroupMembers);
    const id = routeParam(context, 'groupId');
    await requireEntity(context.get('repositories').catalog.getSourceGroup(id), 'Source group', id);
    return respondList(
      context,
      apiRoutes.sourceGroupMembers,
      await context.get('repositories').catalog.listSourceGroupMemberships(id),
    );
  });

  app.openapi(apiRoutes.applications.definition, async (context) => {
    authorize(context, apiRoutes.applications);
    return respondList(
      context,
      apiRoutes.applications,
      await context.get('repositories').catalog.listApplications(),
    );
  });

  app.openapi(apiRoutes.createApplication.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createApplication);
    const body = await validJson(context, createApplicationSchema);
    if (body.provisioningMode === 'automatic') requireAdministratorRole(context);
    const application = await catalogService(context).createApplication(
      {
        key: body.key,
        name: body.name,
        category: body.category,
        launchUrl: body.launchUrl,
        status: body.status,
        visibility: body.visibility,
        authentication: body.authentication,
        provisioningMode: body.provisioningMode,
        ...(body.description === undefined ? {} : { description: body.description }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createApplication, { data: application });
  });

  app.openapi(apiRoutes.application.definition, async (context) => {
    authorize(context, apiRoutes.application);
    const id = routeParam(context, 'applicationId');
    const application = await requireEntity(
      context.get('repositories').catalog.getApplication(id),
      'Application',
      id,
    );
    return respond(context, apiRoutes.application, { data: application });
  });

  app.openapi(apiRoutes.updateApplication.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateApplication);
    const body = await validJson(context, updateApplicationSchema);
    const current = await requireEntity(
      context.get('repositories').catalog.getApplication(routeParam(context, 'applicationId')),
      'Application',
      routeParam(context, 'applicationId'),
    );
    if (current.provisioningMode !== 'automatic' && body.provisioningMode === 'automatic') {
      requireAdministratorRole(context);
    }
    const application = await catalogService(context).updateApplication(
      routeParam(context, 'applicationId'),
      {
        name: body.name,
        category: body.category,
        launchUrl: body.launchUrl,
        status: body.status,
        visibility: body.visibility,
        authentication: body.authentication,
        provisioningMode: body.provisioningMode,
        expectedRevision: body.expectedRevision,
        ...(body.description === undefined ? {} : { description: body.description }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateApplication, { data: application });
  });

  app.openapi(apiRoutes.applicationEntitlements.definition, async (context) => {
    authorize(context, apiRoutes.applicationEntitlements);
    const id = routeParam(context, 'applicationId');
    await requireEntity(context.get('repositories').catalog.getApplication(id), 'Application', id);
    return respondList(
      context,
      apiRoutes.applicationEntitlements,
      await context.get('repositories').catalog.listApplicationEntitlements(id),
    );
  });

  app.openapi(apiRoutes.createApplicationEntitlement.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createApplicationEntitlement);
    const body = await validJson(context, createEntitlementSchema);
    const entitlement = await catalogService(context).createEntitlement(
      {
        applicationId: routeParam(context, 'applicationId'),
        key: body.key,
        name: body.name,
        requiresProvisioning: body.requiresProvisioning,
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.description === undefined ? {} : { description: body.description }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createApplicationEntitlement, { data: entitlement });
  });

  app.openapi(apiRoutes.updateApplicationEntitlement.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateApplicationEntitlement);
    const body = await validJson(context, updateEntitlementSchema);
    const entitlementId = routeParam(context, 'entitlementId');
    const current = await requireEntity(
      context.get('repositories').catalog.getApplicationEntitlement(entitlementId),
      'Application entitlement',
      entitlementId,
    );
    if (current.applicationId !== routeParam(context, 'applicationId')) {
      throw new NotFoundError('Application entitlement', entitlementId);
    }
    const entitlement = await catalogService(context).updateEntitlement(
      entitlementId,
      {
        name: body.name,
        status: body.status,
        requiresProvisioning: body.requiresProvisioning,
        expectedRevision: body.expectedRevision,
        ...(body.description === undefined ? {} : { description: body.description }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateApplicationEntitlement, { data: entitlement });
  });

  app.openapi(apiRoutes.mappings.definition, async (context) => {
    authorize(context, apiRoutes.mappings);
    return respondList(
      context,
      apiRoutes.mappings,
      await context.get('repositories').catalog.listEntitlementMappings(),
    );
  });

  app.openapi(apiRoutes.createMapping.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createMapping);
    const body = await validJson(context, createMappingSchema);
    const mapping = await catalogService(context).createMapping(
      {
        ...(body.id === undefined ? {} : { id: body.id }),
        sourceGroupId: body.sourceGroupId,
        entitlementIds: body.entitlementIds,
        ...(body.provisioningTargetIds === undefined
          ? {}
          : { provisioningTargetIds: body.provisioningTargetIds }),
        ...(body.validFrom === undefined ? {} : { validFrom: body.validFrom }),
        ...(body.validUntil === undefined ? {} : { validUntil: body.validUntil }),
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createMapping, { data: mapping });
  });

  app.openapi(apiRoutes.mapping.definition, async (context) => {
    authorize(context, apiRoutes.mapping);
    const id = routeParam(context, 'mappingId');
    const mapping = await requireEntity(
      context.get('repositories').catalog.getEntitlementMapping(id),
      'Entitlement mapping',
      id,
    );
    return respond(context, apiRoutes.mapping, { data: mapping });
  });

  app.openapi(apiRoutes.previewMapping.definition, async (context) => {
    const actor = authorize(context, apiRoutes.previewMapping);
    void actor;
    const body = await validJson(
      context,
      z.object({ expectedRevision: z.int().positive() }).strict(),
    );
    const preview = await catalogService(context).previewMapping(
      routeParam(context, 'mappingId'),
      body.expectedRevision,
    );
    return respond(context, apiRoutes.previewMapping, { data: preview });
  });

  app.openapi(apiRoutes.activateMapping.definition, async (context) => {
    const actor = authorize(context, apiRoutes.activateMapping);
    const body = await validJson(
      context,
      z
        .object({
          expectedRevision: z.int().positive(),
          confirmedAffectedSubjectIds: z.array(z.string().min(1).max(160)),
        })
        .strict(),
    );
    const result = await catalogService(context).activateMapping(
      routeParam(context, 'mappingId'),
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.activateMapping, { data: result });
  });

  app.openapi(apiRoutes.retireMapping.definition, async (context) => {
    const actor = authorize(context, apiRoutes.retireMapping);
    const body = await validJson(context, retireMappingSchema);
    const mapping = await catalogService(context).retireMapping(
      routeParam(context, 'mappingId'),
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.retireMapping, { data: mapping });
  });

  app.openapi(apiRoutes.syncRuns.definition, async (context) => {
    authorize(context, apiRoutes.syncRuns);
    return respondList(
      context,
      apiRoutes.syncRuns,
      await context.get('repositories').directory.listDirectorySyncRuns(),
    );
  });

  app.openapi(apiRoutes.syncRun.definition, async (context) => {
    authorize(context, apiRoutes.syncRun);
    const id = routeParam(context, 'syncRunId');
    const repository = context.get('repositories').directory;
    const run = await requireEntity(repository.getDirectorySyncRun(id), 'Directory sync run', id);
    return respond(context, apiRoutes.syncRun, {
      data: { run, violations: await repository.listDirectorySyncViolations(id) },
    });
  });

  app.openapi(apiRoutes.syncGoogle.definition, async (context) => {
    const actor = authorize(context, apiRoutes.syncGoogle);
    const body = await validJson(
      context,
      z.object({ directorySourceId: z.string().min(1).max(160) }).strict(),
    );
    const adapter = new GoogleDirectoryReadAdapter(
      (bindingName) => secretBinding(context.env, bindingName),
      createGoogleTransportFactory(),
    );
    const run = await new DirectorySyncService(
      context.get('repositories'),
      adapter,
      workerServiceRuntime,
    ).synchronize(body.directorySourceId, actorContext(context, actor.id));
    return respond(context, apiRoutes.syncGoogle, { data: run });
  });

  app.openapi(apiRoutes.providerConnections.definition, async (context) => {
    authorize(context, apiRoutes.providerConnections);
    return respondList(
      context,
      apiRoutes.providerConnections,
      await context.get('repositories').provisioning.listProviderConnections(),
    );
  });

  app.openapi(apiRoutes.createProviderConnection.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createProviderConnection);
    const body = await validJson(context, createProviderConnectionSchema);
    const connection = await runtimeConfigurationService(context).createProviderConnection(
      {
        id: body.id,
        provider: body.provider,
        name: body.name,
        mode: body.mode,
        configuration: body.configuration,
        status: body.status,
        ...(body.credentialRef === undefined ? {} : { credentialRef: body.credentialRef }),
      },
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createProviderConnection, { data: connection });
  });

  app.openapi(apiRoutes.providerConnection.definition, async (context) => {
    authorize(context, apiRoutes.providerConnection);
    const id = routeParam(context, 'providerConnectionId');
    const connection = await requireEntity(
      context.get('repositories').provisioning.getProviderConnection(id),
      'Provider Connection',
      id,
    );
    return respond(context, apiRoutes.providerConnection, { data: connection });
  });

  app.openapi(apiRoutes.updateProviderConnection.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateProviderConnection);
    const body = await validJson(context, updateProviderConnectionSchema);
    const connection = await runtimeConfigurationService(context).updateProviderConnection(
      routeParam(context, 'providerConnectionId'),
      {
        name: body.name,
        mode: body.mode,
        configuration: body.configuration,
        status: body.status,
        expectedRevision: body.expectedRevision,
        ...(body.credentialRef === undefined ? {} : { credentialRef: body.credentialRef }),
      },
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateProviderConnection, { data: connection });
  });

  app.openapi(apiRoutes.provisioningTargets.definition, async (context) => {
    authorize(context, apiRoutes.provisioningTargets);
    return respondList(
      context,
      apiRoutes.provisioningTargets,
      await context.get('repositories').provisioning.listProvisioningTargets(),
    );
  });

  app.openapi(apiRoutes.createProvisioningTarget.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createProvisioningTarget);
    const body = await validJson(context, createProvisioningTargetSchema);
    const target = await runtimeConfigurationService(context).createProvisioningTarget(
      body,
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createProvisioningTarget, { data: target });
  });

  app.openapi(apiRoutes.provisioningTarget.definition, async (context) => {
    authorize(context, apiRoutes.provisioningTarget);
    const id = routeParam(context, 'provisioningTargetId');
    const target = await requireEntity(
      context.get('repositories').provisioning.getProvisioningTarget(id),
      'Provisioning Target',
      id,
    );
    return respond(context, apiRoutes.provisioningTarget, { data: target });
  });

  app.openapi(apiRoutes.updateProvisioningTarget.definition, async (context) => {
    const actor = authorize(context, apiRoutes.updateProvisioningTarget);
    const body = await validJson(context, updateProvisioningTargetSchema);
    const target = await runtimeConfigurationService(context).updateProvisioningTarget(
      routeParam(context, 'provisioningTargetId'),
      body,
      configurationActorContext(context, actor.id),
    );
    return respond(context, apiRoutes.updateProvisioningTarget, { data: target });
  });

  app.openapi(apiRoutes.provisioningStates.definition, async (context) => {
    authorize(context, apiRoutes.provisioningStates);
    return respondList(
      context,
      apiRoutes.provisioningStates,
      await context.get('repositories').provisioning.listProvisioningStates(),
    );
  });

  app.openapi(apiRoutes.operationPlans.definition, async (context) => {
    authorize(context, apiRoutes.operationPlans);
    return respondList(
      context,
      apiRoutes.operationPlans,
      await context.get('repositories').provisioning.listOperationPlans(),
    );
  });

  app.openapi(apiRoutes.createOperationPlan.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createOperationPlan);
    const body = await validJson(context, createPlanInputSchema);
    const plan = await reconciliationService(context).createPlan(
      body,
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createOperationPlan, { data: plan });
  });

  app.openapi(apiRoutes.operationPlan.definition, async (context) => {
    authorize(context, apiRoutes.operationPlan);
    const id = routeParam(context, 'planId');
    const repository = context.get('repositories').provisioning;
    const plan = await requireEntity(repository.getOperationPlan(id), 'Operation plan', id);
    return respond(context, apiRoutes.operationPlan, {
      data: { plan, changes: await repository.listOperationPlanChanges(id) },
    });
  });

  app.openapi(apiRoutes.operations.definition, async (context) => {
    authorize(context, apiRoutes.operations);
    return respondList(
      context,
      apiRoutes.operations,
      await context.get('repositories').provisioning.listOperations(),
    );
  });

  app.openapi(apiRoutes.createOperation.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createOperation);
    const body = await validJson(
      context,
      z.object({ planId: z.string().min(1).max(160), confirmed: z.boolean() }).strict(),
    );
    const operation = await reconciliationService(context).startOperation(
      body.planId,
      { confirmed: body.confirmed },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.createOperation, { data: operation });
  });

  app.openapi(apiRoutes.operation.definition, async (context) => {
    authorize(context, apiRoutes.operation);
    const id = routeParam(context, 'operationId');
    const operation = await requireEntity(
      context.get('repositories').provisioning.getOperation(id),
      'Operation',
      id,
    );
    return respond(context, apiRoutes.operation, { data: operation });
  });

  app.openapi(apiRoutes.executeOperation.definition, async (context) => {
    const actor = authorize(context, apiRoutes.executeOperation);
    await validJson(context, z.object({}).strict());
    const operation = await reconciliationService(context).executeOperation(
      routeParam(context, 'operationId'),
      {
        writesEnabled: String(context.env.PROVIDER_WRITES_ENABLED) === 'true',
      },
      actorContext(context, actor.id),
    );
    return respond(context, apiRoutes.executeOperation, { data: operation });
  });

  app.openapi(apiRoutes.auditEvents.definition, async (context) => {
    authorize(context, apiRoutes.auditEvents);
    return respondList(
      context,
      apiRoutes.auditEvents,
      await context.get('repositories').audit.listAuditEvents(),
    );
  });

  app.openapi(apiRoutes.exports.definition, async (context) => {
    authorize(context, apiRoutes.exports);
    return respondList(
      context,
      apiRoutes.exports,
      await context.get('repositories').exports.listExportRecords(),
    );
  });

  app.openapi(apiRoutes.createExport.definition, async (context) => {
    const actor = authorize(context, apiRoutes.createExport);
    const record = await new ExportService(
      context.get('repositories').exports,
      workerServiceRuntime,
    ).request(actorContext(context, actor.id));
    return respond(context, apiRoutes.createExport, { data: record });
  });
}

const createGuestInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    primaryEmail: z.email().optional(),
    sponsorSubjectId: z.string().min(1).max(160),
    externalContactEmail: z.email(),
    externalOrganization: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(500),
    validFrom: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    nextReviewAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const createPlanInputSchema = z
  .object({
    provisioningStateId: z.string().min(1).max(160),
    expectedRevision: z.int().positive(),
  })
  .strict();

const bindExternalIdentityInputSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('google'),
      issuer: z
        .string()
        .regex(/^urn:google-directory:customer:[^:\s]+$/)
        .max(500),
      providerSubject: z.string().regex(/^[A-Za-z0-9_-]{6,128}$/),
      expectedSubjectRevision: z.int().positive(),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      provider: z.literal('github'),
      issuer: z.literal('https://github.com'),
      providerSubject: z.string().regex(/^[1-9][0-9]{0,19}$/),
      expectedSubjectRevision: z.int().positive(),
      confirmed: z.literal(true),
    })
    .strict(),
]);

const grantAdministrationRoleInputSchema = z
  .object({
    role: platformRoleSchema,
    expectedSubjectRevision: z.int().positive(),
  })
  .strict();

const deactivateAdministrationRoleInputSchema = z
  .object({
    expectedRevision: z.int().positive(),
    confirmed: z.literal(true),
  })
  .strict();

function authorize(context: Context<WorkerEnvironment>, route: ApiRouteContract) {
  if (route.allowUnmapped === true) return context.get('subject') ?? requireSubject(context);
  return route.roles.length === 0 ? requireSubject(context) : requireRoles(context, route.roles);
}

function actorContext(
  context: Context<WorkerEnvironment>,
  actorSubjectId: string,
): RequiredActorContext {
  const reason = context.req.header('x-access-control-reason');
  const configurationPlanHash = context.req.header('x-access-control-plan-hash');
  if (configurationPlanHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(configurationPlanHash)) {
    throw new AccessControlError(
      400,
      'invalid_configuration_plan_hash',
      'x-access-control-plan-hash must be a lowercase SHA-256 identifier.',
    );
  }
  return {
    actorSubjectId,
    requestId: context.get('requestId'),
    ...(reason === undefined ? {} : { reason }),
    ...(configurationPlanHash === undefined ? {} : { configurationPlanHash }),
  };
}

function configurationActorContext(
  context: Context<WorkerEnvironment>,
  actorSubjectId: string,
): ConfigurationActorContext {
  return {
    ...actorContext(context, actorSubjectId),
    roles: context.get('roles'),
  };
}

function catalogService(context: Context<WorkerEnvironment>): CatalogService {
  const repositories = context.get('repositories');
  return new CatalogService(
    repositories.catalog,
    repositories.identities,
    workerServiceRuntime,
    repositories.provisioning,
  );
}

function runtimeConfigurationService(
  context: Context<WorkerEnvironment>,
): RuntimeConfigurationService {
  const repositories = context.get('repositories');
  return new RuntimeConfigurationService(
    repositories.identities,
    repositories.directory,
    repositories.catalog,
    repositories.provisioning,
    workerServiceRuntime,
  );
}

function requireAdministratorRole(context: Context<WorkerEnvironment>): void {
  if (!context.get('roles').includes('admin')) {
    throw new AccessControlError(
      403,
      'administrator_required',
      'Automatic mode changes require an administrator.',
    );
  }
}

function reconciliationService(context: Context<WorkerEnvironment>): ReconciliationService {
  const unavailableTransport = {
    observe: async (): Promise<never> => {
      throw new AccessControlError(
        503,
        'provider_transport_unavailable',
        'No production observation transport is configured for this contract-only adapter.',
      );
    },
  };
  const github = new GitHubProvisioningAdapter(
    async () => {
      const credential = secretBinding(context.env, 'GITHUB_CREDENTIAL');
      if (credential === undefined || credential === null || credential === '') {
        throw new AccessControlError(
          503,
          'github_configuration_missing',
          'The GitHub credential binding is unavailable.',
        );
      }
      return createGitHubAppTransport(credential);
    },
    String(context.env.PROVIDER_WRITES_ENABLED) === 'true',
  );
  return new ReconciliationService(
    context.get('repositories').provisioning,
    context.get('repositories').identities,
    context.get('repositories').catalog,
    new Map<string, ProvisioningAdapter>([
      ['github', github],
      ['proxmox', new ProxmoxObservationAdapter(unavailableTransport)],
      ['zabbix', new ZabbixObservationAdapter(unavailableTransport)],
      ['posix', new PosixObservationAdapter(unavailableTransport)],
    ]),
    workerServiceRuntime,
  );
}

async function validJson<T extends z.ZodType>(
  context: Context<WorkerEnvironment>,
  schema: T,
): Promise<z.output<T>> {
  return schema.parse(await context.req.json());
}

function respond(context: Context<WorkerEnvironment>, route: ApiRouteContract, value: unknown) {
  const parsed = jsonValueSchema.parse(route.responseSchema.parse(value));
  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function respondList<T>(context: Context<WorkerEnvironment>, route: ApiRouteContract, values: T[]) {
  const query = paginationQuerySchema.parse(context.req.query());
  const offset = decodeCursor(query.cursor);
  const page = values.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return respond(context, route, {
    data: page,
    pagination: {
      ...(nextOffset < values.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
    },
  });
}

function encodeCursor(offset: number): string {
  return btoa(String(offset));
}

function decodeCursor(cursor?: string): number {
  if (cursor === undefined) return 0;
  try {
    const value = Number(atob(cursor));
    if (!Number.isInteger(value) || value < 0) throw new Error('invalid cursor');
    return value;
  } catch {
    throw new AccessControlError(400, 'invalid_cursor', 'The pagination cursor is invalid.');
  }
}

async function requireEntity<T>(
  promise: Promise<T | null>,
  entity: string,
  id: string,
): Promise<T> {
  const value = await promise;
  if (value === null) throw new NotFoundError(entity, id);
  return value;
}

function secretBinding(env: Env, bindingName: string): unknown {
  return (env as unknown as Record<string, unknown>)[bindingName];
}

function routeParam(context: Context<WorkerEnvironment>, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new AccessControlError(400, 'invalid_path', `Path parameter ${name} is required.`);
  }
  return value;
}
