import { ExportService, workerServiceRuntime } from '@access-control/application';
import { outboxQueueMessageSchema, type OutboxQueueMessage } from '@access-control/events';
import { createD1Repositories } from '@access-control/d1';
import { AccessControlError } from '@access-control/domain';
import { R2ExportObjectWriter } from './r2-export';

export async function dispatchPendingOutbox(env: Env, limit = 50): Promise<number> {
  const repository = createD1Repositories(env.DB).audit;
  const records = await repository.listPendingOutboxRecords(limit);
  let dispatched = 0;
  for (const record of records) {
    const claimed = await repository.claimOutboxRecord(record.id, new Date().toISOString());
    if (claimed === null) continue;
    try {
      await env.OUTBOX_QUEUE.send(queueMessage(claimed.id, claimed.topic, claimed.payload), {
        contentType: 'json',
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          errorCode: 'outbox_queue_send_failed',
          outboxId: claimed.id,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      await repository.markOutboxFailed(
        claimed.id,
        'outbox_queue_send_failed',
        new Date().toISOString(),
      );
      continue;
    }
    await repository.markOutboxDispatched(claimed.id, new Date().toISOString());
    dispatched += 1;
  }
  return dispatched;
}

export async function consumeOutboxBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const repositories = createD1Repositories(env.DB);
  for (const message of batch.messages) {
    const parsed = outboxQueueMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error(JSON.stringify({ errorCode: 'invalid_queue_message', messageId: message.id }));
      message.ack();
      continue;
    }
    const outbox = await repositories.audit.getOutboxRecord(parsed.data.outboxId);
    if (outbox === null) {
      console.error(JSON.stringify({ errorCode: 'outbox_not_found', messageId: message.id }));
      message.ack();
      continue;
    }
    if (outbox.status !== 'dispatching' && outbox.status !== 'delivered') {
      console.error(
        JSON.stringify({
          errorCode: 'outbox_not_dispatched',
          messageId: message.id,
          outboxId: outbox.id,
          outboxStatus: outbox.status,
        }),
      );
      message.retry();
      continue;
    }
    const claimedAt = new Date().toISOString();
    const deliveryClaim = await repositories.audit.claimOutboxDelivery(
      outbox.id,
      message.id,
      claimedAt,
      claimExpiration(claimedAt),
    );
    if (deliveryClaim === 'delivered') {
      message.ack();
      continue;
    }
    if (deliveryClaim === 'processing') {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    try {
      if (parsed.data.type === 'export.create') {
        const exportRecord = await repositories.exports.getExportRecord(parsed.data.exportId);
        if (exportRecord === null) {
          throw new AccessControlError(
            404,
            'export_not_found',
            'The requested export record was not found.',
          );
        }
        await new ExportService(repositories.exports, workerServiceRuntime).materialize(
          parsed.data.exportId,
          outbox.id,
          new R2ExportObjectWriter(env.EXPORTS_BUCKET),
          {
            actorSubjectId: exportRecord.requestedBy,
            requestId: `queue:${message.id}`,
            reason: 'portable_export_materialization',
          },
        );
      }
      await repositories.audit.completeOutboxDelivery(
        outbox.id,
        message.id,
        new Date().toISOString(),
      );
      message.ack();
    } catch (error) {
      const code = error instanceof AccessControlError ? error.code : 'outbox_delivery_failed';
      console.error(
        JSON.stringify({ errorCode: code, messageId: message.id, outboxId: outbox.id }),
      );
      await repositories.audit.markOutboxDeliveryFailed(
        outbox.id,
        message.id,
        code,
        new Date().toISOString(),
      );
      message.retry();
    }
  }
  await dispatchPendingOutbox(env);
}

function claimExpiration(claimedAt: string): string {
  return new Date(Date.parse(claimedAt) + 5 * 60 * 1_000).toISOString();
}

function queueMessage(
  outboxId: string,
  topic: string,
  payload: Readonly<Record<string, unknown>>,
): OutboxQueueMessage {
  if (topic === 'access-control.export.requested') {
    const exportId = payload.exportId;
    if (typeof exportId !== 'string') {
      throw new AccessControlError(
        422,
        'export_outbox_invalid',
        'The export outbox payload has no export identifier.',
      );
    }
    return outboxQueueMessageSchema.parse({
      schemaVersion: 1,
      type: 'export.create',
      outboxId,
      exportId,
    });
  }
  return outboxQueueMessageSchema.parse({ schemaVersion: 1, type: 'outbox.deliver', outboxId });
}
