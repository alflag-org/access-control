import type { CatalogRepository, MutationRecords } from '@access-control/application';
import type {
  Application,
  ApplicationEntitlement,
  EffectiveGrant,
  EntitlementMapping,
  SourceGroup,
  SourceGroupMembership,
} from '@access-control/domain';
import {
  mapApplication,
  mapApplicationEntitlement,
  mapEffectiveGrant,
  mapEntitlementMapping,
} from './catalog-rows';
import { D1Client, type SqlValue } from './client';
import { mapSourceGroup, mapSourceGroupMembership } from './directory-rows';
import { executeBatch, mutationGuardStatements, mutationStatements } from './mutation';
import type { DatabaseRow } from './row-values';

const MAPPING_SELECT = `SELECT mappings.*,
  COALESCE((
    SELECT json_group_array(entitlement_id)
    FROM (
      SELECT entitlement_id FROM entitlement_mapping_entitlements
      WHERE mapping_id = mappings.id ORDER BY entitlement_id
    )
  ), '[]') AS entitlement_ids_json,
  COALESCE((
    SELECT json_group_array(provisioning_target_id)
    FROM (
      SELECT provisioning_target_id FROM entitlement_mapping_targets
      WHERE mapping_id = mappings.id ORDER BY provisioning_target_id
    )
  ), '[]') AS target_ids_json
  FROM entitlement_mappings mappings`;

export class D1CatalogRepository extends D1Client implements CatalogRepository {
  public async getGrantInputRevision(): Promise<number> {
    const row = await this.first<DatabaseRow>(
      "SELECT revision FROM grant_input_versions WHERE name = 'effective_grants'",
    );
    if (row === null || typeof row.revision !== 'number') {
      throw new Error('Effective Grant input revision is unavailable.');
    }
    return row.revision;
  }

  public async getApplication(id: string): Promise<Application | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM applications WHERE id = ?', id);
    return row === null ? null : mapApplication(row);
  }

  public async listApplications(): Promise<Application[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM applications ORDER BY name, id')).map(
      mapApplication,
    );
  }

  public async createApplication(
    application: Application,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertApplication(application),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Application',
    );
  }

  public async updateApplication(
    application: Application,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE applications SET
            name = ?, description = ?, category = ?, launch_url = ?, icon_json = ?, status = ?,
            visibility = ?, authentication_json = ?, provisioning_mode = ?, revision = ?,
            updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          application.name,
          application.description ?? null,
          application.category,
          application.launchUrl,
          application.icon === undefined ? null : JSON.stringify(application.icon),
          application.status,
          application.visibility,
          JSON.stringify(application.authentication),
          application.provisioningMode,
          application.revision,
          application.updatedAt,
          application.updatedBy,
          application.id,
          expectedRevision,
        ),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Application',
    );
  }

  public async getApplicationEntitlement(id: string): Promise<ApplicationEntitlement | null> {
    const row = await this.first<DatabaseRow>(
      'SELECT * FROM application_entitlements WHERE id = ?',
      id,
    );
    return row === null ? null : mapApplicationEntitlement(row);
  }

  public async listApplicationEntitlements(
    applicationId?: string,
  ): Promise<ApplicationEntitlement[]> {
    const rows =
      applicationId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM application_entitlements ORDER BY application_id, name, id',
          )
        : await this.all<DatabaseRow>(
            'SELECT * FROM application_entitlements WHERE application_id = ? ORDER BY name, id',
            applicationId,
          );
    return rows.map(mapApplicationEntitlement);
  }

  public async createApplicationEntitlement(
    entitlement: ApplicationEntitlement,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertApplicationEntitlement(entitlement),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Application entitlement',
    );
  }

  public async updateApplicationEntitlement(
    entitlement: ApplicationEntitlement,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE application_entitlements SET
            name = ?, description = ?, status = ?, requires_provisioning = ?, revision = ?,
            updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          entitlement.name,
          entitlement.description ?? null,
          entitlement.status,
          entitlement.requiresProvisioning ? 1 : 0,
          entitlement.revision,
          entitlement.updatedAt,
          entitlement.updatedBy,
          entitlement.id,
          expectedRevision,
        ),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Application entitlement',
    );
  }

  public async getSourceGroup(id: string): Promise<SourceGroup | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM source_groups WHERE id = ?', id);
    return row === null ? null : mapSourceGroup(row);
  }

  public async listSourceGroups(): Promise<SourceGroup[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM source_groups ORDER BY email, id')).map(
      mapSourceGroup,
    );
  }

  public async listSourceGroupMemberships(
    sourceGroupId?: string,
  ): Promise<SourceGroupMembership[]> {
    const rows =
      sourceGroupId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM source_group_memberships ORDER BY source_group_id, provider_membership_id',
          )
        : await this.all<DatabaseRow>(
            `SELECT * FROM source_group_memberships
             WHERE source_group_id = ? ORDER BY provider_membership_id`,
            sourceGroupId,
          );
    return rows.map(mapSourceGroupMembership);
  }

  public async getEntitlementMapping(id: string): Promise<EntitlementMapping | null> {
    const row = await this.first<DatabaseRow>(`${MAPPING_SELECT} WHERE mappings.id = ?`, id);
    return row === null ? null : mapEntitlementMapping(row);
  }

  public async listEntitlementMappings(): Promise<EntitlementMapping[]> {
    return (await this.all<DatabaseRow>(`${MAPPING_SELECT} ORDER BY mappings.id`)).map(
      mapEntitlementMapping,
    );
  }

  public async createEntitlementMapping(
    mapping: EntitlementMapping,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertEntitlementMapping(mapping),
        ...mapping.entitlementIds.map((entitlementId) =>
          this.statement(
            'INSERT INTO entitlement_mapping_entitlements (mapping_id, entitlement_id) VALUES (?, ?)',
            mapping.id,
            entitlementId,
          ),
        ),
        ...mapping.provisioningTargetIds.map((targetId) =>
          this.statement(
            'INSERT INTO entitlement_mapping_targets (mapping_id, provisioning_target_id) VALUES (?, ?)',
            mapping.id,
            targetId,
          ),
        ),
        this.bumpGrantInputRevision(),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Entitlement mapping',
    );
  }

  public async activateEntitlementMapping(
    mapping: EntitlementMapping,
    grants: EffectiveGrant[],
    mutation: MutationRecords,
    expectedRevision: number,
    expectedGrantInputRevision: number,
  ): Promise<void> {
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${crypto.randomUUID()}`,
      `EXISTS (
        SELECT 1 FROM entitlement_mappings WHERE id = ? AND revision = ?
      ) AND EXISTS (
        SELECT 1 FROM grant_input_versions
        WHERE name = 'effective_grants' AND revision = ?
      )`,
      [mapping.id, expectedRevision, expectedGrantInputRevision],
    );
    const statements = [
      guard.before,
      this.statement(
        `UPDATE entitlement_mappings SET
          status = ?, valid_from = ?, valid_until = ?, revision = ?, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM grant_input_versions
             WHERE name = 'effective_grants' AND revision = ?
           )`,
        mapping.status,
        mapping.validFrom ?? null,
        mapping.validUntil ?? null,
        mapping.revision,
        mapping.updatedAt,
        mapping.updatedBy,
        mapping.id,
        expectedRevision,
        expectedGrantInputRevision,
      ),
      this.bumpGrantInputRevision(),
      this.statement(`UPDATE effective_grants SET status = 'expired' WHERE status = 'active'`),
      ...grants.map((grant) => this.upsertEffectiveGrant(grant)),
      ...mutationStatements(this.bindStatement, mutation),
      guard.after,
    ];
    await executeBatch(this.db, statements, 1, 'Entitlement mapping');
  }

  public async retireEntitlementMapping(
    mapping: EntitlementMapping,
    grants: EffectiveGrant[],
    mutation: MutationRecords,
    expectedRevision: number,
    expectedGrantInputRevision: number,
  ): Promise<void> {
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${crypto.randomUUID()}`,
      `EXISTS (
        SELECT 1 FROM entitlement_mappings
        WHERE id = ? AND revision = ? AND status <> 'retired'
      ) AND EXISTS (
        SELECT 1 FROM grant_input_versions
        WHERE name = 'effective_grants' AND revision = ?
      )`,
      [mapping.id, expectedRevision, expectedGrantInputRevision],
    );
    const statements = [
      guard.before,
      this.statement(
        `UPDATE entitlement_mappings SET
          status = 'retired', revision = ?, updated_at = ?, updated_by = ?
         WHERE id = ? AND revision = ? AND status <> 'retired'
           AND EXISTS (
             SELECT 1 FROM grant_input_versions
             WHERE name = 'effective_grants' AND revision = ?
           )`,
        mapping.revision,
        mapping.updatedAt,
        mapping.updatedBy,
        mapping.id,
        expectedRevision,
        expectedGrantInputRevision,
      ),
      this.bumpGrantInputRevision(),
      this.statement(`UPDATE effective_grants SET status = 'expired' WHERE status = 'active'`),
      ...grants.map((grant) => this.upsertEffectiveGrant(grant)),
      ...mutationStatements(this.bindStatement, mutation),
      guard.after,
    ];
    await executeBatch(this.db, statements, 1, 'Entitlement mapping');
  }

  public async listEffectiveGrants(subjectId?: string): Promise<EffectiveGrant[]> {
    const rows =
      subjectId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM effective_grants ORDER BY subject_id, entitlement_id, id',
          )
        : await this.all<DatabaseRow>(
            `SELECT * FROM effective_grants
             WHERE subject_id = ? ORDER BY entitlement_id, id`,
            subjectId,
          );
    return rows.map(mapEffectiveGrant);
  }

  private readonly bindStatement = (sql: string, ...params: SqlValue[]) =>
    this.statement(sql, ...params);

  private insertApplication(application: Application): D1PreparedStatement {
    return this.statement(
      `INSERT INTO applications (
        id, key, name, description, category, launch_url, icon_json, status, visibility,
        authentication_json, provisioning_mode, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      application.id,
      application.key,
      application.name,
      application.description ?? null,
      application.category,
      application.launchUrl,
      application.icon === undefined ? null : JSON.stringify(application.icon),
      application.status,
      application.visibility,
      JSON.stringify(application.authentication),
      application.provisioningMode,
      application.revision,
      application.createdAt,
      application.updatedAt,
      application.createdBy,
      application.updatedBy,
    );
  }

  private insertApplicationEntitlement(entitlement: ApplicationEntitlement): D1PreparedStatement {
    return this.statement(
      `INSERT INTO application_entitlements (
        id, application_id, key, name, description, status, requires_provisioning,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entitlement.id,
      entitlement.applicationId,
      entitlement.key,
      entitlement.name,
      entitlement.description ?? null,
      entitlement.status,
      entitlement.requiresProvisioning ? 1 : 0,
      entitlement.revision,
      entitlement.createdAt,
      entitlement.updatedAt,
      entitlement.createdBy,
      entitlement.updatedBy,
    );
  }

  private insertEntitlementMapping(mapping: EntitlementMapping): D1PreparedStatement {
    return this.statement(
      `INSERT INTO entitlement_mappings (
        id, source_group_id, status, valid_from, valid_until, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mapping.id,
      mapping.sourceGroupId,
      mapping.status,
      mapping.validFrom ?? null,
      mapping.validUntil ?? null,
      mapping.revision,
      mapping.createdAt,
      mapping.updatedAt,
      mapping.createdBy,
      mapping.updatedBy,
    );
  }

  private upsertEffectiveGrant(grant: EffectiveGrant): D1PreparedStatement {
    return this.statement(
      `INSERT INTO effective_grants (
        id, subject_id, source_group_id, source_group_membership_id, mapping_id,
        entitlement_id, status, calculated_at, valid_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        calculated_at = excluded.calculated_at,
        valid_until = excluded.valid_until`,
      grant.id,
      grant.subjectId,
      grant.sourceGroupId,
      grant.sourceGroupMembershipId,
      grant.mappingId,
      grant.entitlementId,
      grant.status,
      grant.calculatedAt,
      grant.validUntil ?? null,
    );
  }
}
