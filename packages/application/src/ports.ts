import type {
  Application,
  ApplicationEntitlement,
  AuditEvent,
  DirectorySource,
  DirectorySyncRun,
  DirectorySyncViolation,
  EffectiveGrant,
  EntitlementMapping,
  ExportRecord,
  ExternalIdentity,
  GuestProfile,
  Lock,
  Operation,
  OperationPlan,
  OperationPlanChange,
  OperationStep,
  OrganizationSettings,
  OutboxRecord,
  PlatformRoleGrant,
  ProviderAccount,
  ProviderConnection,
  ProviderObservation,
  ProvisioningState,
  ProvisioningTarget,
  SourceGroup,
  SourceGroupMembership,
  Subject,
} from '@access-control/domain';
import type { AuthoritativePlanContext, PortableExportPayload } from '@access-control/contracts';
import type { MutationRecords } from './events';

export interface BootstrapBundle {
  organizationSettings: OrganizationSettings;
  subject: Subject;
  externalIdentity: ExternalIdentity;
  platformRoleGrant: PlatformRoleGrant;
  mutation: MutationRecords;
}

export interface ManagedGuestBundle {
  subject: Subject;
  guestProfile: GuestProfile;
  mutation: MutationRecords;
}

export interface IdentityRepository {
  getOrganizationSettings(): Promise<OrganizationSettings | null>;
  updateOrganizationSettings(
    settings: OrganizationSettings,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  bootstrap(bundle: BootstrapBundle): Promise<void>;
  getSubject(id: string): Promise<Subject | null>;
  listSubjects(): Promise<Subject[]>;
  findExternalIdentity(
    provider: string,
    issuer: string,
    providerSubject: string,
  ): Promise<ExternalIdentity | null>;
  listExternalIdentities(subjectId?: string): Promise<ExternalIdentity[]>;
  listPlatformRoleGrants(subjectId?: string): Promise<PlatformRoleGrant[]>;
  getGuestProfile(subjectId: string): Promise<GuestProfile | null>;
  listGuestProfiles(): Promise<GuestProfile[]>;
  createManagedGuest(bundle: ManagedGuestBundle): Promise<void>;
  createRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
  ): Promise<void>;
  reactivateRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedGrantRevision: number,
    expectedSubjectRevision: number,
  ): Promise<void>;
  bindExternalIdentity(
    subject: Subject,
    identity: ExternalIdentity,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
  ): Promise<void>;
  updateManagedGuest(
    subject: Subject,
    guestProfile: GuestProfile,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
    expectedGuestRevision: number,
  ): Promise<void>;
  updateSubject(
    subject: Subject,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  updateRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  expireManagedGuestAccess(
    guestProfile: GuestProfile,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
}

export interface CatalogRepository {
  getGrantInputRevision(): Promise<number>;
  getApplication(id: string): Promise<Application | null>;
  listApplications(): Promise<Application[]>;
  createApplication(application: Application, mutation: MutationRecords): Promise<void>;
  updateApplication(
    application: Application,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  getApplicationEntitlement(id: string): Promise<ApplicationEntitlement | null>;
  listApplicationEntitlements(applicationId?: string): Promise<ApplicationEntitlement[]>;
  createApplicationEntitlement(
    entitlement: ApplicationEntitlement,
    mutation: MutationRecords,
  ): Promise<void>;
  updateApplicationEntitlement(
    entitlement: ApplicationEntitlement,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  getSourceGroup(id: string): Promise<SourceGroup | null>;
  listSourceGroups(): Promise<SourceGroup[]>;
  listSourceGroupMemberships(sourceGroupId?: string): Promise<SourceGroupMembership[]>;
  getEntitlementMapping(id: string): Promise<EntitlementMapping | null>;
  listEntitlementMappings(): Promise<EntitlementMapping[]>;
  createEntitlementMapping(mapping: EntitlementMapping, mutation: MutationRecords): Promise<void>;
  activateEntitlementMapping(
    mapping: EntitlementMapping,
    grants: EffectiveGrant[],
    mutation: MutationRecords,
    expectedRevision: number,
    expectedGrantInputRevision: number,
  ): Promise<void>;
  retireEntitlementMapping(
    mapping: EntitlementMapping,
    grants: EffectiveGrant[],
    mutation: MutationRecords,
    expectedRevision: number,
    expectedGrantInputRevision: number,
  ): Promise<void>;
  listEffectiveGrants(subjectId?: string): Promise<EffectiveGrant[]>;
}

export interface DirectoryPublication {
  grantInputRevision: number;
  syncRun: DirectorySyncRun;
  violations: DirectorySyncViolation[];
  subjects: Subject[];
  externalIdentities: ExternalIdentity[];
  sourceGroups: SourceGroup[];
  memberships: SourceGroupMembership[];
  effectiveGrants: EffectiveGrant[];
  mutation: MutationRecords;
}

export interface DirectoryRepository {
  getDirectorySource(id: string): Promise<DirectorySource | null>;
  listDirectorySources(): Promise<DirectorySource[]>;
  createDirectorySource(source: DirectorySource, mutation: MutationRecords): Promise<void>;
  updateDirectorySource(
    source: DirectorySource,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  createDirectorySyncRun(run: DirectorySyncRun, mutation: MutationRecords): Promise<void>;
  publishDirectorySnapshot(publication: DirectoryPublication): Promise<void>;
  failDirectorySyncRun(run: DirectorySyncRun, mutation: MutationRecords): Promise<void>;
  getDirectorySyncRun(id: string): Promise<DirectorySyncRun | null>;
  listDirectorySyncRuns(): Promise<DirectorySyncRun[]>;
  listDirectorySyncViolations(syncRunId?: string): Promise<DirectorySyncViolation[]>;
}

export interface ProvisioningRepository {
  getProviderConnection(id: string): Promise<ProviderConnection | null>;
  listProviderConnections(): Promise<ProviderConnection[]>;
  createProviderConnection(
    connection: ProviderConnection,
    mutation: MutationRecords,
  ): Promise<void>;
  updateProviderConnection(
    connection: ProviderConnection,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  getProviderAccount(id: string): Promise<ProviderAccount | null>;
  listProviderAccounts(subjectId?: string): Promise<ProviderAccount[]>;
  getProvisioningTarget(id: string): Promise<ProvisioningTarget | null>;
  listProvisioningTargets(): Promise<ProvisioningTarget[]>;
  createProvisioningTarget(target: ProvisioningTarget, mutation: MutationRecords): Promise<void>;
  updateProvisioningTarget(
    target: ProvisioningTarget,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  getProvisioningState(id: string): Promise<ProvisioningState | null>;
  listProvisioningStates(subjectId?: string): Promise<ProvisioningState[]>;
  updateProvisioningState(
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  persistObservation(observation: ProviderObservation, mutation: MutationRecords): Promise<void>;
  getLatestCompleteObservation(
    providerConnectionId: string,
    provisioningTargetId: string,
  ): Promise<ProviderObservation | null>;
  listRequiredProvisioningTargets(
    subjectId: string,
    effectiveAt: string,
  ): Promise<ProvisioningTarget[]>;
  getOperationPlan(id: string): Promise<OperationPlan | null>;
  listOperationPlans(): Promise<OperationPlan[]>;
  listOperationPlanChanges(planId: string): Promise<OperationPlanChange[]>;
  persistOperationPlan(
    plan: OperationPlan,
    changes: OperationPlanChange[],
    state: ProvisioningState,
    mutation: MutationRecords,
    authority: AuthoritativePlanContext,
  ): Promise<void>;
  getOperation(id: string): Promise<Operation | null>;
  getOperationByPlanId(planId: string): Promise<Operation | null>;
  listOperations(): Promise<Operation[]>;
  listOperationSteps(operationId: string): Promise<OperationStep[]>;
  createOperation(
    operation: Operation,
    steps: OperationStep[],
    mutation: MutationRecords,
  ): Promise<void>;
  updateOperationStep(
    step: OperationStep,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void>;
  claimOperation(
    operation: Operation,
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedOperationRevision: number,
    expectedStateRevision: number,
    authority: AuthoritativePlanContext,
  ): Promise<boolean>;
  isPlanAuthorityCurrent(authority: AuthoritativePlanContext): Promise<boolean>;
  updateOperationAndState(
    operation: Operation,
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedOperationRevision: number,
    expectedStateRevision: number,
  ): Promise<void>;
  getLock(key: string): Promise<Lock | null>;
  acquireLock(lock: Lock, mutation: MutationRecords): Promise<void>;
}

export interface AuditRepository {
  listAuditEvents(): Promise<AuditEvent[]>;
  getOutboxRecord(id: string): Promise<OutboxRecord | null>;
  listPendingOutboxRecords(limit: number): Promise<OutboxRecord[]>;
  claimOutboxRecord(outboxId: string, claimedAt: string): Promise<OutboxRecord | null>;
  markOutboxDispatched(outboxId: string, deliveredAt: string): Promise<void>;
  markOutboxFailed(outboxId: string, errorCode: string, updatedAt: string): Promise<void>;
  claimOutboxDelivery(
    outboxId: string,
    messageId: string,
    claimedAt: string,
    claimExpiresAt: string,
  ): Promise<'claimed' | 'processing' | 'delivered'>;
  completeOutboxDelivery(outboxId: string, messageId: string, deliveredAt: string): Promise<void>;
  markOutboxDeliveryFailed(
    outboxId: string,
    messageId: string,
    errorCode: string,
    updatedAt: string,
  ): Promise<void>;
}

export interface ExportRepository {
  getExportRecord(id: string): Promise<ExportRecord | null>;
  listExportRecords(): Promise<ExportRecord[]>;
  createExportRecord(record: ExportRecord, mutation: MutationRecords): Promise<void>;
  claimExportRecord(
    exportId: string,
    claimId: string,
    expectedRevision: number,
    claimedAt: string,
  ): Promise<ExportRecord | null>;
  completeExportRecord(
    record: ExportRecord,
    mutation: MutationRecords,
    expectedRevision: number,
    expectedClaimId: string,
  ): Promise<void>;
  buildPortableExportPayload(generatedAt: string): Promise<PortableExportPayload>;
}

export interface AccessControlRepositories {
  identities: IdentityRepository;
  catalog: CatalogRepository;
  directory: DirectoryRepository;
  provisioning: ProvisioningRepository;
  audit: AuditRepository;
  exports: ExportRepository;
}
