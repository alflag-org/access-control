import {
  lockSchema,
  operationPlanChangeSchema,
  operationPlanSchema,
  operationSchema,
  operationStepSchema,
  providerAccountSchema,
  providerConnectionSchema,
  providerObservationSchema,
  provisioningStateSchema,
  provisioningTargetSchema,
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
import {
  booleanValue,
  integer,
  jsonValue,
  optionalJsonValue,
  optionalText,
  text,
  type DatabaseRow,
} from './row-values';

export function mapProviderConnection(row: DatabaseRow): ProviderConnection {
  return providerConnectionSchema.parse({
    id: text(row, 'id'),
    provider: text(row, 'provider'),
    name: text(row, 'name'),
    mode: text(row, 'mode'),
    ...(optionalText(row, 'credential_ref') === undefined
      ? {}
      : { credentialRef: optionalText(row, 'credential_ref') }),
    configuration: jsonValue(row, 'configuration_json'),
    status: text(row, 'status'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapProviderAccount(row: DatabaseRow): ProviderAccount {
  return providerAccountSchema.parse({
    id: text(row, 'id'),
    providerConnectionId: text(row, 'provider_connection_id'),
    ...(optionalText(row, 'subject_id') === undefined
      ? {}
      : { subjectId: optionalText(row, 'subject_id') }),
    externalId: text(row, 'external_id'),
    ...(optionalText(row, 'login') === undefined ? {} : { login: optionalText(row, 'login') }),
    ...(optionalText(row, 'display_name') === undefined
      ? {}
      : { displayName: optionalText(row, 'display_name') }),
    status: text(row, 'status'),
    observedAt: text(row, 'observed_at'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  });
}

export function mapProvisioningTarget(row: DatabaseRow): ProvisioningTarget {
  return provisioningTargetSchema.parse({
    id: text(row, 'id'),
    providerConnectionId: text(row, 'provider_connection_id'),
    applicationEntitlementId: text(row, 'application_entitlement_id'),
    targetType: text(row, 'target_type'),
    providerTargetId: text(row, 'provider_target_id'),
    mode: text(row, 'mode'),
    protected: booleanValue(row, 'protected'),
    configuration: jsonValue(row, 'configuration_json'),
    status: text(row, 'status'),
    revision: integer(row, 'revision'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    createdBy: text(row, 'created_by'),
    updatedBy: text(row, 'updated_by'),
  });
}

export function mapProvisioningState(row: DatabaseRow): ProvisioningState {
  return provisioningStateSchema.parse({
    id: text(row, 'id'),
    provisioningTargetId: text(row, 'provisioning_target_id'),
    subjectId: text(row, 'subject_id'),
    desiredState: text(row, 'desired_state'),
    observedState: text(row, 'observed_state'),
    status: text(row, 'status'),
    ...(optionalText(row, 'last_observation_id') === undefined
      ? {}
      : { lastObservationId: optionalText(row, 'last_observation_id') }),
    ...(optionalText(row, 'last_plan_id') === undefined
      ? {}
      : { lastPlanId: optionalText(row, 'last_plan_id') }),
    evidence: jsonValue(row, 'evidence_json'),
    revision: integer(row, 'revision'),
    updatedAt: text(row, 'updated_at'),
  });
}

export function mapProviderObservation(row: DatabaseRow): ProviderObservation {
  return providerObservationSchema.parse({
    id: text(row, 'id'),
    providerConnectionId: text(row, 'provider_connection_id'),
    ...(optionalText(row, 'provisioning_target_id') === undefined
      ? {}
      : { provisioningTargetId: optionalText(row, 'provisioning_target_id') }),
    status: text(row, 'status'),
    observedAt: text(row, 'observed_at'),
    ...(optionalJsonValue(row, 'payload_json') === undefined
      ? {}
      : { payload: optionalJsonValue(row, 'payload_json') }),
    ...(optionalText(row, 'payload_ref') === undefined
      ? {}
      : { payloadRef: optionalText(row, 'payload_ref') }),
    checksum: text(row, 'checksum'),
    ...(optionalText(row, 'error_code') === undefined
      ? {}
      : { errorCode: optionalText(row, 'error_code') }),
  });
}

export function mapOperationPlan(row: DatabaseRow): OperationPlan {
  return operationPlanSchema.parse({
    id: text(row, 'id'),
    providerConnectionId: text(row, 'provider_connection_id'),
    provisioningTargetId: text(row, 'provisioning_target_id'),
    provisioningStateId: text(row, 'provisioning_state_id'),
    subjectId: text(row, 'subject_id'),
    entitlementId: text(row, 'entitlement_id'),
    observationId: text(row, 'observation_id'),
    observationChecksum: text(row, 'observation_checksum'),
    effectiveGrantIds: jsonValue(row, 'effective_grant_ids_json'),
    requiredProvisioningTargetIds: jsonValue(row, 'required_target_ids_json'),
    planHash: text(row, 'plan_hash'),
    destructive: booleanValue(row, 'destructive'),
    protected: booleanValue(row, 'protected'),
    inputRevisions: jsonValue(row, 'input_revisions_json'),
    status: text(row, 'status'),
    createdBy: text(row, 'created_by'),
    createdAt: text(row, 'created_at'),
  });
}

export function mapOperationPlanChange(row: DatabaseRow): OperationPlanChange {
  return operationPlanChangeSchema.parse({
    id: text(row, 'id'),
    operationPlanId: text(row, 'operation_plan_id'),
    position: integer(row, 'position'),
    action: text(row, 'action'),
    resource: text(row, 'resource'),
    before: jsonValue(row, 'before_json'),
    after: jsonValue(row, 'after_json'),
    destructive: booleanValue(row, 'destructive'),
    protected: booleanValue(row, 'protected'),
    preconditions: jsonValue(row, 'preconditions_json'),
  });
}

export function mapOperation(row: DatabaseRow): Operation {
  return operationSchema.parse({
    id: text(row, 'id'),
    operationPlanId: text(row, 'operation_plan_id'),
    status: text(row, 'status'),
    explicit: booleanValue(row, 'explicit'),
    revision: integer(row, 'revision'),
    createdBy: text(row, 'created_by'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    ...(optionalText(row, 'started_at') === undefined
      ? {}
      : { startedAt: optionalText(row, 'started_at') }),
    ...(optionalText(row, 'completed_at') === undefined
      ? {}
      : { completedAt: optionalText(row, 'completed_at') }),
    ...(optionalText(row, 'error_code') === undefined
      ? {}
      : { errorCode: optionalText(row, 'error_code') }),
  });
}

export function mapOperationStep(row: DatabaseRow): OperationStep {
  return operationStepSchema.parse({
    id: text(row, 'id'),
    operationId: text(row, 'operation_id'),
    position: integer(row, 'position'),
    name: text(row, 'name'),
    status: text(row, 'status'),
    evidence: jsonValue(row, 'evidence_json'),
    revision: integer(row, 'revision'),
    updatedAt: text(row, 'updated_at'),
  });
}

export function mapLock(row: DatabaseRow): Lock {
  return lockSchema.parse({
    id: text(row, 'id'),
    key: text(row, 'key'),
    operationId: text(row, 'operation_id'),
    fencingToken: integer(row, 'fencing_token'),
    acquiredAt: text(row, 'acquired_at'),
    expiresAt: text(row, 'expires_at'),
    ...(optionalText(row, 'released_at') === undefined
      ? {}
      : { releasedAt: optionalText(row, 'released_at') }),
  });
}
