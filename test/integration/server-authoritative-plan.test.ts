import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ReconciliationService } from '@access-control/application';
import type { ProvisioningAdapter } from '@access-control/contracts';
import { createD1Repositories } from '@access-control/d1';
import { GitHubProvisioningAdapter } from '@access-control/github';
import { AccessControlError } from '@access-control/domain';
import { FIXTURE_TIME, fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const observationChecksum = `sha256:${'a'.repeat(64)}`;

describe('Server-authoritative Operation Plan generation', () => {
  it('derives desired and observed state from current D1 records', async () => {
    const bootstrap = await bootstrapAdministrator(env.DB);
    await seedPlanRecords(bootstrap.subject.id);
    const repositories = createD1Repositories(env.DB);
    await env.DB.prepare(
      `UPDATE effective_grants SET valid_until = '2026-01-01T01:00:00+02:00'
       WHERE id = 'grant:github-member'`,
    ).run();
    await expect(
      repositories.provisioning.listRequiredProvisioningTargets(bootstrap.subject.id, FIXTURE_TIME),
    ).resolves.toEqual([]);
    await env.DB.prepare(
      `UPDATE effective_grants SET valid_until = NULL WHERE id = 'grant:github-member'`,
    ).run();
    const adapter = new GitHubProvisioningAdapter(
      async () => {
        throw new Error('Plan calculation must not call the GitHub transport.');
      },
      false,
      () => FIXTURE_TIME,
    );
    const service = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', adapter]]),
      fixtureRuntime(FIXTURE_TIME, 'authoritative-plan'),
    );

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE effective_grants SET status = 'expired'
         WHERE id = 'grant:github-member'`,
      ),
      env.DB.prepare(
        `UPDATE provider_observations SET payload_json = ?, checksum = ?
         WHERE id = 'observation:github-member'`,
      ).bind(
        JSON.stringify({
          organization: 'example-organization',
          members: [{ id: 1001, login: 'local-admin', role: 'admin' }],
          invitations: [],
          teams: [],
        }),
        `sha256:${'b'.repeat(64)}`,
      ),
    ]);
    await expect(
      service.createPlan(
        { provisioningStateId: 'state:github-member', expectedRevision: 1 },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:final-owner' },
      ),
    ).rejects.toMatchObject({ code: 'github_last_owner_forbidden' });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE effective_grants SET status = 'active'
         WHERE id = 'grant:github-member'`,
      ),
      env.DB.prepare(
        `INSERT INTO provisioning_targets (
          id, provider_connection_id, application_entitlement_id, target_type,
          provider_target_id, mode, protected, configuration_json, status,
          revision, created_at, updated_at, created_by, updated_by
        ) VALUES (
          'target:github-team', 'provider:github', 'entitlement:github-member',
          'github_team_membership', 'platform', 'plan', 0, '{}', 'active',
          1, ?, ?, ?, ?
        )`,
      ).bind(FIXTURE_TIME, FIXTURE_TIME, bootstrap.subject.id, bootstrap.subject.id),
      env.DB.prepare(
        `UPDATE entitlement_mapping_targets SET provisioning_target_id = 'target:github-team'
         WHERE mapping_id = 'mapping:github-member'
           AND provisioning_target_id = 'target:github-member'`,
      ),
      env.DB.prepare(
        `UPDATE provider_observations SET payload_json = ?, checksum = ?
         WHERE id = 'observation:github-member'`,
      ).bind(
        JSON.stringify({
          organization: 'example-organization',
          members: [{ id: 1001, login: 'local-admin', role: 'member' }],
          invitations: [],
          teams: [],
        }),
        `sha256:${'c'.repeat(64)}`,
      ),
    ]);
    await expect(
      service.createPlan(
        { provisioningStateId: 'state:github-member', expectedRevision: 1 },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:required-membership' },
      ),
    ).rejects.toMatchObject({ code: 'github_membership_still_required' });

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE entitlement_mapping_targets SET provisioning_target_id = 'target:github-member'
         WHERE mapping_id = 'mapping:github-member'
           AND provisioning_target_id = 'target:github-team'`,
      ),
      env.DB.prepare(
        `UPDATE provider_observations SET payload_json = ?, checksum = ?
         WHERE id = 'observation:github-member'`,
      ).bind(
        JSON.stringify({
          organization: 'example-organization',
          members: [],
          invitations: [],
          teams: [],
        }),
        observationChecksum,
      ),
    ]);

    const plan = await service.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 1 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:authoritative-plan' },
    );

    expect(plan).toMatchObject({
      providerConnectionId: 'provider:github',
      provisioningTargetId: 'target:github-member',
      provisioningStateId: 'state:github-member',
      subjectId: bootstrap.subject.id,
      entitlementId: 'entitlement:github-member',
      observationId: 'observation:github-member',
      observationChecksum,
      effectiveGrantIds: ['grant:github-member'],
      requiredProvisioningTargetIds: ['target:github-member'],
    });
    expect(plan.inputRevisions).toMatchObject({
      'organization:organization': 1,
      [`subject:${bootstrap.subject.id}`]: 2,
      'entitlement:entitlement:github-member': 1,
      'connection:provider:github': 1,
      'account:provider-account:github-admin': 1,
      'state:state:github-member': 2,
      'target:target:github-member': 1,
    });
    const changes = await repositories.provisioning.listOperationPlanChanges(plan.id);
    expect(changes.map((change) => change.action)).toEqual(['github.organization.invite']);
    expect(changes[0]?.resource).toContain('id:1001');
    const state = await repositories.provisioning.getProvisioningState('state:github-member');
    expect(state).toMatchObject({
      desiredState: 'present',
      lastObservationId: 'observation:github-member',
      lastPlanId: plan.id,
      revision: 2,
    });

    const thresholdAdapter: ProvisioningAdapter = {
      provider: 'github',
      capabilities: [],
      observe: async () => {
        throw new Error('not used');
      },
      plan: async () => testProviderPlan(21),
      apply: async () => {
        throw new Error('not used');
      },
      verify: async () => {
        throw new Error('not used');
      },
    };
    const thresholdService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', thresholdAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'organization-threshold'),
    );
    await expect(
      thresholdService.createPlan(
        { provisioningStateId: 'state:github-member', expectedRevision: 2 },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:organization-threshold' },
      ),
    ).rejects.toMatchObject({ code: 'bulk_change_threshold_exceeded' });
    expect(await repositories.provisioning.listOperationPlans()).toHaveLength(1);
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({ revision: 2, lastPlanId: plan.id });

    const racingAdapter: ProvisioningAdapter = {
      ...thresholdAdapter,
      plan: async () => {
        await env.DB.prepare(
          `INSERT INTO provider_observations (
            id, provider_connection_id, provisioning_target_id, status, observed_at,
            payload_json, payload_ref, checksum, error_code
          ) VALUES (
            'observation:racing-plan', 'provider:github', 'target:github-member',
            'complete', '2026-01-01T00:00:01.000Z', ?, NULL, ?, NULL
          )`,
        )
          .bind(
            JSON.stringify({
              organization: 'example-organization',
              members: [],
              invitations: [],
              teams: [],
            }),
            `sha256:${'d'.repeat(64)}`,
          )
          .run();
        return testProviderPlan(1);
      },
    };
    const racingService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', racingAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'racing-plan'),
    );
    await expect(
      racingService.createPlan(
        { provisioningStateId: 'state:github-member', expectedRevision: 2 },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:racing-plan' },
      ),
    ).rejects.toMatchObject({ code: 'persistence_conflict' });
    expect(await repositories.provisioning.listOperationPlans()).toHaveLength(1);
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({ revision: 2, lastPlanId: plan.id });

    const operation = await service.startOperation(
      plan.id,
      { confirmed: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:stale-plan-operation' },
    );
    await expect(
      service.executeOperation(
        operation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:stale-plan-execution' },
      ),
    ).rejects.toMatchObject({ code: 'plan_inputs_changed' });

    await env.DB.prepare(
      `UPDATE provider_observations SET status = 'failed', error_code = 'fixture_restored'
       WHERE id = 'observation:racing-plan'`,
    ).run();

    let invitationApplyCalls = 0;
    const invitationAdapter: ProvisioningAdapter = {
      ...thresholdAdapter,
      plan: async () => ({ changes: [], destructive: false, protected: false }),
      apply: async () => {
        invitationApplyCalls += 1;
        return {
          status: 'waiting_for_invitation',
          evidence: { invitationId: 9001 },
        };
      },
    };
    const invitationService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', invitationAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'invitation-execution'),
    );
    const concurrentExecutions = await Promise.allSettled([
      invitationService.executeOperation(
        operation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:execute-a' },
      ),
      invitationService.executeOperation(
        operation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:execute-b' },
      ),
    ]);
    const completedExecutions = concurrentExecutions.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof invitationService.executeOperation>>
      > => result.status === 'fulfilled',
    );
    const rejectedExecutions = concurrentExecutions.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(completedExecutions).toHaveLength(1);
    expect(completedExecutions[0]?.value.status).toBe('waiting_for_invitation');
    expect(rejectedExecutions).toHaveLength(1);
    expect(rejectedExecutions[0]?.reason).toMatchObject({
      code: expect.stringMatching(/operation_(already_claimed|not_executable)/),
    });
    expect(invitationApplyCalls).toBe(1);
    await expect(repositories.provisioning.listOperationSteps(operation.id)).resolves.toMatchObject(
      [
        {
          status: 'blocked',
          evidence: { invitationId: 9001, applyStatus: 'waiting_for_invitation' },
          revision: 3,
        },
      ],
    );
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({ status: 'waiting_for_invitation', revision: 4 });
    await expect(
      invitationService.startOperation(
        plan.id,
        { confirmed: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:duplicate-operation' },
      ),
    ).rejects.toMatchObject({ code: 'operation_already_exists' });
    await expect(
      invitationService.executeOperation(
        operation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:invitation-retry' },
      ),
    ).rejects.toMatchObject({ code: 'operation_not_executable' });
    expect(invitationApplyCalls).toBe(1);

    let failedApplyCalls = 0;
    const failureAdapter: ProvisioningAdapter = {
      ...thresholdAdapter,
      plan: async () => testProviderPlan(2),
      apply: async () => {
        failedApplyCalls += 1;
        if (failedApplyCalls === 2) {
          throw new AccessControlError(
            503,
            'provider_apply_failed',
            'The fixture provider rejected the second change.',
          );
        }
        return { status: 'applied', evidence: { appliedCall: failedApplyCalls } };
      },
    };
    const failureService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', failureAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'failed-execution'),
    );
    const failurePlan = await failureService.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 4 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:failure-plan' },
    );
    const competingStarts = await Promise.allSettled([
      failureService.startOperation(
        failurePlan.id,
        { confirmed: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:start-a' },
      ),
      failureService.startOperation(
        failurePlan.id,
        { confirmed: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:start-b' },
      ),
    ]);
    const startedFailureOperation = competingStarts.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof failureService.startOperation>>
      > => result.status === 'fulfilled',
    );
    const rejectedStart = competingStarts.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(startedFailureOperation).toBeDefined();
    expect(rejectedStart?.reason).toMatchObject({ code: 'operation_already_exists' });
    const claimRaceRepository = new Proxy(repositories.provisioning, {
      get(target, property) {
        if (property === 'claimOperation') {
          return async (...arguments_: Parameters<typeof target.claimOperation>) => {
            await env.DB.prepare(
              `UPDATE effective_grants SET status = 'expired'
               WHERE id = 'grant:github-member'`,
            ).run();
            return target.claimOperation(...arguments_);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const claimRaceService = new ReconciliationService(
      claimRaceRepository,
      repositories.identities,
      repositories.catalog,
      new Map([['github', failureAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'claim-race'),
    );
    await expect(
      claimRaceService.executeOperation(
        startedFailureOperation!.value.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:claim-race' },
      ),
    ).rejects.toMatchObject({ code: 'persistence_conflict' });
    expect(failedApplyCalls).toBe(0);
    await env.DB.prepare(
      `UPDATE effective_grants SET status = 'active'
       WHERE id = 'grant:github-member'`,
    ).run();
    await expect(
      failureService.executeOperation(
        startedFailureOperation!.value.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:failed-execution' },
      ),
    ).rejects.toMatchObject({ code: 'provider_apply_failed' });
    expect(failedApplyCalls).toBe(2);
    await expect(
      repositories.provisioning.getOperation(startedFailureOperation!.value.id),
    ).resolves.toMatchObject({ status: 'failed', revision: 3, errorCode: 'provider_apply_failed' });
    await expect(
      repositories.provisioning.listOperationSteps(startedFailureOperation!.value.id),
    ).resolves.toMatchObject([
      { status: 'completed', evidence: { appliedCall: 1 }, revision: 3 },
      { status: 'failed', evidence: { errorCode: 'provider_apply_failed' }, revision: 3 },
    ]);
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({ status: 'failed', revision: 7 });
    await expect(
      failureService.executeOperation(
        startedFailureOperation!.value.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:failed-retry' },
      ),
    ).rejects.toMatchObject({ code: 'operation_not_executable' });
    expect(failedApplyCalls).toBe(2);

    let mismatchPlanCalls = 0;
    let mismatchApplyCalls = 0;
    let mismatchVerifyCalls = 0;
    const mismatchAdapter: ProvisioningAdapter = {
      ...thresholdAdapter,
      plan: async () => {
        mismatchPlanCalls += 1;
        return testProviderPlan(1);
      },
      apply: async () => {
        mismatchApplyCalls += 1;
        return { status: 'applied', evidence: { applied: true } };
      },
      verify: async () => {
        mismatchVerifyCalls += 1;
        return verificationObservation('observation:verify-mismatch', 'e', 2);
      },
    };
    const mismatchService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', mismatchAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'mismatch-execution'),
    );
    const mismatchPlan = await mismatchService.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 7 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:mismatch-plan' },
    );
    const mismatchOperation = await mismatchService.startOperation(
      mismatchPlan.id,
      { confirmed: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:mismatch-operation' },
    );
    await expect(
      mismatchService.executeOperation(
        mismatchOperation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:mismatch-execution' },
      ),
    ).rejects.toMatchObject({ code: 'verification_mismatch' });
    expect({ mismatchPlanCalls, mismatchApplyCalls, mismatchVerifyCalls }).toEqual({
      mismatchPlanCalls: 2,
      mismatchApplyCalls: 1,
      mismatchVerifyCalls: 1,
    });
    await expect(
      repositories.provisioning.getOperation(mismatchOperation.id),
    ).resolves.toMatchObject({ status: 'failed', revision: 4, errorCode: 'verification_mismatch' });
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({
      status: 'failed',
      lastObservationId: 'observation:verify-mismatch',
      revision: 11,
    });

    let successPlanCalls = 0;
    let successApplyCalls = 0;
    let successVerifyCalls = 0;
    const successAdapter: ProvisioningAdapter = {
      ...thresholdAdapter,
      plan: async (authority) => {
        successPlanCalls += 1;
        return authority.observation.id === 'observation:verify-success'
          ? testProviderPlan(0)
          : testProviderPlan(1);
      },
      apply: async () => {
        successApplyCalls += 1;
        return { status: 'applied', evidence: { applied: true } };
      },
      verify: async () => {
        successVerifyCalls += 1;
        return verificationObservation('observation:verify-success', 'f', 3);
      },
    };
    const successService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', successAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'successful-execution'),
    );
    const successPlan = await successService.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 11 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:success-plan' },
    );
    const successOperation = await successService.startOperation(
      successPlan.id,
      { confirmed: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:success-operation' },
    );
    const completed = await successService.executeOperation(
      successOperation.id,
      { writesEnabled: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:success-execution' },
    );
    expect(completed).toMatchObject({ status: 'completed', revision: 4 });
    expect({ successPlanCalls, successApplyCalls, successVerifyCalls }).toEqual({
      successPlanCalls: 2,
      successApplyCalls: 1,
      successVerifyCalls: 1,
    });
    await expect(
      repositories.provisioning.getProvisioningState('state:github-member'),
    ).resolves.toMatchObject({
      desiredState: 'present',
      observedState: 'present',
      status: 'converged',
      lastObservationId: 'observation:verify-success',
      revision: 15,
    });

    let authorityChangeApplyCalls = 0;
    const authorityChangeAdapter: ProvisioningAdapter = {
      provider: 'github',
      capabilities: [],
      observe: async () => {
        throw new Error('not used');
      },
      plan: async () => testProviderPlan(2),
      apply: async () => {
        authorityChangeApplyCalls += 1;
        if (authorityChangeApplyCalls === 1) {
          await env.DB.prepare(
            `UPDATE effective_grants SET status = 'expired'
             WHERE id = 'grant:github-member'`,
          ).run();
        }
        return { status: 'applied', evidence: { applyCall: authorityChangeApplyCalls } };
      },
      verify: async () => {
        throw new Error('not used');
      },
    };
    const authorityChangeService = new ReconciliationService(
      repositories.provisioning,
      repositories.identities,
      repositories.catalog,
      new Map([['github', authorityChangeAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'authority-change'),
    );
    const authorityChangePlan = await authorityChangeService.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 15 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:authority-change-plan' },
    );
    const authorityChangeOperation = await authorityChangeService.startOperation(
      authorityChangePlan.id,
      { confirmed: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:authority-change-start' },
    );

    await expect(
      authorityChangeService.executeOperation(
        authorityChangeOperation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:authority-change-execute' },
      ),
    ).rejects.toMatchObject({ code: 'plan_inputs_changed' });
    expect(authorityChangeApplyCalls).toBe(1);
    await expect(
      repositories.provisioning.getOperation(authorityChangeOperation.id),
    ).resolves.toMatchObject({ status: 'action_required', errorCode: 'plan_inputs_changed' });
    await expect(
      repositories.provisioning.listOperationSteps(authorityChangeOperation.id),
    ).resolves.toMatchObject([
      { status: 'completed', evidence: { applyCall: 1 } },
      { status: 'blocked', evidence: { errorCode: 'plan_inputs_changed' } },
    ]);
    await env.DB.prepare(
      `UPDATE effective_grants SET status = 'active'
       WHERE id = 'grant:github-member'`,
    ).run();

    let recoveryApplyCalls = 0;
    let recoveryVerifyCalls = 0;
    let failCompletionPersistence = true;
    const recoveringRepository = new Proxy(repositories.provisioning, {
      get(target, property) {
        if (property === 'updateOperationStep') {
          return async (...arguments_: Parameters<typeof target.updateOperationStep>) => {
            if (arguments_[0].status === 'completed' && failCompletionPersistence) {
              failCompletionPersistence = false;
              throw new AccessControlError(
                409,
                'persistence_conflict',
                'Simulated persistence failure after a provider write.',
              );
            }
            return target.updateOperationStep(...arguments_);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const recoveryAdapter: ProvisioningAdapter = {
      provider: 'github',
      capabilities: [],
      observe: async () => {
        throw new Error('not used');
      },
      plan: async () => testProviderPlan(1),
      apply: async () => {
        recoveryApplyCalls += 1;
        return { status: 'applied', evidence: { applyCall: recoveryApplyCalls } };
      },
      verify: async () => {
        recoveryVerifyCalls += 1;
        return verificationObservation('observation:recovery', 'e', 5);
      },
    };
    const recoveryService = new ReconciliationService(
      recoveringRepository,
      repositories.identities,
      repositories.catalog,
      new Map([['github', recoveryAdapter]]),
      fixtureRuntime(FIXTURE_TIME, 'ambiguous-write'),
    );
    const recoveryPlan = await recoveryService.createPlan(
      { provisioningStateId: 'state:github-member', expectedRevision: 18 },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:ambiguous-plan' },
    );
    const recoveryOperation = await recoveryService.startOperation(
      recoveryPlan.id,
      { confirmed: true },
      { actorSubjectId: bootstrap.subject.id, requestId: 'request:ambiguous-start' },
    );

    await expect(
      recoveryService.executeOperation(
        recoveryOperation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:ambiguous-execute' },
      ),
    ).rejects.toMatchObject({ code: 'persistence_conflict' });
    expect(recoveryApplyCalls).toBe(1);
    await expect(
      repositories.provisioning.getOperation(recoveryOperation.id),
    ).resolves.toMatchObject({ status: 'applying' });

    await expect(
      recoveryService.executeOperation(
        recoveryOperation.id,
        { writesEnabled: true },
        { actorSubjectId: bootstrap.subject.id, requestId: 'request:ambiguous-recover' },
      ),
    ).resolves.toMatchObject({
      status: 'action_required',
      errorCode: 'provider_apply_outcome_ambiguous',
    });
    expect({ recoveryApplyCalls, recoveryVerifyCalls }).toEqual({
      recoveryApplyCalls: 1,
      recoveryVerifyCalls: 1,
    });
    await expect(
      repositories.provisioning.listOperationSteps(recoveryOperation.id),
    ).resolves.toMatchObject([
      {
        status: 'blocked',
        evidence: {
          errorCode: 'provider_apply_outcome_ambiguous',
          recoveryObservationId: 'observation:recovery',
        },
      },
    ]);
  });
});

function testProviderPlan(changeCount: number) {
  return {
    changes: Array.from({ length: changeCount }, (_, position) => ({
      position,
      action: 'github.team.add' as const,
      resource: `organization:example-organization|id:1001|team:team-${position}`,
      before: null,
      after: { membership: 'active' },
      destructive: false,
      protected: false,
      preconditions: ['organization_membership_active'],
    })),
    destructive: false,
    protected: false,
  };
}

function verificationObservation(id: string, checksumCharacter: string, seconds: number) {
  return {
    id,
    providerConnectionId: 'provider:github',
    provisioningTargetId: 'target:github-member',
    status: 'complete' as const,
    observedAt: `2026-01-01T00:00:0${seconds}.000Z`,
    payload: { fixture: id },
    checksum: `sha256:${checksumCharacter.repeat(64)}`,
  };
}

async function seedPlanRecords(administratorId: string): Promise<void> {
  const githubObservation = JSON.stringify({
    organization: 'example-organization',
    members: [],
    invitations: [],
    teams: [],
  });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE subjects SET directory_state = 'active', revision = 2, updated_at = ?, updated_by = ?
       WHERE id = ? AND revision = 1`,
    ).bind(FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO directory_sources (
        id, provider, customer_id, delegated_admin, credential_ref, access_group_prefix,
        status, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'directory:google', 'google', 'example-customer', 'admin@example.org',
        'GOOGLE_CREDENTIAL', 'access.', 'active', 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO directory_sync_runs (
        id, directory_source_id, status, started_at, completed_at, snapshot_version,
        user_count, group_count, membership_count, violation_count, request_id
      ) VALUES (
        'sync:authoritative', 'directory:google', 'completed', ?, ?, ?, 1, 1, 1, 0,
        'request:authoritative-sync'
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, observationChecksum),
    env.DB.prepare(
      `INSERT INTO source_groups (
        id, directory_source_id, provider_group_id, email, aliases_json, name, kind, status,
        direct_member_count, last_sync_run_id, last_observed_at, revision, created_at, updated_at
      ) VALUES (
        'group:github-member', 'directory:google', 'google-group-github',
        'access.github.member@example.org', '[]', 'GitHub Members', 'access', 'active', 1,
        'sync:authoritative', ?, 1, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, FIXTURE_TIME),
    env.DB.prepare(
      `INSERT INTO source_group_memberships (
        id, source_group_id, provider_membership_id, member_type, member_provider_id,
        member_email, role, status, sync_run_id, observed_at
      ) VALUES (
        'membership:github-member', 'group:github-member', 'google-membership-github',
        'user', 'google-user-admin', 'admin@example.org', 'MEMBER', 'active',
        'sync:authoritative', ?
      )`,
    ).bind(FIXTURE_TIME),
    env.DB.prepare(
      `INSERT INTO applications (
        id, key, name, description, category, launch_url, icon_json, status, visibility,
        authentication_json, provisioning_mode, revision, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'application:github', 'github', 'GitHub', NULL, 'Engineering',
        'https://github.example.org', NULL, 'active', 'entitled',
        '{"type":"cloudflare_oidc","reference":"github-access"}', 'plan', 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO application_entitlements (
        id, application_id, key, name, description, status, requires_provisioning,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'entitlement:github-member', 'application:github', 'member', 'Member', NULL,
        'active', 1, 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO provider_connections (
        id, provider, name, mode, credential_ref, configuration_json, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'provider:github', 'github', 'Example GitHub', 'plan', 'GITHUB_CREDENTIAL',
        '{"organization":"example-organization","teamSlugs":[]}', 'active', 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO provider_accounts (
        id, provider_connection_id, subject_id, external_id, login, display_name,
        status, observed_at, revision, created_at, updated_at
      ) VALUES (
        'provider-account:github-admin', 'provider:github', ?, '1001', 'local-admin',
        'Local Administrator', 'active', ?, 1, ?, ?
      )`,
    ).bind(administratorId, FIXTURE_TIME, FIXTURE_TIME, FIXTURE_TIME),
    env.DB.prepare(
      `INSERT INTO provisioning_targets (
        id, provider_connection_id, application_entitlement_id, target_type,
        provider_target_id, mode, protected, configuration_json, status,
        revision, created_at, updated_at, created_by, updated_by
      ) VALUES (
        'target:github-member', 'provider:github', 'entitlement:github-member',
        'github_organization_membership', 'example-organization', 'plan', 0, '{}',
        'active', 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO entitlement_mappings (
        id, source_group_id, status, valid_from, valid_until, revision,
        created_at, updated_at, created_by, updated_by
      ) VALUES (
        'mapping:github-member', 'group:github-member', 'active', ?, NULL, 1, ?, ?, ?, ?
      )`,
    ).bind(FIXTURE_TIME, FIXTURE_TIME, FIXTURE_TIME, administratorId, administratorId),
    env.DB.prepare(
      `INSERT INTO entitlement_mapping_entitlements (mapping_id, entitlement_id)
       VALUES ('mapping:github-member', 'entitlement:github-member')`,
    ),
    env.DB.prepare(
      `INSERT INTO entitlement_mapping_targets (mapping_id, provisioning_target_id)
       VALUES ('mapping:github-member', 'target:github-member')`,
    ),
    env.DB.prepare(
      `INSERT INTO effective_grants (
        id, subject_id, source_group_id, source_group_membership_id, mapping_id,
        entitlement_id, status, calculated_at, valid_until
      ) VALUES (
        'grant:github-member', ?, 'group:github-member', 'membership:github-member',
        'mapping:github-member', 'entitlement:github-member', 'active', ?, NULL
      )`,
    ).bind(administratorId, FIXTURE_TIME),
    env.DB.prepare(
      `INSERT INTO provider_observations (
        id, provider_connection_id, provisioning_target_id, status, observed_at,
        payload_json, payload_ref, checksum, error_code
      ) VALUES (
        'observation:github-member', 'provider:github', 'target:github-member',
        'complete', ?, ?, NULL, ?, NULL
      )`,
    ).bind(FIXTURE_TIME, githubObservation, observationChecksum),
    env.DB.prepare(
      `INSERT INTO provisioning_states (
        id, provisioning_target_id, subject_id, desired_state, observed_state, status,
        last_observation_id, last_plan_id, evidence_json, revision, updated_at
      ) VALUES (
        'state:github-member', 'target:github-member', ?, 'absent', 'absent', 'observed',
        NULL, NULL, '{}', 1, ?
      )`,
    ).bind(administratorId, FIXTURE_TIME),
  ]);
}
