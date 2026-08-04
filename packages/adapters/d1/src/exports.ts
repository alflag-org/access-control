import type { ExportRepository, MutationRecords } from '@access-control/application';
import { portableExportPayloadSchema, type PortableExportPayload } from '@access-control/contracts';
import { databaseConflict, type ExportRecord } from '@access-control/domain';
import { D1AuditRepository } from './audit';
import { D1CatalogRepository } from './catalog';
import { D1Client, type SqlValue } from './client';
import { mapExportRecord } from './event-rows';
import { D1IdentityRepository } from './identities';
import { executeBatch, mutationStatements } from './mutation';
import { D1ProvisioningRepository } from './provisioning';
import type { DatabaseRow } from './row-values';

export class D1ExportRepository extends D1Client implements ExportRepository {
  public async getExportRecord(id: string): Promise<ExportRecord | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM exports WHERE id = ?', id);
    return row === null ? null : mapExportRecord(row);
  }

  public async listExportRecords(): Promise<ExportRecord[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM exports ORDER BY created_at DESC, id')).map(
      mapExportRecord,
    );
  }

  public async createExportRecord(record: ExportRecord, mutation: MutationRecords): Promise<void> {
    await executeBatch(
      this.db,
      [this.insertExportRecord(record), ...mutationStatements(this.bindStatement, mutation)],
      0,
      'Export',
    );
  }

  public async claimExportRecord(
    exportId: string,
    claimId: string,
    expectedRevision: number,
    claimedAt: string,
  ): Promise<ExportRecord | null> {
    let result: D1Result<unknown>;
    try {
      result = await this.statement(
        `UPDATE exports SET
          status = 'running', claim_id = ?, revision = revision + 1, updated_at = ?,
          completed_at = NULL, error_code = NULL
         WHERE id = ? AND revision = ? AND status = 'planned'
           AND EXISTS (
             SELECT 1 FROM outbox
             WHERE id = ?
               AND topic = 'access-control.export.requested'
               AND status IN ('dispatching', 'delivered')
               AND json_extract(payload_json, '$.exportId') = ?
           )`,
        claimId,
        claimedAt,
        exportId,
        expectedRevision,
        claimId,
        exportId,
      ).run();
    } catch (error) {
      throw databaseConflict(error);
    }
    if (result.meta.changes !== 1) return null;
    return this.getExportRecord(exportId);
  }

  public async completeExportRecord(
    record: ExportRecord,
    mutation: MutationRecords,
    expectedRevision: number,
    expectedClaimId: string,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE exports SET
            status = ?, object_key = ?, checksum = ?, entity_count = ?, revision = ?,
            updated_at = ?, completed_at = ?, error_code = ?
           WHERE id = ? AND revision = ? AND status = 'running' AND claim_id = ?`,
          record.status,
          record.objectKey ?? null,
          record.checksum ?? null,
          record.entityCount ?? null,
          record.revision,
          record.updatedAt,
          record.completedAt ?? null,
          record.errorCode ?? null,
          record.id,
          expectedRevision,
          expectedClaimId,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Export',
    );
  }

  public async buildPortableExportPayload(generatedAt: string): Promise<PortableExportPayload> {
    const identities = new D1IdentityRepository(this.db);
    const catalog = new D1CatalogRepository(this.db);
    const provisioning = new D1ProvisioningRepository(this.db);
    const audit = new D1AuditRepository(this.db);
    const organizationSettings = await identities.getOrganizationSettings();
    const operationPlans = await provisioning.listOperationPlans();
    const operationPlanChanges = (
      await Promise.all(
        operationPlans.map((plan) => provisioning.listOperationPlanChanges(plan.id)),
      )
    ).flat();
    return portableExportPayloadSchema.parse({
      schemaVersion: '1.0.0',
      generatedAt,
      entities: {
        organizationSettings: organizationSettings === null ? [] : [organizationSettings],
        subjects: await identities.listSubjects(),
        externalIdentities: await identities.listExternalIdentities(),
        guestProfiles: await identities.listGuestProfiles(),
        platformRoleGrants: await identities.listPlatformRoleGrants(),
        sourceGroups: await catalog.listSourceGroups(),
        sourceGroupMemberships: await catalog.listSourceGroupMemberships(),
        applications: await catalog.listApplications(),
        applicationEntitlements: await catalog.listApplicationEntitlements(),
        entitlementMappings: await catalog.listEntitlementMappings(),
        effectiveGrants: await catalog.listEffectiveGrants(),
        providerConnections: await provisioning.listProviderConnections(),
        providerAccounts: await provisioning.listProviderAccounts(),
        provisioningTargets: await provisioning.listProvisioningTargets(),
        provisioningStates: await provisioning.listProvisioningStates(),
        operationPlans,
        operationPlanChanges,
        auditEvents: await audit.listAuditEvents(),
        exportRecords: await this.listExportRecords(),
      },
    });
  }

  private readonly bindStatement = (sql: string, ...params: SqlValue[]) =>
    this.statement(sql, ...params);

  private insertExportRecord(record: ExportRecord): D1PreparedStatement {
    return this.statement(
      `INSERT INTO exports (
        id, schema_version, status, object_key, checksum, entity_count, revision,
        requested_by, claim_id, created_at, updated_at, completed_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.schemaVersion,
      record.status,
      record.objectKey ?? null,
      record.checksum ?? null,
      record.entityCount ?? null,
      record.revision,
      record.requestedBy,
      record.claimId ?? null,
      record.createdAt,
      record.updatedAt,
      record.completedAt ?? null,
      record.errorCode ?? null,
    );
  }
}
