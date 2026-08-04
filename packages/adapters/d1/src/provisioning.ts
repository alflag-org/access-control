import type { MutationRecords, ProvisioningRepository } from '@access-control/application';
import type { AuthoritativePlanContext } from '@access-control/contracts';
import {
  AccessControlError,
  databaseConflict,
  type Lock,
  type Operation,
  type OperationPlan,
  type OperationPlanChange,
  type OperationStep,
  type ProviderAccount,
  type ProviderConnection,
  type ProviderObservation,
  type ProvisioningState,
  type ProvisioningTarget,
} from '@access-control/domain';
import { D1Client, type SqlValue } from './client';
import {
  executeBatch,
  mutationGuardStatements,
  mutationStatements,
  type SqlPredicate,
} from './mutation';
import {
  mapLock,
  mapOperation,
  mapOperationPlan,
  mapOperationPlanChange,
  mapOperationStep,
  mapProviderAccount,
  mapProviderConnection,
  mapProviderObservation,
  mapProvisioningState,
  mapProvisioningTarget,
} from './provisioning-rows';
import type { DatabaseRow } from './row-values';

export class D1ProvisioningRepository extends D1Client implements ProvisioningRepository {
  public async getProviderConnection(id: string): Promise<ProviderConnection | null> {
    const row = await this.first<DatabaseRow>(
      'SELECT * FROM provider_connections WHERE id = ?',
      id,
    );
    return row === null ? null : mapProviderConnection(row);
  }

  public async listProviderConnections(): Promise<ProviderConnection[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM provider_connections ORDER BY name, id')
    ).map(mapProviderConnection);
  }

  public async createProviderConnection(
    connection: ProviderConnection,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertProviderConnection(connection),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Provider Connection',
    );
  }

  public async updateProviderConnection(
    connection: ProviderConnection,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE provider_connections SET
            name = ?, mode = ?, credential_ref = ?, configuration_json = ?, status = ?,
            revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          connection.name,
          connection.mode,
          connection.credentialRef ?? null,
          JSON.stringify(connection.configuration),
          connection.status,
          connection.revision,
          connection.updatedAt,
          connection.updatedBy,
          connection.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Provider Connection',
    );
  }

  public async getProviderAccount(id: string): Promise<ProviderAccount | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM provider_accounts WHERE id = ?', id);
    return row === null ? null : mapProviderAccount(row);
  }

  public async listProviderAccounts(subjectId?: string): Promise<ProviderAccount[]> {
    const rows =
      subjectId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM provider_accounts ORDER BY provider_connection_id, external_id',
          )
        : await this.all<DatabaseRow>(
            `SELECT * FROM provider_accounts
             WHERE subject_id = ? ORDER BY provider_connection_id, external_id`,
            subjectId,
          );
    return rows.map(mapProviderAccount);
  }

  public async getProvisioningTarget(id: string): Promise<ProvisioningTarget | null> {
    const row = await this.first<DatabaseRow>(
      'SELECT * FROM provisioning_targets WHERE id = ?',
      id,
    );
    return row === null ? null : mapProvisioningTarget(row);
  }

  public async listProvisioningTargets(): Promise<ProvisioningTarget[]> {
    return (await this.all<DatabaseRow>('SELECT * FROM provisioning_targets ORDER BY id')).map(
      mapProvisioningTarget,
    );
  }

  public async createProvisioningTarget(
    target: ProvisioningTarget,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [this.insertProvisioningTarget(target), ...mutationStatements(this.bindStatement, mutation)],
      0,
      'Provisioning Target',
    );
  }

  public async updateProvisioningTarget(
    target: ProvisioningTarget,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE provisioning_targets SET
            application_entitlement_id = ?, mode = ?, protected = ?, configuration_json = ?,
            status = ?, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
          target.applicationEntitlementId,
          target.mode,
          target.protected ? 1 : 0,
          JSON.stringify(target.configuration),
          target.status,
          target.revision,
          target.updatedAt,
          target.updatedBy,
          target.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Provisioning Target',
    );
  }

  public async getProvisioningState(id: string): Promise<ProvisioningState | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM provisioning_states WHERE id = ?', id);
    return row === null ? null : mapProvisioningState(row);
  }

  public async listProvisioningStates(subjectId?: string): Promise<ProvisioningState[]> {
    const rows =
      subjectId === undefined
        ? await this.all<DatabaseRow>(
            'SELECT * FROM provisioning_states ORDER BY subject_id, provisioning_target_id',
          )
        : await this.all<DatabaseRow>(
            `SELECT * FROM provisioning_states
             WHERE subject_id = ? ORDER BY provisioning_target_id`,
            subjectId,
          );
    return rows.map(mapProvisioningState);
  }

  public async updateProvisioningState(
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.updateState(state, expectedRevision),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Provisioning state',
    );
  }

  public async persistObservation(
    observation: ProviderObservation,
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `INSERT INTO provider_observations (
            id, provider_connection_id, provisioning_target_id, status, observed_at,
            payload_json, payload_ref, checksum, error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          observation.id,
          observation.providerConnectionId,
          observation.provisioningTargetId ?? null,
          observation.status,
          observation.observedAt,
          observation.payload === undefined ? null : JSON.stringify(observation.payload),
          observation.payloadRef ?? null,
          observation.checksum,
          observation.errorCode ?? null,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Provider observation',
    );
  }

  public async getLatestCompleteObservation(
    providerConnectionId: string,
    provisioningTargetId: string,
  ): Promise<ProviderObservation | null> {
    const row = await this.first<DatabaseRow>(
      `SELECT * FROM provider_observations
       WHERE provider_connection_id = ? AND provisioning_target_id = ? AND status = 'complete'
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
      providerConnectionId,
      provisioningTargetId,
    );
    return row === null ? null : mapProviderObservation(row);
  }

  public async listRequiredProvisioningTargets(
    subjectId: string,
    effectiveAt: string,
  ): Promise<ProvisioningTarget[]> {
    return (
      await this.all<DatabaseRow>(
        `${requiredProvisioningTargetsSql()}
         ORDER BY targets.id`,
        subjectId,
        effectiveAt,
        effectiveAt,
        effectiveAt,
        effectiveAt,
        effectiveAt,
      )
    ).map(mapProvisioningTarget);
  }

  public async getOperationPlan(id: string): Promise<OperationPlan | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM operation_plans WHERE id = ?', id);
    return row === null ? null : mapOperationPlan(row);
  }

  public async listOperationPlans(): Promise<OperationPlan[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM operation_plans ORDER BY created_at DESC, id')
    ).map(mapOperationPlan);
  }

  public async listOperationPlanChanges(planId: string): Promise<OperationPlanChange[]> {
    return (
      await this.all<DatabaseRow>(
        `SELECT * FROM operation_plan_changes
         WHERE operation_plan_id = ? ORDER BY position, id`,
        planId,
      )
    ).map(mapOperationPlanChange);
  }

  public async persistOperationPlan(
    plan: OperationPlan,
    changes: OperationPlanChange[],
    state: ProvisioningState,
    mutation: MutationRecords,
    authority: AuthoritativePlanContext,
  ): Promise<void> {
    const authorityPredicate = planAuthorityPredicate(authority);
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${plan.id}`,
      authorityPredicate.sql,
      authorityPredicate.params,
    );
    await executeBatch(
      this.db,
      [
        this.updateState(state, state.revision - 1),
        guard.before,
        this.insertPlan(plan),
        ...changes.map((change) => this.insertPlanChange(change)),
        ...mutationStatements(this.bindStatement, mutation),
        guard.after,
      ],
      0,
      'Provisioning state',
    );
  }

  public async getOperation(id: string): Promise<Operation | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM operations WHERE id = ?', id);
    return row === null ? null : mapOperation(row);
  }

  public async getOperationByPlanId(planId: string): Promise<Operation | null> {
    const row = await this.first<DatabaseRow>(
      'SELECT * FROM operations WHERE operation_plan_id = ?',
      planId,
    );
    return row === null ? null : mapOperation(row);
  }

  public async listOperations(): Promise<Operation[]> {
    return (
      await this.all<DatabaseRow>('SELECT * FROM operations ORDER BY created_at DESC, id')
    ).map(mapOperation);
  }

  public async listOperationSteps(operationId: string): Promise<OperationStep[]> {
    return (
      await this.all<DatabaseRow>(
        `SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY position, id`,
        operationId,
      )
    ).map(mapOperationStep);
  }

  public async createOperation(
    operation: Operation,
    steps: OperationStep[],
    mutation: MutationRecords,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.insertOperation(operation),
        ...steps.map((step) => this.insertOperationStep(step)),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Operation',
    );
  }

  public async updateOperationStep(
    step: OperationStep,
    mutation: MutationRecords,
    expectedRevision: number,
  ): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `UPDATE operation_steps SET
            status = ?, evidence_json = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
          step.status,
          JSON.stringify(step.evidence),
          step.revision,
          step.updatedAt,
          step.id,
          expectedRevision,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Operation step',
    );
  }

  public async claimOperation(
    operation: Operation,
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedOperationRevision: number,
    expectedStateRevision: number,
    authority: AuthoritativePlanContext,
  ): Promise<boolean> {
    const authorityPredicate = planAuthorityPredicate(authority);
    const authorityGuard = mutationGuardStatements(
      this.bindStatement,
      `guard:claim:${operation.id}:${operation.revision}`,
      authorityPredicate.sql,
      authorityPredicate.params,
    );
    const predicate = {
      sql: `EXISTS (
        SELECT 1 FROM operations
        WHERE id = ? AND revision = ? AND status = 'applying'
      ) AND EXISTS (
        SELECT 1 FROM provisioning_states
        WHERE id = ? AND revision = ? AND status = 'applying'
      )`,
      params: [operation.id, operation.revision, state.id, state.revision],
    };
    let results: D1Result<unknown>[];
    try {
      results = await this.db.batch([
        authorityGuard.before,
        this.operationUpdateStatement(
          operation,
          expectedOperationRevision,
          `status = 'running' AND EXISTS (
            SELECT 1 FROM provisioning_states
            WHERE id = ? AND revision = ? AND last_plan_id = ?
          )`,
          state.id,
          expectedStateRevision,
          operation.operationPlanId,
        ),
        this.stateUpdateStatement(
          state,
          expectedStateRevision,
          `EXISTS (
            SELECT 1 FROM operations
            WHERE id = ? AND revision = ? AND status = 'applying'
          )`,
          operation.id,
          operation.revision,
        ),
        ...mutationStatements(this.bindStatement, mutation, predicate),
        authorityGuard.after,
      ]);
    } catch (error) {
      throw databaseConflict(error);
    }
    const operationClaimed = results[1]?.meta.changes === 1;
    const stateClaimed = results[2]?.meta.changes === 1;
    if (operationClaimed !== stateClaimed) {
      throw new AccessControlError(
        409,
        'persistence_conflict',
        'The Operation claim did not update all required records.',
      );
    }
    return operationClaimed;
  }

  public async isPlanAuthorityCurrent(authority: AuthoritativePlanContext): Promise<boolean> {
    const predicate = planAuthorityPredicate(authority);
    const row = await this.first<DatabaseRow>(
      `SELECT CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END AS is_current`,
      ...predicate.params,
    );
    return row?.is_current === 1;
  }

  public async updateOperationAndState(
    operation: Operation,
    state: ProvisioningState,
    mutation: MutationRecords,
    expectedOperationRevision: number,
    expectedStateRevision: number,
  ): Promise<void> {
    const guard = mutationGuardStatements(
      this.bindStatement,
      `guard:${operation.id}:${operation.revision}`,
      `EXISTS (
        SELECT 1 FROM operations WHERE id = ? AND revision = ?
      ) AND EXISTS (
        SELECT 1 FROM provisioning_states WHERE id = ? AND revision = ?
      )`,
      [operation.id, expectedOperationRevision, state.id, expectedStateRevision],
    );
    await executeBatch(
      this.db,
      [
        guard.before,
        this.operationUpdateStatement(operation, expectedOperationRevision),
        this.stateUpdateStatement(state, expectedStateRevision),
        ...mutationStatements(this.bindStatement, mutation),
        guard.after,
      ],
      1,
      'Operation',
    );
  }

  public async getLock(key: string): Promise<Lock | null> {
    const row = await this.first<DatabaseRow>('SELECT * FROM locks WHERE key = ?', key);
    return row === null ? null : mapLock(row);
  }

  public async acquireLock(lock: Lock, mutation: MutationRecords): Promise<void> {
    await executeBatch(
      this.db,
      [
        this.statement(
          `INSERT INTO locks (
            id, key, operation_id, fencing_token, acquired_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          lock.id,
          lock.key,
          lock.operationId,
          lock.fencingToken,
          lock.acquiredAt,
          lock.expiresAt,
          lock.releasedAt ?? null,
        ),
        ...mutationStatements(this.bindStatement, mutation),
      ],
      0,
      'Operation lock',
    );
  }

  private readonly bindStatement = (sql: string, ...params: SqlValue[]) =>
    this.statement(sql, ...params);

  private insertProviderConnection(connection: ProviderConnection): D1PreparedStatement {
    return this.statement(
      `INSERT INTO provider_connections (
        id, provider, name, mode, credential_ref, configuration_json, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      connection.id,
      connection.provider,
      connection.name,
      connection.mode,
      connection.credentialRef ?? null,
      JSON.stringify(connection.configuration),
      connection.status,
      connection.revision,
      connection.createdAt,
      connection.updatedAt,
      connection.createdBy,
      connection.updatedBy,
    );
  }

  private insertProvisioningTarget(target: ProvisioningTarget): D1PreparedStatement {
    return this.statement(
      `INSERT INTO provisioning_targets (
        id, provider_connection_id, application_entitlement_id, target_type, provider_target_id,
        mode, protected, configuration_json, status, revision, created_at, updated_at,
        created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      target.id,
      target.providerConnectionId,
      target.applicationEntitlementId,
      target.targetType,
      target.providerTargetId,
      target.mode,
      target.protected ? 1 : 0,
      JSON.stringify(target.configuration),
      target.status,
      target.revision,
      target.createdAt,
      target.updatedAt,
      target.createdBy,
      target.updatedBy,
    );
  }

  private updateState(state: ProvisioningState, expectedRevision: number): D1PreparedStatement {
    return this.stateUpdateStatement(state, expectedRevision);
  }

  private stateUpdateStatement(
    state: ProvisioningState,
    expectedRevision: number,
    additionalPredicate = '1 = 1',
    ...additionalParams: SqlValue[]
  ): D1PreparedStatement {
    return this.statement(
      `UPDATE provisioning_states SET
        desired_state = ?, observed_state = ?, status = ?, last_observation_id = ?,
        last_plan_id = ?, evidence_json = ?, revision = ?, updated_at = ?
       WHERE id = ? AND revision = ? AND ${additionalPredicate}`,
      state.desiredState,
      state.observedState,
      state.status,
      state.lastObservationId ?? null,
      state.lastPlanId ?? null,
      JSON.stringify(state.evidence),
      state.revision,
      state.updatedAt,
      state.id,
      expectedRevision,
      ...additionalParams,
    );
  }

  private operationUpdateStatement(
    operation: Operation,
    expectedRevision: number,
    additionalPredicate = '1 = 1',
    ...additionalParams: SqlValue[]
  ): D1PreparedStatement {
    return this.statement(
      `UPDATE operations SET
        status = ?, explicit = ?, revision = ?, updated_at = ?, started_at = ?,
        completed_at = ?, error_code = ?
       WHERE id = ? AND revision = ? AND ${additionalPredicate}`,
      operation.status,
      operation.explicit ? 1 : 0,
      operation.revision,
      operation.updatedAt,
      operation.startedAt ?? null,
      operation.completedAt ?? null,
      operation.errorCode ?? null,
      operation.id,
      expectedRevision,
      ...additionalParams,
    );
  }

  private insertPlan(plan: OperationPlan): D1PreparedStatement {
    return this.statement(
      `INSERT INTO operation_plans (
        id, provider_connection_id, provisioning_target_id, provisioning_state_id,
        subject_id, entitlement_id, observation_id, observation_checksum,
        effective_grant_ids_json, required_target_ids_json, plan_hash, destructive,
        protected, input_revisions_json, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plan.id,
      plan.providerConnectionId,
      plan.provisioningTargetId,
      plan.provisioningStateId,
      plan.subjectId,
      plan.entitlementId,
      plan.observationId,
      plan.observationChecksum,
      JSON.stringify(plan.effectiveGrantIds),
      JSON.stringify(plan.requiredProvisioningTargetIds),
      plan.planHash,
      plan.destructive ? 1 : 0,
      plan.protected ? 1 : 0,
      JSON.stringify(plan.inputRevisions),
      plan.status,
      plan.createdBy,
      plan.createdAt,
    );
  }

  private insertPlanChange(change: OperationPlanChange): D1PreparedStatement {
    return this.statement(
      `INSERT INTO operation_plan_changes (
        id, operation_plan_id, position, action, resource, before_json, after_json,
        destructive, protected, preconditions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      change.id,
      change.operationPlanId,
      change.position,
      change.action,
      change.resource,
      JSON.stringify(change.before),
      JSON.stringify(change.after),
      change.destructive ? 1 : 0,
      change.protected ? 1 : 0,
      JSON.stringify(change.preconditions),
    );
  }

  private insertOperation(operation: Operation): D1PreparedStatement {
    return this.statement(
      `INSERT INTO operations (
        id, operation_plan_id, status, explicit, revision, created_by, created_at,
        updated_at, started_at, completed_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      operation.id,
      operation.operationPlanId,
      operation.status,
      operation.explicit ? 1 : 0,
      operation.revision,
      operation.createdBy,
      operation.createdAt,
      operation.updatedAt,
      operation.startedAt ?? null,
      operation.completedAt ?? null,
      operation.errorCode ?? null,
    );
  }

  private insertOperationStep(step: OperationStep): D1PreparedStatement {
    return this.statement(
      `INSERT INTO operation_steps (
        id, operation_id, position, name, status, evidence_json, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      step.id,
      step.operationId,
      step.position,
      step.name,
      step.status,
      JSON.stringify(step.evidence),
      step.revision,
      step.updatedAt,
    );
  }
}

function requiredProvisioningTargetsSql(): string {
  return `SELECT DISTINCT targets.*
    FROM provisioning_targets targets
    JOIN entitlement_mapping_targets mapping_targets
      ON mapping_targets.provisioning_target_id = targets.id
    JOIN entitlement_mappings mappings ON mappings.id = mapping_targets.mapping_id
    JOIN effective_grants grants ON grants.mapping_id = mappings.id
    JOIN subjects ON subjects.id = grants.subject_id
    JOIN application_entitlements entitlements
      ON entitlements.id = targets.application_entitlement_id
    JOIN applications ON applications.id = entitlements.application_id
    JOIN provider_connections connections ON connections.id = targets.provider_connection_id
    WHERE grants.subject_id = ? AND grants.status = 'active'
      AND (grants.valid_until IS NULL OR julianday(grants.valid_until) > julianday(?))
      AND subjects.status = 'active' AND subjects.directory_state = 'active'
      AND (
        subjects.classification <> 'managed_guest'
        OR EXISTS (
          SELECT 1 FROM guest_profiles guests
          JOIN subjects sponsors ON sponsors.id = guests.sponsor_subject_id
          WHERE guests.subject_id = subjects.id AND guests.status = 'active'
            AND julianday(guests.valid_from) <= julianday(?)
            AND julianday(guests.expires_at) > julianday(?)
            AND sponsors.status = 'active'
        )
      )
      AND mappings.status = 'active'
      AND (mappings.valid_from IS NULL OR julianday(mappings.valid_from) <= julianday(?))
      AND (mappings.valid_until IS NULL OR julianday(mappings.valid_until) > julianday(?))
      AND targets.status = 'active' AND entitlements.status = 'active'
      AND applications.status = 'active' AND connections.status = 'active'`;
}

function planAuthorityPredicate(authority: AuthoritativePlanContext): SqlPredicate {
  const account = authority.providerAccount;
  const effectiveAt = authority.evaluatedAt;
  return {
    sql: `EXISTS (
       SELECT 1 FROM organization_settings WHERE id = ? AND revision = ?
     ) AND EXISTS (
       SELECT 1 FROM subjects WHERE id = ? AND revision = ?
     ) AND EXISTS (
       SELECT 1 FROM application_entitlements WHERE id = ? AND revision = ?
     ) AND EXISTS (
       SELECT 1 FROM provider_connections WHERE id = ? AND revision = ? AND status = 'active'
     ) AND EXISTS (
       SELECT 1 FROM provisioning_targets
       WHERE id = ? AND revision = ? AND provider_connection_id = ?
         AND application_entitlement_id = ? AND status = 'active'
     ) AND (
       (? IS NULL AND NOT EXISTS (
         SELECT 1 FROM provider_accounts WHERE provider_connection_id = ? AND subject_id = ?
       )) OR (
         ? IS NOT NULL AND EXISTS (
           SELECT 1 FROM provider_accounts
           WHERE id = ? AND revision = ? AND provider_connection_id = ? AND subject_id = ?
         ) AND 1 = (
           SELECT count(*) FROM provider_accounts
           WHERE provider_connection_id = ? AND subject_id = ?
         )
       )
     ) AND ? = (
       SELECT id FROM provider_observations
       WHERE provider_connection_id = ? AND provisioning_target_id = ? AND status = 'complete'
       ORDER BY observed_at DESC, id DESC LIMIT 1
     ) AND EXISTS (
       SELECT 1 FROM provider_observations
       WHERE id = ? AND checksum = ? AND payload_json IS NOT NULL
     ) AND ? = (
       SELECT COALESCE(json_group_array(id), '[]') FROM (
         SELECT grants.id
         FROM effective_grants grants
         JOIN subjects ON subjects.id = grants.subject_id
         WHERE grants.subject_id = ? AND subjects.status = 'active'
           AND subjects.directory_state = 'active' AND grants.status = 'active'
           AND (grants.valid_until IS NULL OR julianday(grants.valid_until) > julianday(?))
           AND (
             subjects.classification <> 'managed_guest'
             OR EXISTS (
               SELECT 1 FROM guest_profiles guests
               JOIN subjects sponsors ON sponsors.id = guests.sponsor_subject_id
               WHERE guests.subject_id = subjects.id AND guests.status = 'active'
                 AND julianday(guests.valid_from) <= julianday(?)
                 AND julianday(guests.expires_at) > julianday(?)
                 AND sponsors.status = 'active'
             )
           )
         ORDER BY grants.id
       )
     ) AND ? = (
       SELECT COALESCE(json_group_array(id || ':' || revision), '[]') FROM (
         ${requiredProvisioningTargetsSql()}
         ORDER BY targets.id
       )
     )`,
    params: [
      authority.organizationSettings.id,
      authority.organizationSettings.revision,
      authority.subject.id,
      authority.subject.revision,
      authority.entitlement.id,
      authority.entitlement.revision,
      authority.providerConnection.id,
      authority.providerConnection.revision,
      authority.provisioningTarget.id,
      authority.provisioningTarget.revision,
      authority.providerConnection.id,
      authority.entitlement.id,
      account?.id ?? null,
      authority.providerConnection.id,
      authority.subject.id,
      account?.id ?? null,
      account?.id ?? null,
      account?.revision ?? null,
      authority.providerConnection.id,
      authority.subject.id,
      authority.providerConnection.id,
      authority.subject.id,
      authority.observation.id,
      authority.providerConnection.id,
      authority.provisioningTarget.id,
      authority.observation.id,
      authority.observation.checksum,
      JSON.stringify(authority.effectiveGrants.map((grant) => grant.id).sort()),
      authority.subject.id,
      effectiveAt,
      effectiveAt,
      effectiveAt,
      JSON.stringify(
        authority.requiredProvisioningTargets
          .map((target) => `${target.id}:${target.revision}`)
          .sort(),
      ),
      authority.subject.id,
      effectiveAt,
      effectiveAt,
      effectiveAt,
      effectiveAt,
      effectiveAt,
    ],
  };
}
