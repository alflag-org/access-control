import type {
  DirectoryPublication,
  DirectoryRepository,
  MutationRecords,
} from '@access-control/application';
import type {
  DirectorySource,
  DirectorySyncRun,
  DirectorySyncViolation,
  EffectiveGrant,
  ExternalIdentity,
  SourceGroup,
  SourceGroupMembership,
  Subject,
} from '@access-control/domain';
import { D1Client, type SqlValue } from './client';
import {
  mapDirectorySource,
  mapDirectorySyncRun,
  mapDirectorySyncViolation,
} from './directory-rows';
import { executeBatch, mutationGuardStatements, mutationStatements } from './mutation';
import type { DatabaseRow } from './row-values';

export class D1DirectoryRepository extends D1Client implements DirectoryRepository {
  public async getDirectorySource(id: string): Promise<DirectorySource | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM directory_sources WHERE id = ?', id);
    return row === null ? null : mapDirectorySource(row);
  }

  public async listDirectorySources(): Promise<DirectorySource[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM directory_sources ORDER BY id')).map(
      mapDirectorySource,
    );
  }

  public async createDirectorySource(
    source: DirectorySource,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [this.insertDirectorySource(source), ...mutationStatements(this.bindStatement, mutation)],
      0,
      'Directory Source',
    );
  }

  public async updateDirectorySource(
    source: DirectorySource,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE directory_sources SET
            customer_id = ?, delegated_admin = ?, credential_ref = ?, access_group_prefix = ?,
            status = ?, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          source.customerId,
          source.delegatedAdmin,
          source.credentialRef,
          source.accessGroupPrefix,
          source.status,
          source.revision,
          source.updatedAt,
          source.updatedBy,
          source.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Directory Source',
    );
  }

  public async createDirectorySyncRun(
    run: DirectorySyncRun,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [this.insertSyncRun(run), ...mutationStatements(this.bindStatement, mutation)],
      0,
      'Directory sync run',
    );
  }

  public async publishDirectorySnapshot(publication: DirectoryPublication): Promise<void> {
    const guardId = `guard:${crypto.randomUUID()}`;
    const checks: string[] = [
      `EXISTS (SELECT 1 FROM directory_sync_runs WHERE id = ? AND status = 'running')`,
      `EXISTS (
        SELECT 1 FROM grant_input_versions
        WHERE name = 'effective_grants' AND revision = ?
      )`,
    ];
    const params: SqlValue[] = [publication.syncRun.id, publication.grantInputRevision];
    const guardedEntities: Array<{
      table: 'external_identities' | 'source_groups' | 'subjects';
      id: string;
      revision: number;
    }> = [
      ...publication.subjects.map(({ id, revision }) => ({
        table: 'subjects' as const,
        id,
        revision,
      })),
      ...publication.externalIdentities.map(({ id, revision }) => ({
        table: 'external_identities' as const,
        id,
        revision,
      })),
      ...publication.sourceGroups.map(({ id, revision }) => ({
        table: 'source_groups' as const,
        id,
        revision,
      })),
    ];
    for (const entity of guardedEntities) {
      checks.push(
        `((NOT EXISTS (SELECT 1 FROM ${entity.table} WHERE id = ?) AND ? = 1)
          OR EXISTS (SELECT 1 FROM ${entity.table} WHERE id = ? AND revision = ?))`,
      );
      params.push(entity.id, entity.revision, entity.id, entity.revision - 1);
    }
    const guard = mutationGuardStatements(
      this.bindStatement,
      guardId,
      checks.join(' AND '),
      params,
    );
    const statements: D1PreparedStatement[] = [
      guard.before,
      this.bumpGrantInputRevision(),
      ...publication.subjects.map((subject) => this.upsertSubject(subject)),
      ...publication.externalIdentities.map((identity) => this.upsertExternalIdentity(identity)),
      ...publication.sourceGroups.map((group) => this.upsertSourceGroup(group)),
      ...publication.memberships.map((membership) => this.upsertMembership(membership)),
      ...publication.violations.map((violation) => this.insertViolation(violation)),
      this.statement(`UPDATE effective_grants SET status = 'expired' WHERE status = 'active'`),
      ...publication.effectiveGrants.map((grant) => this.upsertEffectiveGrant(grant)),
      this.updateSyncRun(publication.syncRun, 'running'),
      ...mutationStatements(this.bindStatement, publication.mutation),
      guard.after,
    ];
    await executeBatch(this.db, statements, 0, 'Directory snapshot');
  }

  public async failDirectorySyncRun(
    run: DirectorySyncRun,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [this.updateSyncRun(run, 'running'), ...mutationStatements(this.bindStatement, mutation)],
      0,
      'Directory sync run',
    );
  }

  public async getDirectorySyncRun(id: string): Promise<DirectorySyncRun | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM directory_sync_runs WHERE id = ?', id);
    return row === null ? null : mapDirectorySyncRun(row);
  }

  public async listDirectorySyncRuns(): Promise<DirectorySyncRun[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM directory_sync_runs ORDER BY started_at DESC, id')
    ).map(mapDirectorySyncRun);
  }

  public async listDirectorySyncViolations(syncRunId?: string): Promise<DirectorySyncViolation[]> {
    const rows =
      syncRunId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM directory_sync_violations ORDER BY recorded_at DESC, id',
          )
        : await this.all<DatabaseRow>(
            `SELECT * FROM directory_sync_violations
             WHERE sync_run_id = ? ORDER BY recorded_at DESC, id`,
            syncRunId,
          );
    return rows.map(mapDirectorySyncViolation);
  }

  private readonly bindStatement = (sql: string, ...params: SqlValue[]) =>
    this.statement(sql, ...params);

  private insertDirectorySource(source: DirectorySource): D1PreparedStatement {
    return this.statement(
      `INSERT INTO directory_sources (
        id, provider, customer_id, delegated_admin, credential_ref, access_group_prefix,
        status, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source.id,
      source.provider,
      source.customerId,
      source.delegatedAdmin,
      source.credentialRef,
      source.accessGroupPrefix,
      source.status,
      source.revision,
      source.createdAt,
      source.updatedAt,
      source.createdBy,
      source.updatedBy,
    );
  }

  private insertSyncRun(run: DirectorySyncRun): D1PreparedStatement {
    return this.statement(
      `INSERT INTO directory_sync_runs (
        id, directory_source_id, status, started_at, completed_at, snapshot_version,
        user_count, group_count, membership_count, violation_count, error_code, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id,
      run.directorySourceId,
      run.status,
      run.startedAt,
      run.completedAt ?? null,
      run.snapshotVersion ?? null,
      run.userCount,
      run.groupCount,
      run.membershipCount,
      run.violationCount,
      run.errorCode ?? null,
      run.requestId,
    );
  }

  private updateSyncRun(run: DirectorySyncRun, expectedStatus: string): D1PreparedStatement {
    return this.statement(
      `UPDATE directory_sync_runs SET
        status = ?, completed_at = ?, snapshot_version = ?, user_count = ?, group_count = ?,
        membership_count = ?, violation_count = ?, error_code = ?
       WHERE id = ? AND status = ?`,
      run.status,
      run.completedAt ?? null,
      run.snapshotVersion ?? null,
      run.userCount,
      run.groupCount,
      run.membershipCount,
      run.violationCount,
      run.errorCode ?? null,
      run.id,
      expectedStatus,
    );
  }

  private upsertSubject(subject: Subject): D1PreparedStatement {
    return this.statement(
      `INSERT INTO subjects (
        id, kind, classification, display_name, primary_email, status, directory_state,
        protected, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        primary_email = excluded.primary_email,
        status = excluded.status,
        directory_state = excluded.directory_state,
        protected = excluded.protected,
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      WHERE subjects.revision = excluded.revision - 1`,
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

  private upsertExternalIdentity(identity: ExternalIdentity): D1PreparedStatement {
    return this.statement(
      `INSERT INTO external_identities (
        id, subject_id, provider, issuer, provider_subject, display_name, email, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        email = excluded.email,
        status = excluded.status,
        revision = excluded.revision,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      WHERE external_identities.revision = excluded.revision - 1`,
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

  private upsertSourceGroup(group: SourceGroup): D1PreparedStatement {
    return this.statement(
      `INSERT INTO source_groups (
        id, directory_source_id, provider_group_id, email, aliases_json, name, kind, status,
        direct_member_count, last_sync_run_id, last_observed_at, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        aliases_json = excluded.aliases_json,
        name = excluded.name,
        kind = excluded.kind,
        status = excluded.status,
        direct_member_count = excluded.direct_member_count,
        last_sync_run_id = excluded.last_sync_run_id,
        last_observed_at = excluded.last_observed_at,
        revision = excluded.revision,
        updated_at = excluded.updated_at
      WHERE source_groups.revision = excluded.revision - 1`,
      group.id,
      group.directorySourceId,
      group.providerGroupId,
      group.email,
      JSON.stringify(group.aliases),
      group.name,
      group.kind,
      group.status,
      group.directMemberCount,
      group.lastSyncRunId,
      group.lastObservedAt,
      group.revision,
      group.createdAt,
      group.updatedAt,
    );
  }

  private upsertMembership(membership: SourceGroupMembership): D1PreparedStatement {
    return this.statement(
      `INSERT INTO source_group_memberships (
        id, source_group_id, provider_membership_id, member_type, member_provider_id,
        member_email, role, status, sync_run_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        member_type = excluded.member_type,
        member_provider_id = excluded.member_provider_id,
        member_email = excluded.member_email,
        role = excluded.role,
        status = excluded.status,
        sync_run_id = excluded.sync_run_id,
        observed_at = excluded.observed_at`,
      membership.id,
      membership.sourceGroupId,
      membership.providerMembershipId,
      membership.memberType,
      membership.memberProviderId,
      membership.memberEmail ?? null,
      membership.role,
      membership.status,
      membership.syncRunId,
      membership.observedAt,
    );
  }

  private insertViolation(violation: DirectorySyncViolation): D1PreparedStatement {
    return this.statement(
      `INSERT INTO directory_sync_violations (
        id, sync_run_id, code, entity_type, entity_id, field, message, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      violation.id,
      violation.syncRunId,
      violation.code,
      violation.entityType,
      violation.entityId,
      violation.field ?? null,
      violation.message,
      violation.recordedAt,
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
