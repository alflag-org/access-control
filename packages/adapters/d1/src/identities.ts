import type {
  BootstrapBundle,
  IdentityRepository,
  ManagedGuestBundle,
  MutationRecords,
} from '@access-control/application';
import type {
  ExternalIdentity,
  GuestProfile,
  OrganizationSettings,
  PlatformRoleGrant,
  Subject,
} from '@access-control/domain';
import { D1Client, type SqlValue } from './client';
import {
  mapExternalIdentity,
  mapGuestProfile,
  mapOrganizationSettings,
  mapPlatformRoleGrant,
  mapSubject,
} from './identity-rows';
import { executeBatch, mutationGuardStatements, mutationStatements } from './mutation';
import type { DatabaseRow } from './row-values';

export class D1IdentityRepository extends D1Client implements IdentityRepository {
  public async getOrganizationSettings(): Promise<OrganizationSettings | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM organization_settings LIMIT 1');
    return row === null ? null : mapOrganizationSettings(row);
  }

  public async updateOrganizationSettings(
    settings: OrganizationSettings,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE organization_settings SET
            organization_name = ?, title = ?, support_url = ?, brand_mark_url = ?,
            max_plan_changes = ?, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          settings.organizationName,
          settings.title,
          settings.supportUrl ?? null,
          settings.brandMarkUrl ?? null,
          settings.maxPlanChanges,
          settings.revision,
          settings.updatedAt,
          settings.updatedBy,
          settings.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Organization settings',
    );
  }

  public async bootstrap(bundle: BootstrapBundle): Promise<void> {
    const statements = [
      this.insertSubject(bundle.subject),
      this.insertOrganizationSettings(bundle.organizationSettings),
      this.insertExternalIdentity(bundle.externalIdentity),
      this.insertRoleGrant(bundle.platformRoleGrant),
      this.bumpGrantInputRevision(),
      ...mutationStatements(this.bindStatement, bundle.mutation),
    ];
    await executeBatch(this.db, statements, 0, 'Organization bootstrap');
  }

  public async getSubject(id: string): Promise<Subject | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM subjects WHERE id = ?', id);
    return row === null ? null : mapSubject(row);
  }

  public async listSubjects(): Promise<Subject[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM subjects ORDER BY display_name, id')).map(
      mapSubject,
    );
  }

  public async findExternalIdentity(
    provider: string,
    issuer: string,
    providerSubject: string,
  ): Promise<ExternalIdentity | null> {
    const row = await this.first<DatabaseRow>(
      `SELECT * FROM external_identities
       WHERE provider = ? AND issuer = ? AND provider_subject = ?`,
      provider,
      issuer,
      providerSubject,
    );
    return row === null ? null : mapExternalIdentity(row);
  }

  public async listExternalIdentities(subjectId?: string): Promise<ExternalIdentity[]> {
    const rows =
      subjectId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM external_identities ORDER BY provider, issuer, provider_subject',
          )
        : await this.all<DatabaseRow>(
            'SELECT * FROM external_identities WHERE subject_id = ? ORDER BY provider, issuer, provider_subject',
            subjectId,
          );
    return rows.map(mapExternalIdentity);
  }

  public async listPlatformRoleGrants(subjectId?: string): Promise<PlatformRoleGrant[]> {
    const rows =
      subjectId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM platform_role_grants ORDER BY subject_id, role',
          )
        : await this.all<DatabaseRow>(
            'SELECT * FROM platform_role_grants WHERE subject_id = ? ORDER BY role',
            subjectId,
          );
    return rows.map(mapPlatformRoleGrant);
  }

  public async getGuestProfile(subjectId: string): Promise<GuestProfile | null> {
    const row = await this.first<DatabaseRow>(
      'SELECT * FROM guest_profiles WHERE subject_id = ?',
      subjectId,
    );
    return row === null ? null : mapGuestProfile(row);
  }

  public async listGuestProfiles(): Promise<GuestProfile[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM guest_profiles ORDER BY expires_at, subject_id')
    ).map(mapGuestProfile);
  }

  public async createManagedGuest(bundle: ManagedGuestBundle): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertSubject(bundle.subject),
        this.insertGuestProfile(bundle.guestProfile),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, bundle.mutation),
      ],
      0,
      'Managed guest',
    );
  }

  public async createRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
  ): Promise<void> {
    const guard = this.activeSubjectGuard(
      grant.subjectId,
      expectedSubjectRevision,
      `NOT EXISTS (
        SELECT 1 FROM platform_role_grants WHERE subject_id = ? AND role = ?
      )`,
      [grant.subjectId, grant.role],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.insertRoleGrant(grant),
        ...mutationStatements(this.bindStatement, mutation, {
          sql: 'EXISTS (SELECT 1 FROM platform_role_grants WHERE id = ? AND active = 1)',
          params: [grant.id],
        }),
        guard.after,
      ],
      1,
      'Platform role grant',
    );
  }

  public async reactivateRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedGrantRevision: number,
    expectedSubjectRevision: number,
  ): Promise<void> {
    const guard = this.activeSubjectGuard(
      grant.subjectId,
      expectedSubjectRevision,
      `EXISTS (
        SELECT 1 FROM platform_role_grants
        WHERE id = ? AND subject_id = ? AND role = ? AND active = 0 AND revision = ?
      )`,
      [grant.id, grant.subjectId, grant.role, expectedGrantRevision],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.statement(
          `UPDATE platform_role_grants SET
            active = 1, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND subject_id = ? AND role = ? AND active = 0 AND revision = ?`,
          grant.revision,
          grant.updatedAt,
          grant.updatedBy,
          grant.id,
          grant.subjectId,
          grant.role,
          expectedGrantRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation, {
          sql: 'EXISTS (SELECT 1 FROM platform_role_grants WHERE id = ? AND active = 1 AND revision = ?)',
          params: [grant.id, grant.revision],
        }),
        guard.after,
      ],
      1,
      'Platform role grant',
    );
  }

  public async bindExternalIdentity(
    subject: Subject,
    identity: ExternalIdentity,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
  ): Promise<void> {
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${identity.id}`,
      `EXISTS (
        SELECT 1 FROM subjects WHERE id = ? AND revision = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM external_identities
        WHERE subject_id = ? AND provider = ? AND issuer = ?
          AND status IN ('pending', 'active')
      )`,
      [subject.id, expectedSubjectRevision, subject.id, identity.provider, identity.issuer],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.updateSubjectStatement(subject, expectedSubjectRevision),
        this.insertExternalIdentity(identity),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
        guard.after,
      ],
      1,
      'Subject identity binding',
    );
  }

  public async updateManagedGuest(
    subject: Subject,
    guestProfile: GuestProfile,
    mutation: MutationRecords,
    expectedSubjectRevision: number,
    expectedGuestRevision: number,
  ): Promise<void> {
    const guardId = `guard:${crypto.randomUUID()}`;
    const guard = mutationGuardStatements(
      this.bindStatement,
      guardId,
      `EXISTS (SELECT 1 FROM subjects WHERE id = ? AND revision = ?)
       AND EXISTS (SELECT 1 FROM guest_profiles WHERE subject_id = ? AND revision = ?)`,
      [subject.id, expectedSubjectRevision, guestProfile.subjectId, expectedGuestRevision],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.updateSubjectStatement(subject, expectedSubjectRevision),
        this.statement(
          `UPDATE guest_profiles SET
            sponsor_subject_id = ?, external_contact_email = ?, external_organization = ?,
            purpose = ?, valid_from = ?, expires_at = ?, next_review_at = ?, status = ?,
            revision = ?, updated_at = ?, updated_by = ?
           WHERE subject_id = ? AND revision = ?`,
          guestProfile.sponsorSubjectId,
          guestProfile.externalContactEmail,
          guestProfile.externalOrganization,
          guestProfile.purpose,
          guestProfile.validFrom,
          guestProfile.expiresAt,
          guestProfile.nextReviewAt ?? null,
          guestProfile.status,
          guestProfile.revision,
          guestProfile.updatedAt,
          guestProfile.updatedBy,
          guestProfile.subjectId,
          expectedGuestRevision,
        ),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
        guard.after,
      ],
      0,
      'Managed guest',
    );
  }

  public async updateSubject(
    subject: Subject,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.updateSubjectStatement(subject, expectedRevision),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation, {
          sql: 'EXISTS (SELECT 1 FROM subjects WHERE id = ? AND revision = ?)',
          params: [subject.id, subject.revision],
        }),
      ],
      0,
      'Subject',
    );
  }

  public async updateRoleGrant(
    grant: PlatformRoleGrant,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${crypto.randomUUID()}`,
      `EXISTS (
        SELECT 1 FROM platform_role_grants
        WHERE id = ? AND subject_id = ? AND role = ? AND active = 1 AND revision = ?
      )`,
      [grant.id, grant.subjectId, grant.role, expectedRevision],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.statement(
          `UPDATE platform_role_grants SET
            active = ?, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND active = 1 AND revision = ?`,
          grant.active ? 1 : 0,
          grant.revision,
          grant.updatedAt,
          grant.updatedBy,
          grant.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation, {
          sql: 'EXISTS (SELECT 1 FROM platform_role_grants WHERE id = ? AND revision = ?)',
          params: [grant.id, grant.revision],
        }),
        guard.after,
      ],
      1,
      'Platform role grant',
    );
  }

  public async expireManagedGuestAccess(
    guestProfile: GuestProfile,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE guest_profiles SET
            status = 'expired', revision = ?, updated_at = ?, updated_by = ?
           WHERE subject_id = ? AND revision = ? AND status NOT IN ('expired', 'retired')`,
          guestProfile.revision,
          guestProfile.updatedAt,
          guestProfile.updatedBy,
          guestProfile.subjectId,
          expectedRevision,
        ),
        this.bumpGrantInputRevision(),
        this.statement(
          `UPDATE effective_grants SET status = 'expired'
           WHERE subject_id = ? AND status = 'active'`,
          guestProfile.subjectId,
        ),
        this.statement(
          `UPDATE provisioning_states SET
            desired_state = 'absent', status = 'expired', revision = revision + 1, updated_at = ?
           WHERE subject_id = ? AND (desired_state <> 'absent' OR status <> 'expired')`,
          guestProfile.updatedAt,
          guestProfile.subjectId,
        ),
        ...mutationStatements(this.bindStatement, mutation, {
          sql: 'EXISTS (SELECT 1 FROM guest_profiles WHERE subject_id = ? AND revision = ?)',
          params: [guestProfile.subjectId, guestProfile.revision],
        }),
      ],
      0,
      'Managed guest expiration',
    );
  }

  private readonly bindStatement = (sql: string, ...params: SqlValue[]) =>
    this.statement(sql, ...params);

  private insertOrganizationSettings(settings: OrganizationSettings): D1PreparedStatement {
    return this.statement(
      `INSERT INTO organization_settings (
        id, organization_name, title, support_url, brand_mark_url,
        max_plan_changes, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      settings.id,
      settings.organizationName,
      settings.title,
      settings.supportUrl ?? null,
      settings.brandMarkUrl ?? null,
      settings.maxPlanChanges,
      settings.revision,
      settings.createdAt,
      settings.updatedAt,
      settings.createdBy,
      settings.updatedBy,
    );
  }

  private insertSubject(subject: Subject): D1PreparedStatement {
    return this.statement(
      `INSERT INTO subjects (
        id, kind, classification, display_name, primary_email, status, directory_state,
        protected, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      subject.id,
      subject.kind,
      subject.classification,
      subject.displayName,
      subject.primaryEmail ?? null,
      subject.status,
      subject.directoryState,
      subject.protected ? 1 : 0,
      subject.revision,
      subject.createdAt,
      subject.updatedAt,
      subject.createdBy,
      subject.updatedBy,
    );
  }

  private insertExternalIdentity(identity: ExternalIdentity): D1PreparedStatement {
    return this.statement(
      `INSERT INTO external_identities (
        id, subject_id, provider, issuer, provider_subject, display_name, email, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      identity.id,
      identity.subjectId,
      identity.provider,
      identity.issuer,
      identity.providerSubject,
      identity.displayName ?? null,
      identity.email ?? null,
      identity.status,
      identity.revision,
      identity.createdAt,
      identity.updatedAt,
      identity.createdBy,
      identity.updatedBy,
    );
  }

  private insertGuestProfile(guest: GuestProfile): D1PreparedStatement {
    return this.statement(
      `INSERT INTO guest_profiles (
        subject_id, sponsor_subject_id, external_contact_email, external_organization,
        purpose, valid_from, expires_at, next_review_at, status, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guest.subjectId,
      guest.sponsorSubjectId,
      guest.externalContactEmail,
      guest.externalOrganization,
      guest.purpose,
      guest.validFrom,
      guest.expiresAt,
      guest.nextReviewAt ?? null,
      guest.status,
      guest.revision,
      guest.createdAt,
      guest.updatedAt,
      guest.createdBy,
      guest.updatedBy,
    );
  }

  private insertRoleGrant(grant: PlatformRoleGrant): D1PreparedStatement {
    return this.statement(
      `INSERT INTO platform_role_grants (
        id, subject_id, role, active, protected, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grant.id,
      grant.subjectId,
      grant.role,
      grant.active ? 1 : 0,
      grant.protected ? 1 : 0,
      grant.revision,
      grant.createdAt,
      grant.updatedAt,
      grant.createdBy,
      grant.updatedBy,
    );
  }

  private activeSubjectGuard(
    subjectId: string,
    expectedRevision: number,
    additionalValiditySql: string,
    additionalParams: SqlValue[],
  ) {
    return mutationGuardStatements(
      this.bindStatement,
      `guard:${crypto.randomUUID()}`,
      `EXISTS (
        SELECT 1 FROM subjects WHERE id = ? AND status = 'active' AND revision = ?
      ) AND (${additionalValiditySql})`,
      [subjectId, expectedRevision, ...additionalParams],
    );
  }

  private updateSubjectStatement(subject: Subject, expectedRevision: number): D1PreparedStatement {
    return this.statement(
      `UPDATE subjects SET
        display_name = ?, primary_email = ?, status = ?, directory_state = ?, protected = ?,
        revision = ?, updated_at = ?, updated_by = ?
       WHERE id = ? AND revision = ?`,
      subject.displayName,
      subject.primaryEmail ?? null,
      subject.status,
      subject.directoryState,
      subject.protected ? 1 : 0,
      subject.revision,
      subject.updatedAt,
      subject.updatedBy,
      subject.id,
      expectedRevision,
    );
  }
}
