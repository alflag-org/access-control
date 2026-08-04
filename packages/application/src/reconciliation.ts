import {
  authoritativePlanContextSchema,
  type AuthoritativePlanContext,
  type ProvisioningAdapter,
} from '@access-control/contracts';
import {
  AccessControlError,
  NotFoundError,
  RevisionConflictError,
  canonicalJson,
  createOperationCandidate,
  createOperationPlanCandidate,
  createOperationPlanChangeCandidate,
  createOperationStepCandidate,
  createProviderObservationCandidate,
  createProvisioningStateCandidate,
  type JsonObject,
  type Operation,
  type OperationPlan,
  type OperationPlanChange,
  type OperationStep,
  type ProviderConnection,
  type ProviderObservation,
  type ProvisioningState,
  type ProvisioningTarget,
} from '@access-control/domain';
import { createMutationRecords } from './events';
import { calculateOperationPlanHash } from './plan-hash';
import type { CatalogRepository, IdentityRepository, ProvisioningRepository } from './ports';
import type { ServiceRuntime } from './runtime';
import type { RequiredActorContext } from './catalog';

export interface CreatePlanInput {
  provisioningStateId: string;
  expectedRevision: number;
}

export class ReconciliationService {
  public constructor(
    private readonly repository: ProvisioningRepository,
    private readonly identities: Pick<
      IdentityRepository,
      'getGuestProfile' | 'getOrganizationSettings' | 'getSubject'
    >,
    private readonly catalog: Pick<
      CatalogRepository,
      'getApplicationEntitlement' | 'listEffectiveGrants'
    >,
    private readonly adapters: ReadonlyMap<string, ProvisioningAdapter>,
    private readonly runtime: ServiceRuntime,
  ) {}

  public async observe(connectionId: string, targetId: string, context: RequiredActorContext) {
    const [connection, target] = await Promise.all([
      this.requireConnection(connectionId),
      this.requireTarget(targetId),
    ]);
    this.assertTargetConnection(connection, target);
    const adapter = this.requireAdapter(connection.provider);
    const draft = await adapter.observe({
      providerConnectionId: connection.id,
      provisioningTargetId: target.id,
      configuration: target.configuration,
    });
    const observation = createProviderObservationCandidate(draft);
    await this.repository.persistObservation(
      observation,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.provider.observed',
        topic: 'access-control.provider.observed',
        targetType: 'provider_observation',
        targetId: observation.id,
        action: 'observe',
        ...(observation.payloadRef === undefined
          ? {}
          : { providerEvidenceRef: observation.payloadRef }),
        payload: {
          providerConnectionId: connection.id,
          provisioningTargetId: target.id,
          checksum: observation.checksum,
        },
      }),
    );
    return observation;
  }

  public async createPlan(
    input: CreatePlanInput,
    context: RequiredActorContext,
  ): Promise<OperationPlan> {
    const authority = await this.loadAuthoritativePlanContext(
      input.provisioningStateId,
      input.expectedRevision,
    );
    const { organizationSettings, providerConnection, provisioningTarget, provisioningState } =
      authority;
    const connection = providerConnection;
    const target = provisioningTarget;
    const currentState = provisioningState;
    if (connection.mode === 'observe' || target.mode === 'observe') {
      throw new AccessControlError(
        409,
        'observe_mode_blocks_plan',
        'Provider connection and target must both permit plan creation.',
      );
    }
    const adapter = this.requireAdapter(connection.provider);
    const providerPlan = await adapter.plan(authority);
    if (providerPlan.blockedReason !== undefined) {
      throw new AccessControlError(
        422,
        providerPlan.blockedReason,
        'The provider plan is blocked.',
      );
    }
    if (providerPlan.changes.length > organizationSettings.maxPlanChanges) {
      throw new AccessControlError(
        409,
        'bulk_change_threshold_exceeded',
        `The plan contains ${providerPlan.changes.length} changes; the configured maximum is ${organizationSettings.maxPlanChanges}.`,
      );
    }
    const planId = this.runtime.id('plan');
    const changes = providerPlan.changes.map((change) =>
      createOperationPlanChangeCandidate({
        ...change,
        id: this.runtime.id('plan-change'),
        operationPlanId: planId,
      }),
    );
    const state = createProvisioningStateCandidate({
      ...currentState,
      desiredState: authority.requiredProvisioningTargets.some(
        (candidate) => candidate.id === target.id,
      )
        ? 'present'
        : 'absent',
      status: 'planned',
      lastObservationId: authority.observation.id,
      lastPlanId: planId,
      revision: currentState.revision + 1,
      updatedAt: this.runtime.now(),
    });
    const inputRevisions = this.inputRevisions(authority, state.revision);
    const effectiveGrantIds = authority.effectiveGrants.map((grant) => grant.id).sort();
    const requiredProvisioningTargetIds = authority.requiredProvisioningTargets
      .map((candidate) => candidate.id)
      .sort();
    const planHash = await calculateOperationPlanHash({
      providerConnectionId: connection.id,
      provisioningTargetId: target.id,
      provisioningStateId: currentState.id,
      subjectId: authority.subject.id,
      entitlementId: authority.entitlement.id,
      observationId: authority.observation.id,
      observationChecksum: authority.observation.checksum,
      effectiveGrantIds,
      requiredProvisioningTargetIds,
      inputRevisions,
      changes,
    });
    const plan = createOperationPlanCandidate({
      id: planId,
      providerConnectionId: connection.id,
      provisioningTargetId: target.id,
      provisioningStateId: currentState.id,
      subjectId: authority.subject.id,
      entitlementId: authority.entitlement.id,
      observationId: authority.observation.id,
      observationChecksum: authority.observation.checksum,
      effectiveGrantIds,
      requiredProvisioningTargetIds,
      planHash,
      destructive: providerPlan.destructive,
      protected: providerPlan.protected || target.protected,
      inputRevisions,
      status: 'persisted',
      createdBy: context.actorSubjectId,
      createdAt: this.runtime.now(),
    });
    await this.repository.persistOperationPlan(
      plan,
      changes,
      state,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.plan.created',
        topic: 'access-control.plan.created',
        targetType: 'operation_plan',
        targetId: plan.id,
        action: 'create',
        payload: {
          planHash: plan.planHash,
          changeCount: changes.length,
          destructive: plan.destructive,
          protected: plan.protected,
        },
      }),
      authority,
    );
    return plan;
  }

  public async startOperation(
    planId: string,
    input: { confirmed: boolean },
    context: RequiredActorContext,
  ): Promise<Operation> {
    const plan = await this.repository.getOperationPlan(planId);
    if (plan === null) throw new NotFoundError('Operation plan', planId);
    if ((await this.repository.getOperationByPlanId(plan.id)) !== null) {
      throw new AccessControlError(
        409,
        'operation_already_exists',
        'The Operation Plan already has an Operation.',
      );
    }
    if (plan.protected && !input.confirmed) {
      throw new AccessControlError(
        422,
        'protected_operation_confirmation_required',
        'Creating an operation for a protected plan requires explicit confirmation.',
      );
    }
    const changes = await this.repository.listOperationPlanChanges(plan.id);
    const now = this.runtime.now();
    const operation = createOperationCandidate({
      id: this.runtime.id('operation'),
      operationPlanId: plan.id,
      status: 'running',
      explicit: true,
      revision: 1,
      createdBy: context.actorSubjectId,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    });
    const steps = changes.map((change) =>
      createOperationStepCandidate({
        id: this.runtime.id('operation-step'),
        operationId: operation.id,
        position: change.position,
        name: change.action,
        status: 'planned',
        evidence: {},
        revision: 1,
        updatedAt: now,
      }),
    );
    try {
      await this.repository.createOperation(
        operation,
        steps,
        createMutationRecords(this.runtime, context, {
          eventType: 'access-control.operation.started',
          topic: 'access-control.operation.started',
          targetType: 'operation',
          targetId: operation.id,
          action: 'start',
          resultingRevision: 1,
          payload: { planId: plan.id, planHash: plan.planHash, protected: plan.protected },
        }),
      );
    } catch (error) {
      if (error instanceof AccessControlError && error.code === 'uniqueness_conflict') {
        throw new AccessControlError(
          409,
          'operation_already_exists',
          'The Operation Plan already has an Operation.',
        );
      }
      throw error;
    }
    return operation;
  }

  public async executeOperation(
    operationId: string,
    options: { writesEnabled: boolean },
    context: RequiredActorContext,
  ): Promise<Operation> {
    const operation = await this.repository.getOperation(operationId);
    if (operation === null) throw new NotFoundError('Operation', operationId);
    if (operation.status === 'applying') {
      return this.recoverApplyingOperation(operation, context);
    }
    if (operation.status !== 'running') {
      throw new AccessControlError(
        409,
        'operation_not_executable',
        'Only a running Operation can be claimed for provider apply.',
      );
    }
    const plan = await this.repository.getOperationPlan(operation.operationPlanId);
    if (plan === null) throw new NotFoundError('Operation plan', operation.operationPlanId);
    const expectedStateRevision =
      plan.inputRevisions[revisionKey('state', plan.provisioningStateId)];
    if (expectedStateRevision === undefined) {
      throw new AccessControlError(
        409,
        'plan_input_revision_missing',
        'The persisted plan does not fix its Provisioning State revision.',
      );
    }
    const [authority, changes, steps] = await Promise.all([
      this.loadAuthoritativePlanContext(plan.provisioningStateId, expectedStateRevision),
      this.repository.listOperationPlanChanges(plan.id),
      this.repository.listOperationSteps(operation.id),
    ]);
    this.assertPlanAuthorityCurrent(plan, authority);
    this.assertOperationSteps(operation, changes, steps);
    const connection = authority.providerConnection;
    const target = authority.provisioningTarget;
    if (connection.mode === 'observe' || target.mode === 'observe') {
      throw new AccessControlError(
        409,
        'observe_mode_blocks_apply',
        'Observe mode cannot apply provider changes.',
      );
    }
    if (changes.length > authority.organizationSettings.maxPlanChanges) {
      throw new AccessControlError(
        409,
        'bulk_change_threshold_exceeded',
        'The persisted plan exceeds the current bulk threshold.',
      );
    }
    if (plan.protected || changes.some((change) => change.protected)) {
      throw new AccessControlError(
        409,
        'protected_change_apply_forbidden',
        'Protected changes cannot be applied automatically.',
      );
    }
    if (connection.provider === 'github' && !options.writesEnabled) {
      throw new AccessControlError(409, 'github_writes_disabled', 'GitHub writes are disabled.');
    }
    const recalculatedHash = await calculateOperationPlanHash({
      providerConnectionId: plan.providerConnectionId,
      provisioningTargetId: plan.provisioningTargetId,
      provisioningStateId: plan.provisioningStateId,
      subjectId: plan.subjectId,
      entitlementId: plan.entitlementId,
      observationId: plan.observationId,
      observationChecksum: plan.observationChecksum,
      effectiveGrantIds: plan.effectiveGrantIds,
      requiredProvisioningTargetIds: plan.requiredProvisioningTargetIds,
      inputRevisions: plan.inputRevisions,
      changes,
    });
    if (recalculatedHash !== plan.planHash) {
      throw new AccessControlError(
        409,
        'plan_hash_mismatch',
        'The persisted plan does not match its SHA-256 hash.',
      );
    }
    const lock = await this.requiredLock(target, operation.id);
    const adapter = this.requireAdapter(connection.provider);
    const applying = createOperationCandidate({
      ...operation,
      status: 'applying',
      revision: operation.revision + 1,
      updatedAt: this.runtime.now(),
    });
    const applyingState = createProvisioningStateCandidate({
      ...authority.provisioningState,
      status: 'applying',
      evidence: { operationId: operation.id, planId: plan.id },
      revision: authority.provisioningState.revision + 1,
      updatedAt: this.runtime.now(),
    });
    const claimed = await this.repository.claimOperation(
      applying,
      applyingState,
      createMutationRecords(this.runtime, context, {
        eventType: 'access-control.operation.claimed',
        topic: 'access-control.operation.claimed',
        targetType: 'operation',
        targetId: operation.id,
        action: 'claim',
        previousRevision: operation.revision,
        resultingRevision: applying.revision,
        payload: { planHash: plan.planHash },
      }),
      operation.revision,
      authority.provisioningState.revision,
      authority,
    );
    if (!claimed) {
      throw new AccessControlError(
        409,
        'operation_already_claimed',
        'Another executor already claimed the Operation.',
      );
    }

    for (const [position, change] of changes.entries()) {
      let step = await this.transitionOperationStep(steps[position]!, 'running', {}, context);
      if (
        !(await this.repository.isPlanAuthorityCurrent({
          ...authority,
          evaluatedAt: this.runtime.now(),
        }))
      ) {
        step = await this.transitionOperationStep(
          step,
          'blocked',
          { errorCode: 'plan_inputs_changed' },
          context,
        );
        await this.persistExecutionRecords(
          applying,
          applyingState,
          {
            operationStatus: 'action_required',
            provisioningStatus: 'action_required',
            errorCode: 'plan_inputs_changed',
            eventType: 'access-control.operation.action-required',
            action: 'require-action',
            payload: {
              planHash: plan.planHash,
              stepId: step.id,
              errorCode: 'plan_inputs_changed',
            },
          },
          context,
        );
        throw new AccessControlError(
          409,
          'plan_inputs_changed',
          'The server-authoritative records used by the persisted plan changed during execution.',
        );
      }
      let result;
      try {
        result = await adapter.apply({
          operationId: operation.id,
          operationPlanId: plan.id,
          planHash: recalculatedHash,
          persistedPlanHash: plan.planHash,
          operationStatus: 'applying',
          connectionMode: connection.mode,
          writesEnabled: options.writesEnabled,
          change,
          ...(lock === null
            ? {}
            : { fencingToken: lock.fencingToken, lockExpiresAt: lock.expiresAt }),
        });
      } catch (error) {
        const executionError = stableExecutionError(error, 'provider_apply_failed');
        step = await this.transitionOperationStep(
          step,
          'failed',
          { errorCode: executionError.code },
          context,
        );
        await this.persistExecutionRecords(
          applying,
          applyingState,
          {
            operationStatus: 'failed',
            provisioningStatus: 'failed',
            errorCode: executionError.code,
            terminal: true,
            eventType: 'access-control.operation.failed',
            action: 'fail',
            payload: { planHash: plan.planHash, stepId: step.id, errorCode: executionError.code },
          },
          context,
        );
        throw executionError;
      }

      if (result.status !== 'applied') {
        step = await this.transitionOperationStep(
          step,
          'blocked',
          { ...result.evidence, applyStatus: result.status },
          context,
        );
        const waiting = result.status === 'waiting_for_invitation';
        const transitioned = await this.persistExecutionRecords(
          applying,
          applyingState,
          {
            operationStatus: waiting ? 'waiting_for_invitation' : 'action_required',
            provisioningStatus: waiting ? 'waiting_for_invitation' : 'action_required',
            eventType: waiting
              ? 'access-control.operation.waiting-for-invitation'
              : 'access-control.operation.action-required',
            action: waiting ? 'wait' : 'require-action',
            payload: { planHash: plan.planHash, stepId: step.id, applyStatus: result.status },
          },
          context,
        );
        return transitioned.operation;
      }
      await this.transitionOperationStep(step, 'completed', result.evidence, context);
    }

    const verifyingRecords = await this.persistExecutionRecords(
      applying,
      applyingState,
      {
        operationStatus: 'verifying',
        provisioningStatus: 'verifying',
        eventType: 'access-control.operation.verifying',
        action: 'verify',
        payload: { planHash: plan.planHash },
      },
      context,
    );
    let verifiedObservation: ProviderObservation | undefined;
    try {
      verifiedObservation = createProviderObservationCandidate(
        await adapter.verify({
          operationId: operation.id,
          operationPlanId: plan.id,
          planHash: plan.planHash,
          observation: {
            providerConnectionId: connection.id,
            provisioningTargetId: target.id,
            configuration: target.configuration,
          },
        }),
      );
      this.assertVerificationObservation(verifiedObservation, connection.id, target.id);
      await this.repository.persistObservation(
        verifiedObservation,
        createMutationRecords(this.runtime, context, {
          eventType: 'access-control.provider.verified',
          topic: 'access-control.provider.verified',
          targetType: 'provider_observation',
          targetId: verifiedObservation.id,
          action: 'verify',
          ...(verifiedObservation.payloadRef === undefined
            ? {}
            : { providerEvidenceRef: verifiedObservation.payloadRef }),
          payload: {
            operationId: operation.id,
            planHash: plan.planHash,
            checksum: verifiedObservation.checksum,
          },
        }),
      );
      if (verifiedObservation.status !== 'complete' || verifiedObservation.payload === undefined) {
        throw new AccessControlError(
          409,
          'provider_verification_failed',
          'Provider verification did not return a complete inline observation.',
        );
      }
      const remainingPlan = await adapter.plan({
        ...authority,
        provisioningState: verifyingRecords.state,
        observation: verifiedObservation,
      });
      if (remainingPlan.blockedReason !== undefined || remainingPlan.changes.length > 0) {
        throw new AccessControlError(
          409,
          'verification_mismatch',
          'The verified provider state does not match the persisted plan expectation.',
          [],
          {
            remainingChangeCount: remainingPlan.changes.length,
            ...(remainingPlan.blockedReason === undefined
              ? {}
              : { blockedReason: remainingPlan.blockedReason }),
          },
        );
      }
    } catch (error) {
      const verificationError = stableExecutionError(error, 'provider_verification_failed');
      await this.persistExecutionRecords(
        verifyingRecords.operation,
        verifyingRecords.state,
        {
          operationStatus: 'failed',
          provisioningStatus: 'failed',
          errorCode: verificationError.code,
          terminal: true,
          ...(verifiedObservation === undefined ? {} : { observation: verifiedObservation }),
          eventType: 'access-control.operation.failed',
          action: 'fail',
          payload: { planHash: plan.planHash, errorCode: verificationError.code },
        },
        context,
      );
      throw verificationError;
    }

    if (verifiedObservation === undefined) {
      throw new AccessControlError(
        409,
        'provider_verification_failed',
        'Provider verification did not return an observation.',
      );
    }

    const completed = await this.persistExecutionRecords(
      verifyingRecords.operation,
      verifyingRecords.state,
      {
        operationStatus: 'completed',
        provisioningStatus: 'converged',
        observedState: verifyingRecords.state.desiredState,
        observation: verifiedObservation,
        terminal: true,
        eventType: 'access-control.operation.completed',
        action: 'complete',
        payload: {
          planHash: plan.planHash,
          observationId: verifiedObservation.id,
          checksum: verifiedObservation.checksum,
        },
      },
      context,
    );
    return completed.operation;
  }

  private async recoverApplyingOperation(
    operation: Operation,
    context: RequiredActorContext,
  ): Promise<Operation> {
    const plan = await this.repository.getOperationPlan(operation.operationPlanId);
    if (plan === null) throw new NotFoundError('Operation plan', operation.operationPlanId);
    const state = await this.repository.getProvisioningState(plan.provisioningStateId);
    if (
      state === null ||
      state.status !== 'applying' ||
      state.lastPlanId !== plan.id ||
      state.evidence.operationId !== operation.id
    ) {
      throw new AccessControlError(
        409,
        'operation_recovery_state_invalid',
        'The applying Operation no longer matches its Provisioning State.',
      );
    }
    const [connection, target, changes, steps] = await Promise.all([
      this.repository.getProviderConnection(plan.providerConnectionId),
      this.repository.getProvisioningTarget(plan.provisioningTargetId),
      this.repository.listOperationPlanChanges(plan.id),
      this.repository.listOperationSteps(operation.id),
    ]);
    this.assertRecoverableOperationSteps(operation, changes, steps);
    let observation: ProviderObservation | undefined;
    let recoveryObservationError: string | undefined;
    if (connection !== null && target !== null && target.providerConnectionId === connection.id) {
      try {
        const adapter = this.requireAdapter(connection.provider);
        observation = createProviderObservationCandidate(
          await adapter.verify({
            operationId: operation.id,
            operationPlanId: plan.id,
            planHash: plan.planHash,
            observation: {
              providerConnectionId: connection.id,
              provisioningTargetId: target.id,
              configuration: target.configuration,
            },
          }),
        );
        this.assertVerificationObservation(observation, connection.id, target.id);
        await this.repository.persistObservation(
          observation,
          createMutationRecords(this.runtime, context, {
            eventType: 'access-control.provider.recovery-observed',
            topic: 'access-control.provider.recovery-observed',
            targetType: 'provider_observation',
            targetId: observation.id,
            action: 'recover',
            payload: { operationId: operation.id, planHash: plan.planHash },
          }),
        );
      } catch (error) {
        observation = undefined;
        recoveryObservationError = stableExecutionError(
          error,
          'provider_recovery_observation_failed',
        ).code;
      }
    } else {
      recoveryObservationError = 'operation_recovery_context_missing';
    }
    const recoveryObservationEvidence =
      observation === undefined
        ? {
            recoveryObservationError:
              recoveryObservationError ?? 'provider_recovery_observation_failed',
          }
        : { recoveryObservationId: observation.id };
    const runningStep = steps.find((step) => step.status === 'running');
    const recoveredStep =
      runningStep === undefined
        ? undefined
        : await this.transitionOperationStep(
            runningStep,
            'blocked',
            {
              errorCode: 'provider_apply_outcome_ambiguous',
              ...recoveryObservationEvidence,
            },
            context,
          );
    const recovered = await this.persistExecutionRecords(
      operation,
      state,
      {
        operationStatus: 'action_required',
        provisioningStatus: 'action_required',
        errorCode: 'provider_apply_outcome_ambiguous',
        ...(observation === undefined ? {} : { observation }),
        eventType: 'access-control.operation.recovery-required',
        action: 'require-action',
        payload: {
          planHash: plan.planHash,
          ...(observation === undefined
            ? recoveryObservationEvidence
            : { observationId: observation.id }),
          ...(recoveredStep === undefined ? {} : { stepId: recoveredStep.id }),
        },
      },
      context,
    );
    return recovered.operation;
  }

  private assertOperationSteps(
    operation: Operation,
    changes: OperationPlanChange[],
    steps: OperationStep[],
  ): void {
    const valid =
      changes.length === steps.length &&
      changes.every(
        (change, position) =>
          change.position === position &&
          steps[position]?.operationId === operation.id &&
          steps[position]?.position === position &&
          steps[position]?.name === change.action &&
          steps[position]?.status === 'planned',
      );
    if (!valid) {
      throw new AccessControlError(
        409,
        'operation_steps_invalid',
        'Operation Steps do not match the persisted plan changes.',
      );
    }
  }

  private assertRecoverableOperationSteps(
    operation: Operation,
    changes: OperationPlanChange[],
    steps: OperationStep[],
  ): void {
    const runningSteps = steps.filter((step) => step.status === 'running');
    const valid =
      changes.length === steps.length &&
      runningSteps.length <= 1 &&
      changes.every(
        (change, position) =>
          change.position === position &&
          steps[position]?.operationId === operation.id &&
          steps[position]?.position === position &&
          steps[position]?.name === change.action &&
          ['planned', 'running', 'completed', 'blocked'].includes(steps[position]!.status),
      );
    if (!valid) {
      throw new AccessControlError(
        409,
        'operation_steps_invalid',
        'Operation Steps do not match the applying Operation.',
      );
    }
  }

  private async transitionOperationStep(
    step: OperationStep,
    status: OperationStep['status'],
    evidence: JsonObject,
    context: RequiredActorContext,
  ): Promise<OperationStep> {
    const transitioned = createOperationStepCandidate({
      ...step,
      status,
      evidence,
      revision: step.revision + 1,
      updatedAt: this.runtime.now(),
    });
    await this.repository.updateOperationStep(
      transitioned,
      createMutationRecords(this.runtime, context, {
        eventType: `access-control.operation-step.${status}`,
        topic: `access-control.operation-step.${status}`,
        targetType: 'operation_step',
        targetId: step.id,
        action: status,
        previousRevision: step.revision,
        resultingRevision: transitioned.revision,
        payload: { operationId: step.operationId, position: step.position },
      }),
      step.revision,
    );
    return transitioned;
  }

  private async persistExecutionRecords(
    operation: Operation,
    state: ProvisioningState,
    transition: {
      operationStatus: Operation['status'];
      provisioningStatus: ProvisioningState['status'];
      eventType: string;
      action: string;
      payload: JsonObject;
      errorCode?: string;
      terminal?: boolean;
      observedState?: ProvisioningState['observedState'];
      observation?: ProviderObservation;
    },
    context: RequiredActorContext,
  ): Promise<{ operation: Operation; state: ProvisioningState }> {
    const now = this.runtime.now();
    const nextOperation = createOperationCandidate({
      ...operation,
      status: transition.operationStatus,
      revision: operation.revision + 1,
      updatedAt: now,
      ...(transition.terminal === true ? { completedAt: now } : {}),
      ...(transition.errorCode === undefined ? {} : { errorCode: transition.errorCode }),
    });
    const nextState = createProvisioningStateCandidate({
      ...state,
      status: transition.provisioningStatus,
      ...(transition.observedState === undefined
        ? {}
        : { observedState: transition.observedState }),
      ...(transition.observation === undefined
        ? {}
        : { lastObservationId: transition.observation.id }),
      evidence: {
        operationId: operation.id,
        planId: operation.operationPlanId,
        ...transition.payload,
      },
      revision: state.revision + 1,
      updatedAt: now,
    });
    await this.repository.updateOperationAndState(
      nextOperation,
      nextState,
      createMutationRecords(this.runtime, context, {
        eventType: transition.eventType,
        topic: transition.eventType,
        targetType: 'operation',
        targetId: operation.id,
        action: transition.action,
        previousRevision: operation.revision,
        resultingRevision: nextOperation.revision,
        ...(transition.observation?.payloadRef === undefined
          ? {}
          : { providerEvidenceRef: transition.observation.payloadRef }),
        payload: transition.payload,
      }),
      operation.revision,
      state.revision,
    );
    return { operation: nextOperation, state: nextState };
  }

  private assertVerificationObservation(
    observation: ProviderObservation,
    providerConnectionId: string,
    provisioningTargetId: string,
  ): void {
    if (
      observation.providerConnectionId !== providerConnectionId ||
      observation.provisioningTargetId !== provisioningTargetId
    ) {
      throw new AccessControlError(
        409,
        'verification_observation_mismatch',
        'The verification observation belongs to another Provider Connection or Target.',
      );
    }
  }

  private async loadAuthoritativePlanContext(
    provisioningStateId: string,
    expectedRevision: number,
  ): Promise<AuthoritativePlanContext> {
    const provisioningState = await this.repository.getProvisioningState(provisioningStateId);
    if (provisioningState === null) {
      throw new NotFoundError('Provisioning state', provisioningStateId);
    }
    if (provisioningState.revision !== expectedRevision) {
      throw new RevisionConflictError(expectedRevision, provisioningState.revision);
    }
    const [provisioningTarget, subject] = await Promise.all([
      this.requireTarget(provisioningState.provisioningTargetId),
      this.identities.getSubject(provisioningState.subjectId),
    ]);
    if (subject === null) throw new NotFoundError('Subject', provisioningState.subjectId);
    if (
      provisioningState.provisioningTargetId !== provisioningTarget.id ||
      provisioningState.subjectId !== subject.id
    ) {
      throw new AccessControlError(
        409,
        'provisioning_state_relationship_mismatch',
        'The Provisioning State no longer matches its Subject and Provisioning Target.',
      );
    }
    const [providerConnection, entitlement] = await Promise.all([
      this.requireConnection(provisioningTarget.providerConnectionId),
      this.catalog.getApplicationEntitlement(provisioningTarget.applicationEntitlementId),
    ]);
    if (entitlement === null) {
      throw new NotFoundError(
        'Application entitlement',
        provisioningTarget.applicationEntitlementId,
      );
    }
    this.assertTargetConnection(providerConnection, provisioningTarget);
    if (provisioningTarget.applicationEntitlementId !== entitlement.id) {
      throw new AccessControlError(
        409,
        'target_entitlement_mismatch',
        'The Provisioning Target no longer matches its Application Entitlement.',
      );
    }
    const effectiveAt = this.runtime.now();
    const [
      organizationSettings,
      subjectGrants,
      providerAccounts,
      observation,
      requiredProvisioningTargets,
    ] = await Promise.all([
      this.identities.getOrganizationSettings(),
      this.catalog.listEffectiveGrants(subject.id),
      this.repository.listProviderAccounts(subject.id),
      this.repository.getLatestCompleteObservation(providerConnection.id, provisioningTarget.id),
      this.repository.listRequiredProvisioningTargets(subject.id, effectiveAt),
    ]);
    if (organizationSettings === null) {
      throw new NotFoundError('Organization settings', 'organization');
    }
    if (observation === null) {
      throw new AccessControlError(
        409,
        'complete_observation_required',
        'A current complete Provider Observation is required before plan creation.',
      );
    }
    if (observation.payload === undefined) {
      throw new AccessControlError(
        409,
        'inline_observation_required',
        'Plan creation requires the latest Provider Observation payload to be available inline.',
      );
    }
    const guestProfile =
      subject.classification === 'managed_guest'
        ? await this.identities.getGuestProfile(subject.id)
        : null;
    const sponsor =
      guestProfile === null
        ? null
        : await this.identities.getSubject(guestProfile.sponsorSubjectId);
    const matchingAccounts = providerAccounts.filter(
      (account) => account.providerConnectionId === providerConnection.id,
    );
    if (matchingAccounts.length > 1) {
      throw new AccessControlError(
        409,
        'provider_account_ambiguous',
        'More than one Provider Account matches the Subject and Provider Connection.',
      );
    }
    const evaluatedAtMs = Date.parse(effectiveAt);
    const subjectCanHoldAccess =
      subject.status === 'active' &&
      subject.directoryState === 'active' &&
      (subject.classification !== 'managed_guest' ||
        (guestProfile !== null &&
          guestProfile.status === 'active' &&
          Date.parse(guestProfile.validFrom) <= evaluatedAtMs &&
          Date.parse(guestProfile.expiresAt) > evaluatedAtMs &&
          sponsor?.status === 'active'));
    const effectiveGrants = subjectCanHoldAccess
      ? subjectGrants
          .filter(
            (grant) =>
              grant.status === 'active' &&
              (grant.validUntil === undefined ||
                Date.parse(grant.validUntil) > Date.parse(effectiveAt)),
          )
          .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    const activeRequiredTargets = subjectCanHoldAccess
      ? requiredProvisioningTargets.sort((left, right) => left.id.localeCompare(right.id))
      : [];
    return authoritativePlanContextSchema.parse({
      evaluatedAt: effectiveAt,
      organizationSettings,
      subject,
      entitlement,
      providerConnection,
      provisioningTarget,
      provisioningState,
      ...(matchingAccounts[0] === undefined ? {} : { providerAccount: matchingAccounts[0] }),
      effectiveGrants,
      requiredProvisioningTargets: activeRequiredTargets,
      observation,
    });
  }

  private inputRevisions(
    authority: AuthoritativePlanContext,
    provisioningStateRevision = authority.provisioningState.revision,
  ): Record<string, number> {
    const revisions: Array<readonly [string, number]> = [
      [
        revisionKey('organization', authority.organizationSettings.id),
        authority.organizationSettings.revision,
      ],
      [revisionKey('subject', authority.subject.id), authority.subject.revision],
      [revisionKey('entitlement', authority.entitlement.id), authority.entitlement.revision],
      [
        revisionKey('connection', authority.providerConnection.id),
        authority.providerConnection.revision,
      ],
      [
        revisionKey('target', authority.provisioningTarget.id),
        authority.provisioningTarget.revision,
      ],
      [revisionKey('state', authority.provisioningState.id), provisioningStateRevision],
      ...(authority.providerAccount === undefined
        ? []
        : ([
            [
              revisionKey('account', authority.providerAccount.id),
              authority.providerAccount.revision,
            ],
          ] as const)),
      ...authority.requiredProvisioningTargets.map(
        (target) => [revisionKey('target', target.id), target.revision] as const,
      ),
    ];
    return Object.fromEntries(revisions.sort(([left], [right]) => left.localeCompare(right)));
  }

  private assertPlanAuthorityCurrent(
    plan: OperationPlan,
    authority: AuthoritativePlanContext,
  ): void {
    const effectiveGrantIds = authority.effectiveGrants.map((grant) => grant.id).sort();
    const requiredProvisioningTargetIds = authority.requiredProvisioningTargets
      .map((target) => target.id)
      .sort();
    const relationshipsMatch =
      plan.providerConnectionId === authority.providerConnection.id &&
      plan.provisioningTargetId === authority.provisioningTarget.id &&
      plan.provisioningStateId === authority.provisioningState.id &&
      plan.subjectId === authority.subject.id &&
      plan.entitlementId === authority.entitlement.id &&
      authority.provisioningState.lastPlanId === plan.id;
    const inputsMatch =
      canonicalJson(plan.inputRevisions) === canonicalJson(this.inputRevisions(authority)) &&
      canonicalJson(plan.effectiveGrantIds) === canonicalJson(effectiveGrantIds) &&
      canonicalJson(plan.requiredProvisioningTargetIds) ===
        canonicalJson(requiredProvisioningTargetIds) &&
      plan.observationId === authority.observation.id &&
      plan.observationChecksum === authority.observation.checksum;
    if (!relationshipsMatch || !inputsMatch) {
      throw new AccessControlError(
        409,
        'plan_inputs_changed',
        'The server-authoritative records used by the persisted plan have changed.',
      );
    }
  }

  private requireAdapter(provider: string): ProvisioningAdapter {
    const adapter = this.adapters.get(provider);
    if (adapter === undefined) {
      throw new AccessControlError(
        422,
        'provider_adapter_unavailable',
        `No ${provider} adapter is registered.`,
      );
    }
    return adapter;
  }

  private async requireConnection(id: string): Promise<ProviderConnection> {
    const connection = await this.repository.getProviderConnection(id);
    if (connection === null) throw new NotFoundError('Provider connection', id);
    if (connection.status !== 'active') {
      throw new AccessControlError(
        422,
        'provider_connection_inactive',
        'The provider connection is not active.',
      );
    }
    return connection;
  }

  private async requireTarget(id: string): Promise<ProvisioningTarget> {
    const target = await this.repository.getProvisioningTarget(id);
    if (target === null) throw new NotFoundError('Provisioning target', id);
    if (target.status !== 'active') {
      throw new AccessControlError(
        422,
        'provisioning_target_inactive',
        'The provisioning target is not active.',
      );
    }
    return target;
  }

  private assertTargetConnection(connection: ProviderConnection, target: ProvisioningTarget): void {
    if (target.providerConnectionId !== connection.id) {
      throw new AccessControlError(
        422,
        'target_connection_mismatch',
        'The target belongs to another provider connection.',
      );
    }
  }

  private async requiredLock(target: ProvisioningTarget, operationId: string) {
    if (target.configuration.requiresLock !== true) return null;
    const lock = await this.repository.getLock(`target:${target.id}`);
    if (
      lock === null ||
      lock.operationId !== operationId ||
      Date.parse(lock.expiresAt) <= Date.parse(this.runtime.now())
    ) {
      throw new AccessControlError(
        409,
        'operation_lock_required',
        'A current operation lock and fencing token are required.',
      );
    }
    return lock;
  }
}

function revisionKey(entityType: string, id: string): string {
  return `${entityType}:${id}`;
}

function stableExecutionError(error: unknown, fallbackCode: string): AccessControlError {
  if (error instanceof AccessControlError) return error;
  return new AccessControlError(
    503,
    fallbackCode,
    'The provider execution did not complete successfully.',
  );
}

export async function checksumJson(payload: JsonObject): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(payload)),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
