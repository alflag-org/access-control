import { createRoute, type RouteConfig } from '@hono/zod-openapi';
import { z } from 'zod';
import {
  applicationEntitlementSchema,
  applicationSchema,
  auditEventSchema,
  bindingReferenceSchema,
  directorySourceSchema,
  directorySyncRunSchema,
  directorySyncViolationSchema,
  effectiveGrantSchema,
  entitlementMappingSchema,
  exportRecordSchema,
  externalIdentitySchema,
  guestProfileSchema,
  httpsUrlSchema,
  mappingPreviewSchema,
  operationPlanChangeSchema,
  operationPlanSchema,
  operationSchema,
  organizationSettingsSchema,
  platformRoleGrantSchema,
  platformRoleSchema,
  providerAccountSchema,
  providerConnectionSchema,
  provisioningStateSchema,
  provisioningTargetSchema,
  sourceGroupMembershipSchema,
  sourceGroupSchema,
  subjectSchema,
  type PlatformRole,
} from '@access-control/domain';
import {
  errorResponseSchema,
  paginationQuerySchema,
  paginationSchema,
} from '@access-control/contracts';

const ADMIN_READ_ROLES = ['admin', 'auditor', 'operator'] as const;
const ADMIN_WRITE_ROLES = ['admin', 'operator'] as const;
const ADMIN_ONLY = ['admin'] as const;

const idParamSchema = (name: string) => z.object({ [name]: z.string().min(1).max(160) }).strict();
const emptyObjectSchema = z.object({}).strict();

const sessionSchema = z
  .object({
    principal: z
      .object({
        provider: z.literal('cloudflare_access'),
        issuer: z.string(),
        providerSubject: z.string(),
        canonicalIdentity: z.string(),
        kind: z.enum(['human', 'service']),
      })
      .strict(),
    mapped: z.boolean(),
    subject: subjectSchema.nullable(),
    roles: z.array(platformRoleSchema),
  })
  .strict();

const accountSchema = z
  .object({
    subject: subjectSchema,
    identities: z.array(externalIdentitySchema),
    guestProfile: guestProfileSchema.nullable(),
    roles: z.array(platformRoleSchema),
  })
  .strict();

const guestBundleSchema = z
  .object({ subject: subjectSchema, guestProfile: guestProfileSchema })
  .strict();
const identityBindingSchema = z
  .object({ subject: subjectSchema, identity: externalIdentitySchema })
  .strict();
const mappingActivationSchema = z
  .object({ mapping: entitlementMappingSchema, preview: mappingPreviewSchema })
  .strict();
const planDetailSchema = z
  .object({ plan: operationPlanSchema, changes: z.array(operationPlanChangeSchema) })
  .strict();

export const createApplicationSchema = applicationSchema
  .pick({
    key: true,
    name: true,
    description: true,
    category: true,
    launchUrl: true,
    visibility: true,
    authentication: true,
    provisioningMode: true,
  })
  .extend({ status: z.enum(['active', 'disabled']) })
  .strict();

export const updateApplicationSchema = applicationSchema
  .pick({
    name: true,
    description: true,
    category: true,
    launchUrl: true,
    status: true,
    visibility: true,
    authentication: true,
    provisioningMode: true,
  })
  .extend({
    description: z.string().trim().min(1).max(1_000).nullable().optional(),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const createEntitlementSchema = applicationEntitlementSchema
  .pick({ key: true, name: true, description: true, requiresProvisioning: true })
  .extend({ status: z.enum(['active', 'disabled']).optional() })
  .strict();

export const updateEntitlementSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1_000).nullable().optional(),
    status: z.enum(['active', 'disabled', 'retired']),
    requiresProvisioning: z.boolean(),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const createMappingSchema = z
  .object({
    id: z.string().min(1).max(160).optional(),
    sourceGroupId: z.string().min(1).max(160),
    entitlementIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    provisioningTargetIds: z.array(z.string().min(1).max(160)).max(100).optional(),
    validFrom: z.iso.datetime({ offset: true }).optional(),
    validUntil: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const updateOrganizationSettingsSchema = z
  .object({
    organizationName: z.string().trim().min(1).max(160),
    title: z.string().trim().min(1).max(160),
    supportUrl: httpsUrlSchema.nullable().optional(),
    brandMarkUrl: httpsUrlSchema.nullable().optional(),
    maxPlanChanges: z.int().min(1).max(10_000),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const createDirectorySourceSchema = directorySourceSchema
  .pick({
    id: true,
    provider: true,
    customerId: true,
    delegatedAdmin: true,
    credentialRef: true,
    accessGroupPrefix: true,
    status: true,
  })
  .extend({ status: z.enum(['active', 'disabled']) })
  .strict();

export const updateDirectorySourceSchema = createDirectorySourceSchema
  .omit({ id: true, provider: true })
  .extend({
    status: z.enum(['active', 'disabled', 'retired']),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const createProviderConnectionSchema = providerConnectionSchema
  .pick({
    id: true,
    provider: true,
    name: true,
    mode: true,
    credentialRef: true,
    configuration: true,
    status: true,
  })
  .extend({ status: z.enum(['active', 'disabled']) })
  .strict();

export const updateProviderConnectionSchema = createProviderConnectionSchema
  .omit({ id: true, provider: true, credentialRef: true })
  .extend({
    credentialRef: bindingReferenceSchema.nullable().optional(),
    status: z.enum(['active', 'disabled', 'retired']),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const createProvisioningTargetSchema = provisioningTargetSchema
  .pick({
    id: true,
    providerConnectionId: true,
    applicationEntitlementId: true,
    targetType: true,
    providerTargetId: true,
    mode: true,
    protected: true,
    configuration: true,
    status: true,
  })
  .extend({ status: z.enum(['active', 'disabled']) })
  .strict();

export const updateProvisioningTargetSchema = createProvisioningTargetSchema
  .omit({
    id: true,
    providerConnectionId: true,
    targetType: true,
    providerTargetId: true,
  })
  .extend({
    status: z.enum(['active', 'disabled', 'retired']),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const retireMappingSchema = z.object({ expectedRevision: z.int().positive() }).strict();

const createGuestSchema = z
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

const subjectStatusSchema = z
  .object({
    status: z.enum(['pending', 'active', 'suspended', 'retired']),
    expectedRevision: z.int().positive(),
    confirmed: z.boolean(),
  })
  .strict();

export const updateSubjectProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160),
    primaryEmail: z.email().nullable().optional(),
    expectedRevision: z.int().positive(),
  })
  .strict();

export const updateManagedGuestProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    primaryEmail: z.email().nullable().optional(),
    externalContactEmail: z.email(),
    externalOrganization: z.string().trim().min(1).max(160),
    purpose: z.string().trim().min(1).max(500),
    expectedSubjectRevision: z.int().positive(),
    expectedGuestRevision: z.int().positive(),
  })
  .strict();

const bindExternalIdentitySchema = z.discriminatedUnion('provider', [
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

const suspendGuestSchema = z
  .object({
    expectedSubjectRevision: z.int().positive(),
    expectedGuestRevision: z.int().positive(),
    confirmed: z.literal(true),
  })
  .strict();

const grantAdministrationRoleSchema = z
  .object({
    role: platformRoleSchema,
    expectedSubjectRevision: z.int().positive(),
  })
  .strict();
const deactivateAdministrationRoleSchema = z
  .object({
    expectedRevision: z.int().positive(),
    confirmed: z.literal(true),
  })
  .strict();

const mappingPreviewRequestSchema = z.object({ expectedRevision: z.int().positive() }).strict();
const mappingActivationRequestSchema = mappingPreviewRequestSchema
  .extend({ confirmedAffectedSubjectIds: z.array(z.string().min(1).max(160)) })
  .strict();

const createPlanSchema = z
  .object({
    provisioningStateId: z.string().min(1).max(160),
    expectedRevision: z.int().positive(),
  })
  .strict();

const createOperationSchema = z
  .object({ planId: z.string().min(1).max(160), confirmed: z.boolean() })
  .strict();
const executeOperationSchema = emptyObjectSchema;

type ApiMethod = 'get' | 'patch' | 'post';

export interface ApiRouteContract {
  definition: RouteConfig;
  roles: readonly PlatformRole[];
  responseSchema: z.ZodType;
  allowUnmapped?: boolean;
}

function apiRoute(input: {
  method: ApiMethod;
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  roles: readonly PlatformRole[];
  responseSchema: z.ZodType;
  request?: RouteConfig['request'];
  mutation?: boolean;
  allowUnmapped?: boolean;
}): ApiRouteContract {
  const definition = createRoute({
    method: input.method,
    path: input.path,
    operationId: input.operationId,
    summary: input.summary,
    description: input.description,
    tags: input.tags,
    security: [{ CloudflareAccess: [] }],
    'x-required-roles': input.roles,
    ...(input.request === undefined ? {} : { request: input.request }),
    responses: {
      200: jsonResponse(input.responseSchema, 'Successful response.'),
      401: jsonResponse(errorResponseSchema, 'Cloudflare Access authentication failed.'),
      403: jsonResponse(errorResponseSchema, 'Subject mapping, role, or origin rejected.'),
      ...(input.path.includes('{')
        ? { 404: jsonResponse(errorResponseSchema, 'The requested entity was not found.') }
        : {}),
      ...(input.mutation
        ? {
            400: jsonResponse(errorResponseSchema, 'The request body or parameters were invalid.'),
            409: jsonResponse(errorResponseSchema, 'A revision or safety invariant conflicted.'),
            422: jsonResponse(errorResponseSchema, 'Domain or provider validation failed.'),
          }
        : {}),
      503: jsonResponse(
        errorResponseSchema,
        'A required configuration or dependency is unavailable.',
      ),
    },
  } as RouteConfig);
  return {
    definition,
    roles: input.roles,
    responseSchema: input.responseSchema,
    ...(input.allowUnmapped === true ? { allowUnmapped: true } : {}),
  };
}

function jsonResponse(schema: z.ZodType, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

function dataSchema<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema }).strict();
}

function listSchema<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema), pagination: paginationSchema }).strict();
}

function listRequest(): RouteConfig['request'] {
  return { query: paginationQuerySchema };
}

function bodyRequest(schema: z.ZodType): RouteConfig['request'] {
  return {
    body: {
      required: true,
      content: { 'application/json': { schema } },
    },
  };
}

function pathRequest(name: string): RouteConfig['request'] {
  return { params: idParamSchema(name) };
}

function pathAndBodyRequest(name: string, schema: z.ZodType): RouteConfig['request'] {
  return { ...pathRequest(name), ...bodyRequest(schema) };
}

function applicationEntitlementRequest(schema?: z.ZodType): RouteConfig['request'] {
  const request: RouteConfig['request'] = {
    params: z
      .object({
        applicationId: z.string().min(1).max(160),
        entitlementId: z.string().min(1).max(160),
      })
      .strict(),
  };
  return schema === undefined ? request : { ...request, ...bodyRequest(schema) };
}

function pathAndListRequest(name: string): RouteConfig['request'] {
  return { params: idParamSchema(name), query: paginationQuerySchema };
}

export const apiRoutes = {
  session: apiRoute({
    method: 'get',
    path: '/api/v1/auth/session',
    operationId: 'getAuthSession',
    summary: 'Get the authenticated session',
    description: 'Returns the verified Access principal and optional mapped Subject.',
    tags: ['Authentication'],
    roles: [],
    responseSchema: dataSchema(sessionSchema),
    allowUnmapped: true,
  }),
  me: apiRoute({
    method: 'get',
    path: '/api/v1/me',
    operationId: 'getMyAccount',
    summary: 'Get my account',
    description: 'Returns the active Subject, identities, roles, and optional guest profile.',
    tags: ['Portal'],
    roles: [],
    responseSchema: dataSchema(accountSchema),
  }),
  myApplications: apiRoute({
    method: 'get',
    path: '/api/v1/me/applications',
    operationId: 'listMyApplications',
    summary: 'List my applications',
    description: 'Lists active applications visible to or entitled for the current Subject.',
    tags: ['Portal'],
    roles: [],
    request: listRequest(),
    responseSchema: listSchema(applicationSchema),
  }),
  myEntitlements: apiRoute({
    method: 'get',
    path: '/api/v1/me/entitlements',
    operationId: 'listMyEntitlements',
    summary: 'List my effective grants',
    description: 'Lists effective entitlements with source-group and membership provenance.',
    tags: ['Portal'],
    roles: [],
    request: listRequest(),
    responseSchema: listSchema(effectiveGrantSchema),
  }),
  myProviderAccounts: apiRoute({
    method: 'get',
    path: '/api/v1/me/provider-accounts',
    operationId: 'listMyProviderAccounts',
    summary: 'List my provider accounts',
    description: 'Lists observed downstream provider accounts for the current Subject.',
    tags: ['Portal'],
    roles: [],
    request: listRequest(),
    responseSchema: listSchema(providerAccountSchema),
  }),
  subjects: apiRoute({
    method: 'get',
    path: '/api/v1/subjects',
    operationId: 'listSubjects',
    summary: 'List Subjects',
    description: 'Lists governed people, services, and workloads without hard-deleted history.',
    tags: ['Subjects'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(subjectSchema),
  }),
  subject: apiRoute({
    method: 'get',
    path: '/api/v1/subjects/{subjectId}',
    operationId: 'getSubject',
    summary: 'Get a Subject',
    description: 'Returns one Subject by stable identifier.',
    tags: ['Subjects'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('subjectId'),
    responseSchema: dataSchema(subjectSchema),
  }),
  updateSubject: apiRoute({
    method: 'patch',
    path: '/api/v1/subjects/{subjectId}',
    operationId: 'updateSubjectStatus',
    summary: 'Update Subject status',
    description: 'Changes lifecycle status with expected revision and deactivation confirmation.',
    tags: ['Subjects'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', subjectStatusSchema),
    responseSchema: dataSchema(subjectSchema),
    mutation: true,
  }),
  updateSubjectProfile: apiRoute({
    method: 'patch',
    path: '/api/v1/subjects/{subjectId}/profile',
    operationId: 'updateSubjectProfile',
    summary: 'Update Subject profile',
    description:
      'Changes a locally managed Subject display name and optional primary email with an expected revision.',
    tags: ['Subjects'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', updateSubjectProfileSchema),
    responseSchema: dataSchema(subjectSchema),
    mutation: true,
  }),
  subjectIdentities: apiRoute({
    method: 'get',
    path: '/api/v1/subjects/{subjectId}/identities',
    operationId: 'listSubjectIdentities',
    summary: 'List Subject identities',
    description: 'Lists immutable external identity bindings for one Subject.',
    tags: ['Subjects'],
    roles: ADMIN_READ_ROLES,
    request: pathAndListRequest('subjectId'),
    responseSchema: listSchema(externalIdentitySchema),
  }),
  bindSubjectIdentity: apiRoute({
    method: 'post',
    path: '/api/v1/subjects/{subjectId}/identities',
    operationId: 'bindSubjectIdentity',
    summary: 'Bind an immutable Subject identity',
    description:
      'Binds an administrator-confirmed Google Directory user ID or GitHub numeric user ID to a managed guest.',
    tags: ['Subjects'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', bindExternalIdentitySchema),
    responseSchema: dataSchema(identityBindingSchema),
    mutation: true,
  }),
  subjectRoleGrants: apiRoute({
    method: 'get',
    path: '/api/v1/subjects/{subjectId}/platform-role-grants',
    operationId: 'listSubjectPlatformRoleGrants',
    summary: 'List Subject administration roles',
    description: 'Lists active and inactive administration role grants for one Subject.',
    tags: ['Subjects'],
    roles: ADMIN_READ_ROLES,
    request: pathAndListRequest('subjectId'),
    responseSchema: listSchema(platformRoleGrantSchema),
  }),
  grantSubjectRole: apiRoute({
    method: 'post',
    path: '/api/v1/subjects/{subjectId}/platform-role-grants',
    operationId: 'grantSubjectPlatformRole',
    summary: 'Grant a Subject administration role',
    description:
      'Creates or reactivates an administrator, operator, or auditor grant for an active Subject.',
    tags: ['Subjects'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', grantAdministrationRoleSchema),
    responseSchema: dataSchema(platformRoleGrantSchema),
    mutation: true,
  }),
  deactivateRoleGrant: apiRoute({
    method: 'patch',
    path: '/api/v1/platform-role-grants/{roleGrantId}',
    operationId: 'deactivatePlatformRoleGrant',
    summary: 'Deactivate an administration role',
    description:
      'Deactivates one administration role grant while D1 preserves the final active administrator.',
    tags: ['Subjects'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('roleGrantId', deactivateAdministrationRoleSchema),
    responseSchema: dataSchema(platformRoleGrantSchema),
    mutation: true,
  }),
  guests: apiRoute({
    method: 'get',
    path: '/api/v1/guests',
    operationId: 'listGuests',
    summary: 'List managed guests',
    description: 'Lists guest sponsorship, expiration, review, and lifecycle records.',
    tags: ['Guests'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(guestProfileSchema),
  }),
  createGuest: apiRoute({
    method: 'post',
    path: '/api/v1/guests',
    operationId: 'createManagedGuest',
    summary: 'Create a managed guest',
    description: 'Creates a pending managed guest with an active sponsor and future expiration.',
    tags: ['Guests'],
    roles: ADMIN_ONLY,
    request: bodyRequest(createGuestSchema),
    responseSchema: dataSchema(guestBundleSchema),
    mutation: true,
  }),
  guest: apiRoute({
    method: 'get',
    path: '/api/v1/guests/{subjectId}',
    operationId: 'getManagedGuest',
    summary: 'Get a managed guest',
    description: 'Returns one managed guest profile and Subject.',
    tags: ['Guests'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('subjectId'),
    responseSchema: dataSchema(guestBundleSchema),
  }),
  suspendGuest: apiRoute({
    method: 'patch',
    path: '/api/v1/guests/{subjectId}',
    operationId: 'suspendManagedGuest',
    summary: 'Suspend a managed guest',
    description: 'Atomically suspends Subject and guest records with two expected revisions.',
    tags: ['Guests'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', suspendGuestSchema),
    responseSchema: dataSchema(guestBundleSchema),
    mutation: true,
  }),
  updateGuestProfile: apiRoute({
    method: 'patch',
    path: '/api/v1/guests/{subjectId}/profile',
    operationId: 'updateManagedGuestProfile',
    summary: 'Update managed guest profile',
    description:
      'Changes locally managed guest profile and contact fields atomically with two expected revisions.',
    tags: ['Guests'],
    roles: ADMIN_ONLY,
    request: pathAndBodyRequest('subjectId', updateManagedGuestProfileSchema),
    responseSchema: dataSchema(guestBundleSchema),
    mutation: true,
  }),
  organizationSettings: apiRoute({
    method: 'get',
    path: '/api/v1/organization-settings',
    operationId: 'getOrganizationSettings',
    summary: 'Get organization settings',
    description: 'Returns the singleton organization presentation and plan safety settings.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    responseSchema: dataSchema(organizationSettingsSchema),
  }),
  updateOrganizationSettings: apiRoute({
    method: 'patch',
    path: '/api/v1/organization-settings',
    operationId: 'updateOrganizationSettings',
    summary: 'Update organization settings',
    description: 'Updates administrator-only organization settings with expected revision.',
    tags: ['Configuration'],
    roles: ADMIN_ONLY,
    request: bodyRequest(updateOrganizationSettingsSchema),
    responseSchema: dataSchema(organizationSettingsSchema),
    mutation: true,
  }),
  directorySources: apiRoute({
    method: 'get',
    path: '/api/v1/directory-sources',
    operationId: 'listDirectorySources',
    summary: 'List directory sources',
    description: 'Lists declaratively managed Directory Sources without credential values.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(directorySourceSchema),
  }),
  createDirectorySource: apiRoute({
    method: 'post',
    path: '/api/v1/directory-sources',
    operationId: 'createDirectorySource',
    summary: 'Create a directory source',
    description: 'Creates a Directory Source using a runtime credential binding reference.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createDirectorySourceSchema),
    responseSchema: dataSchema(directorySourceSchema),
    mutation: true,
  }),
  directorySource: apiRoute({
    method: 'get',
    path: '/api/v1/directory-sources/{directorySourceId}',
    operationId: 'getDirectorySource',
    summary: 'Get a directory source',
    description: 'Returns one Directory Source and its current revision.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('directorySourceId'),
    responseSchema: dataSchema(directorySourceSchema),
  }),
  updateDirectorySource: apiRoute({
    method: 'patch',
    path: '/api/v1/directory-sources/{directorySourceId}',
    operationId: 'updateDirectorySource',
    summary: 'Update a directory source',
    description: 'Updates mutable Directory Source fields with expected revision.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('directorySourceId', updateDirectorySourceSchema),
    responseSchema: dataSchema(directorySourceSchema),
    mutation: true,
  }),
  sourceGroups: apiRoute({
    method: 'get',
    path: '/api/v1/source-groups',
    operationId: 'listSourceGroups',
    summary: 'List source groups',
    description: 'Lists normalized Google groups and lifecycle state.',
    tags: ['Directory'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(sourceGroupSchema),
  }),
  sourceGroup: apiRoute({
    method: 'get',
    path: '/api/v1/source-groups/{groupId}',
    operationId: 'getSourceGroup',
    summary: 'Get a source group',
    description: 'Returns one normalized source group.',
    tags: ['Directory'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('groupId'),
    responseSchema: dataSchema(sourceGroupSchema),
  }),
  sourceGroupMembers: apiRoute({
    method: 'get',
    path: '/api/v1/source-groups/{groupId}/members',
    operationId: 'listSourceGroupMembers',
    summary: 'List direct source-group members',
    description: 'Lists observed direct members without nested group expansion.',
    tags: ['Directory'],
    roles: ADMIN_READ_ROLES,
    request: pathAndListRequest('groupId'),
    responseSchema: listSchema(sourceGroupMembershipSchema),
  }),
  applications: apiRoute({
    method: 'get',
    path: '/api/v1/applications',
    operationId: 'listApplications',
    summary: 'List applications',
    description: 'Lists configured application portal entries.',
    tags: ['Applications'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(applicationSchema),
  }),
  createApplication: apiRoute({
    method: 'post',
    path: '/api/v1/applications',
    operationId: 'createApplication',
    summary: 'Create an application',
    description:
      'Creates an application with an immutable key and explicit authentication reference.',
    tags: ['Applications'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createApplicationSchema),
    responseSchema: dataSchema(applicationSchema),
    mutation: true,
  }),
  application: apiRoute({
    method: 'get',
    path: '/api/v1/applications/{applicationId}',
    operationId: 'getApplication',
    summary: 'Get an application',
    description: 'Returns one application.',
    tags: ['Applications'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('applicationId'),
    responseSchema: dataSchema(applicationSchema),
  }),
  updateApplication: apiRoute({
    method: 'patch',
    path: '/api/v1/applications/{applicationId}',
    operationId: 'updateApplication',
    summary: 'Update an application',
    description: 'Updates mutable application fields with expected revision.',
    tags: ['Applications'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('applicationId', updateApplicationSchema),
    responseSchema: dataSchema(applicationSchema),
    mutation: true,
  }),
  applicationEntitlements: apiRoute({
    method: 'get',
    path: '/api/v1/applications/{applicationId}/entitlements',
    operationId: 'listApplicationEntitlements',
    summary: 'List application entitlements',
    description: 'Lists roles and entitlements for one application.',
    tags: ['Applications'],
    roles: ADMIN_READ_ROLES,
    request: pathAndListRequest('applicationId'),
    responseSchema: listSchema(applicationEntitlementSchema),
  }),
  createApplicationEntitlement: apiRoute({
    method: 'post',
    path: '/api/v1/applications/{applicationId}/entitlements',
    operationId: 'createApplicationEntitlement',
    summary: 'Create an application entitlement',
    description: 'Creates an immutable entitlement key for one application.',
    tags: ['Applications'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('applicationId', createEntitlementSchema),
    responseSchema: dataSchema(applicationEntitlementSchema),
    mutation: true,
  }),
  updateApplicationEntitlement: apiRoute({
    method: 'patch',
    path: '/api/v1/applications/{applicationId}/entitlements/{entitlementId}',
    operationId: 'updateApplicationEntitlement',
    summary: 'Update an application entitlement',
    description:
      'Updates mutable entitlement fields with expected revision; its key stays immutable.',
    tags: ['Applications'],
    roles: ADMIN_WRITE_ROLES,
    request: applicationEntitlementRequest(updateEntitlementSchema),
    responseSchema: dataSchema(applicationEntitlementSchema),
    mutation: true,
  }),
  mappings: apiRoute({
    method: 'get',
    path: '/api/v1/mappings',
    operationId: 'listEntitlementMappings',
    summary: 'List entitlement mappings',
    description: 'Lists source-group to entitlement mappings.',
    tags: ['Mappings'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(entitlementMappingSchema),
  }),
  createMapping: apiRoute({
    method: 'post',
    path: '/api/v1/mappings',
    operationId: 'createEntitlementMapping',
    summary: 'Create an entitlement mapping',
    description:
      'Creates a draft mapping; activation requires a separate affected-Subjects preview.',
    tags: ['Mappings'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createMappingSchema),
    responseSchema: dataSchema(entitlementMappingSchema),
    mutation: true,
  }),
  mapping: apiRoute({
    method: 'get',
    path: '/api/v1/mappings/{mappingId}',
    operationId: 'getEntitlementMapping',
    summary: 'Get an entitlement mapping',
    description: 'Returns one mapping and its current revision.',
    tags: ['Mappings'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('mappingId'),
    responseSchema: dataSchema(entitlementMappingSchema),
  }),
  previewMapping: apiRoute({
    method: 'post',
    path: '/api/v1/mappings/{mappingId}/preview',
    operationId: 'previewEntitlementMapping',
    summary: 'Preview mapping activation',
    description: 'Calculates affected Subjects without changing the active grant set.',
    tags: ['Mappings'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('mappingId', mappingPreviewRequestSchema),
    responseSchema: dataSchema(mappingPreviewSchema),
    mutation: true,
  }),
  activateMapping: apiRoute({
    method: 'post',
    path: '/api/v1/mappings/{mappingId}/activate',
    operationId: 'activateEntitlementMapping',
    summary: 'Activate a mapping',
    description: 'Activates only when the confirmed affected Subject set still matches preview.',
    tags: ['Mappings'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('mappingId', mappingActivationRequestSchema),
    responseSchema: dataSchema(mappingActivationSchema),
    mutation: true,
  }),
  retireMapping: apiRoute({
    method: 'post',
    path: '/api/v1/mappings/{mappingId}/retire',
    operationId: 'retireEntitlementMapping',
    summary: 'Retire an entitlement mapping',
    description: 'Retires a mapping and recalculates affected grants without deleting history.',
    tags: ['Mappings'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('mappingId', retireMappingSchema),
    responseSchema: dataSchema(entitlementMappingSchema),
    mutation: true,
  }),
  syncRuns: apiRoute({
    method: 'get',
    path: '/api/v1/sync-runs',
    operationId: 'listDirectorySyncRuns',
    summary: 'List directory sync runs',
    description: 'Lists complete, failed, and running authoritative snapshot attempts.',
    tags: ['Directory'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(directorySyncRunSchema),
  }),
  syncRun: apiRoute({
    method: 'get',
    path: '/api/v1/sync-runs/{syncRunId}',
    operationId: 'getDirectorySyncRun',
    summary: 'Get a directory sync run',
    description: 'Returns a run and its recorded validation violations.',
    tags: ['Directory'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('syncRunId'),
    responseSchema: dataSchema(
      z
        .object({ run: directorySyncRunSchema, violations: z.array(directorySyncViolationSchema) })
        .strict(),
    ),
  }),
  syncGoogle: apiRoute({
    method: 'post',
    path: '/api/v1/sync-runs/google-directory',
    operationId: 'synchronizeGoogleDirectory',
    summary: 'Synchronize Google Directory',
    description: 'Reads and validates a complete paginated snapshot before atomic publication.',
    tags: ['Directory'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(z.object({ directorySourceId: z.string().min(1).max(160) }).strict()),
    responseSchema: dataSchema(directorySyncRunSchema),
    mutation: true,
  }),
  providerConnections: apiRoute({
    method: 'get',
    path: '/api/v1/provider-connections',
    operationId: 'listProviderConnections',
    summary: 'List provider connections',
    description: 'Lists provider connection modes and non-secret configuration.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(providerConnectionSchema),
  }),
  createProviderConnection: apiRoute({
    method: 'post',
    path: '/api/v1/provider-connections',
    operationId: 'createProviderConnection',
    summary: 'Create a provider connection',
    description: 'Creates a Provider Connection with non-secret configuration.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createProviderConnectionSchema),
    responseSchema: dataSchema(providerConnectionSchema),
    mutation: true,
  }),
  providerConnection: apiRoute({
    method: 'get',
    path: '/api/v1/provider-connections/{providerConnectionId}',
    operationId: 'getProviderConnection',
    summary: 'Get a provider connection',
    description: 'Returns one Provider Connection and its current revision.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('providerConnectionId'),
    responseSchema: dataSchema(providerConnectionSchema),
  }),
  updateProviderConnection: apiRoute({
    method: 'patch',
    path: '/api/v1/provider-connections/{providerConnectionId}',
    operationId: 'updateProviderConnection',
    summary: 'Update a provider connection',
    description: 'Updates mutable Provider Connection fields with expected revision.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('providerConnectionId', updateProviderConnectionSchema),
    responseSchema: dataSchema(providerConnectionSchema),
    mutation: true,
  }),
  provisioningTargets: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning-targets',
    operationId: 'listProvisioningTargets',
    summary: 'List provisioning targets',
    description: 'Lists declaratively managed Provisioning Targets.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(provisioningTargetSchema),
  }),
  createProvisioningTarget: apiRoute({
    method: 'post',
    path: '/api/v1/provisioning-targets',
    operationId: 'createProvisioningTarget',
    summary: 'Create a provisioning target',
    description: 'Creates a Provisioning Target for an existing connection and entitlement.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createProvisioningTargetSchema),
    responseSchema: dataSchema(provisioningTargetSchema),
    mutation: true,
  }),
  provisioningTarget: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning-targets/{provisioningTargetId}',
    operationId: 'getProvisioningTarget',
    summary: 'Get a provisioning target',
    description: 'Returns one Provisioning Target and its current revision.',
    tags: ['Configuration'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('provisioningTargetId'),
    responseSchema: dataSchema(provisioningTargetSchema),
  }),
  updateProvisioningTarget: apiRoute({
    method: 'patch',
    path: '/api/v1/provisioning-targets/{provisioningTargetId}',
    operationId: 'updateProvisioningTarget',
    summary: 'Update a provisioning target',
    description: 'Updates mutable Provisioning Target fields with expected revision.',
    tags: ['Configuration'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('provisioningTargetId', updateProvisioningTargetSchema),
    responseSchema: dataSchema(provisioningTargetSchema),
    mutation: true,
  }),
  provisioningStates: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning/states',
    operationId: 'listProvisioningStates',
    summary: 'List provisioning states',
    description:
      'Lists desired, observed, and reconciliation status without hiding provider state.',
    tags: ['Provisioning'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(provisioningStateSchema),
  }),
  operationPlans: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning/plans',
    operationId: 'listOperationPlans',
    summary: 'List immutable operation plans',
    description: 'Lists persisted plan headers and deterministic hashes.',
    tags: ['Provisioning'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(operationPlanSchema),
  }),
  createOperationPlan: apiRoute({
    method: 'post',
    path: '/api/v1/provisioning/plans',
    operationId: 'createOperationPlan',
    summary: 'Create an immutable operation plan',
    description:
      'Loads the current server-authoritative state and observation, calculates a bounded diff, and persists its hash.',
    tags: ['Provisioning'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createPlanSchema),
    responseSchema: dataSchema(operationPlanSchema),
    mutation: true,
  }),
  operationPlan: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning/plans/{planId}',
    operationId: 'getOperationPlan',
    summary: 'Get an operation plan',
    description: 'Returns an immutable plan and its ordered changes.',
    tags: ['Provisioning'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('planId'),
    responseSchema: dataSchema(planDetailSchema),
  }),
  operations: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning/operations',
    operationId: 'listOperations',
    summary: 'List provisioning operations',
    description: 'Lists explicit operation lifecycle state.',
    tags: ['Provisioning'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(operationSchema),
  }),
  createOperation: apiRoute({
    method: 'post',
    path: '/api/v1/provisioning/operations',
    operationId: 'createOperation',
    summary: 'Start an explicit operation',
    description:
      'Starts an operation from an immutable plan; protected plans require confirmation.',
    tags: ['Provisioning'],
    roles: ADMIN_WRITE_ROLES,
    request: bodyRequest(createOperationSchema),
    responseSchema: dataSchema(operationSchema),
    mutation: true,
  }),
  operation: apiRoute({
    method: 'get',
    path: '/api/v1/provisioning/operations/{operationId}',
    operationId: 'getOperation',
    summary: 'Get a provisioning operation',
    description: 'Returns one provisioning operation.',
    tags: ['Provisioning'],
    roles: ADMIN_READ_ROLES,
    request: pathRequest('operationId'),
    responseSchema: dataSchema(operationSchema),
  }),
  executeOperation: apiRoute({
    method: 'post',
    path: '/api/v1/provisioning/operations/{operationId}/execute',
    operationId: 'executeOperation',
    summary: 'Claim and execute a running operation',
    description:
      'Revalidates server-authoritative inputs and atomically claims the operation before persisted step apply and independent verification.',
    tags: ['Provisioning'],
    roles: ADMIN_WRITE_ROLES,
    request: pathAndBodyRequest('operationId', executeOperationSchema),
    responseSchema: dataSchema(operationSchema),
    mutation: true,
  }),
  auditEvents: apiRoute({
    method: 'get',
    path: '/api/v1/audit-events',
    operationId: 'listAuditEvents',
    summary: 'List audit events',
    description: 'Lists append-only mutation and provider evidence records.',
    tags: ['Audit'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(auditEventSchema),
  }),
  exports: apiRoute({
    method: 'get',
    path: '/api/v1/exports',
    operationId: 'listExports',
    summary: 'List portable exports',
    description: 'Lists export requests, object keys, checksums, and completion state.',
    tags: ['Exports'],
    roles: ADMIN_READ_ROLES,
    request: listRequest(),
    responseSchema: listSchema(exportRecordSchema),
  }),
  createExport: apiRoute({
    method: 'post',
    path: '/api/v1/exports',
    operationId: 'requestExport',
    summary: 'Request a portable export',
    description: 'Creates an audited outbox request for Queue-to-R2 materialization.',
    tags: ['Exports'],
    roles: ADMIN_ONLY,
    request: bodyRequest(emptyObjectSchema),
    responseSchema: dataSchema(exportRecordSchema),
    mutation: true,
  }),
} as const;
