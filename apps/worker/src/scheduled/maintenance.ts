import { GuestExpirationService, workerServiceRuntime } from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import { dispatchPendingOutbox } from '../queue/outbox';

export async function runScheduledMaintenance(event: ScheduledController, env: Env): Promise<void> {
  const repositories = createD1Repositories(env.DB);
  const expiredGuests = await new GuestExpirationService(
    repositories.identities,
    workerServiceRuntime,
  ).processExpiredGuests({
    requestId: `scheduled:${event.scheduledTime}`,
    reason: 'managed_guest_expiration',
  });
  const dispatched = await dispatchPendingOutbox(env);
  console.log(
    JSON.stringify({
      event: 'access-control.scheduled.completed',
      scheduledTime: new Date(event.scheduledTime).toISOString(),
      cron: event.cron,
      expiredGuests,
      dispatchedOutboxRecords: dispatched,
    }),
  );
}
