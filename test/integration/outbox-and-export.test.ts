import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ExportService,
  validatePortableExport,
  type ExportObjectWriter,
  type StoredExportObject,
} from '@access-control/application';
import { createD1Repositories } from '@access-control/d1';
import { consumeOutboxBatch, dispatchPendingOutbox } from '../../apps/worker/src/queue/outbox';
import { R2ExportObjectWriter } from '../../apps/worker/src/queue/r2-export';
import { FIXTURE_TIME, fixtureRuntime } from '../fixtures/domain-fixtures';
import { bootstrapAdministrator } from '../fixtures/persistence-fixtures';

const context = {
  actorSubjectId: 'subject:fixture-1',
  requestId: 'request:export-materialization',
};

beforeAll(async () => {
  const bootstrap = await bootstrapAdministrator(env.DB);
  context.actorSubjectId = bootstrap.subject.id;
});

describe('claimed Outbox delivery and Export materialization', () => {
  it('conditionally creates an R2 key without replacing its first value', async () => {
    const writer = new R2ExportObjectWriter(env.EXPORTS_BUCKET);
    const key = 'exports/.test/conditional-create.json';
    await writer.deleteTemporary(key);
    expect(await writer.putFinalIfAbsent(key, '{"value":1}', `sha256:${'1'.repeat(64)}`)).toBe(
      true,
    );
    expect(await writer.putFinalIfAbsent(key, '{"value":2}', `sha256:${'2'.repeat(64)}`)).toBe(
      false,
    );
    await expect(writer.get(key)).resolves.toEqual({
      value: '{"value":1}',
      checksum: `sha256:${'1'.repeat(64)}`,
    });
    await writer.deleteTemporary(key);
  });

  it('sends one Queue message when dispatchers race for the same Outbox record', async () => {
    const queue = new RecordingQueue();
    const dispatchEnvironment = workerEnvironment(queue);
    const counts = await Promise.all([
      dispatchPendingOutbox(dispatchEnvironment),
      dispatchPendingOutbox(dispatchEnvironment),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(queue.messages).toHaveLength(1);
    const records = await createD1Repositories(env.DB).audit.listPendingOutboxRecords(10);
    expect(records).toHaveLength(0);
    const row = await env.DB.prepare(
      `SELECT status, attempts FROM outbox
       WHERE id = json_extract(?, '$.outboxId')`,
    )
      .bind(JSON.stringify(queue.messages[0]))
      .first<{ status: string; attempts: number }>();
    expect(row).toEqual({ status: 'delivered', attempts: 1 });
  });

  it('marks a claimed Outbox record failed when Queue send fails', async () => {
    const repositories = createD1Repositories(env.DB);
    const requested = await new ExportService(
      repositories.exports,
      fixtureRuntime(FIXTURE_TIME, 'failed-dispatch'),
    ).request({ ...context, requestId: 'request:failed-dispatch' });
    const requestOutboxId = await findExportRequestOutbox(requested.id);
    const queue = new RecordingQueue();
    queue.failNextSend = true;
    await expect(dispatchPendingOutbox(workerEnvironment(queue))).resolves.toBe(0);
    await expect(repositories.audit.getOutboxRecord(requestOutboxId)).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'outbox_queue_send_failed',
    });
  });

  it('processes concurrent duplicate Queue deliveries once by Outbox ID', async () => {
    const repositories = createD1Repositories(env.DB);
    const requested = await new ExportService(
      repositories.exports,
      fixtureRuntime(FIXTURE_TIME, 'queued-export'),
    ).request(context);
    const requestOutboxId = await findExportRequestOutbox(requested.id);
    const queue = new RecordingQueue();
    await dispatchPendingOutbox(workerEnvironment(queue));
    const body = queue.messages.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.type === 'export.create' &&
        candidate.exportId === requested.id,
    );
    expect(body).toBeDefined();
    if (body === undefined) throw new Error('Export Queue message was not dispatched.');

    const first = queueMessage('message:export-one', body);
    const duplicate = queueMessage('message:export-two', body);
    await Promise.all([
      consumeOutboxBatch(queueBatch(first.message), workerEnvironment(queue)),
      consumeOutboxBatch(queueBatch(duplicate.message), workerEnvironment(queue)),
    ]);

    const completed = await repositories.exports.getExportRecord(requested.id);
    expect(completed).toMatchObject({
      status: 'completed',
      claimId: requestOutboxId,
      objectKey: `exports/${requested.id}.json`,
    });
    expect([first.acked, duplicate.acked].filter(Boolean)).toHaveLength(1);
    expect([first.retried, duplicate.retried].filter(Boolean)).toHaveLength(1);

    const stored = await env.EXPORTS_BUCKET.get(`exports/${requested.id}.json`);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error('Final export object was not written.');
    const etag = stored.etag;
    const parsed = await validatePortableExport(await stored.json());
    expect(stored.customMetadata?.checksum).toBe(parsed.export.checksum);
    expect(completed?.checksum).toBe(parsed.export.checksum);

    const retriedDuplicate = queueMessage('message:export-two', body);
    await consumeOutboxBatch(queueBatch(retriedDuplicate.message), workerEnvironment(queue));
    expect(retriedDuplicate.acked).toBe(true);
    expect(retriedDuplicate.retried).toBe(false);
    expect((await env.EXPORTS_BUCKET.head(`exports/${requested.id}.json`))?.etag).toBe(etag);
    const receiptCount = await env.DB.prepare(
      'SELECT count(*) AS count FROM outbox_delivery_receipts WHERE outbox_id = ?',
    )
      .bind(requestOutboxId)
      .first<{ count: number }>();
    expect(receiptCount?.count).toBe(1);
  });

  it('resumes the same Export claim from a verified temporary object', async () => {
    const repositories = createD1Repositories(env.DB);
    const service = new ExportService(
      repositories.exports,
      fixtureRuntime(FIXTURE_TIME, 'retried-export'),
    );
    const requested = await service.request({
      ...context,
      requestId: 'request:retried-export',
    });
    const requestOutboxId = await findExportRequestOutbox(requested.id);
    const claimed = await repositories.audit.claimOutboxRecord(requestOutboxId, FIXTURE_TIME);
    expect(claimed?.status).toBe('dispatching');
    await repositories.audit.markOutboxDispatched(requestOutboxId, FIXTURE_TIME);

    const writer = new MemoryExportWriter();
    writer.failNextFinalPut = true;
    await expect(
      service.materialize(requested.id, requestOutboxId, writer, {
        ...context,
        requestId: 'queue:first-export-attempt',
      }),
    ).rejects.toThrow('simulated R2 finalization failure');
    expect((await repositories.exports.getExportRecord(requested.id))?.status).toBe('running');
    expect(writer.temporaryPuts).toBe(1);

    const portableExport = await service.materialize(requested.id, requestOutboxId, writer, {
      ...context,
      requestId: 'queue:retried-export-attempt',
    });
    expect(writer.temporaryPuts).toBe(1);
    expect(writer.finalPuts).toBe(1);
    expect(writer.objects.has(`exports/.staging/${requested.id}.json`)).toBe(false);
    const completed = await repositories.exports.getExportRecord(requested.id);
    expect(completed).toMatchObject({
      status: 'completed',
      checksum: portableExport.checksum,
      claimId: requestOutboxId,
    });
    expect(writer.objects.get(`exports/${requested.id}.json`)?.checksum).toBe(
      portableExport.checksum,
    );
  });
});

class RecordingQueue {
  public readonly messages: unknown[] = [];
  public failNextSend = false;

  public async send(message: unknown): Promise<QueueSendResponse> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated Queue send failure');
    }
    this.messages.push(message);
    return {
      metadata: {
        metrics: { backlogBytes: 0, backlogCount: this.messages.length },
      },
    };
  }
}

class MemoryExportWriter implements ExportObjectWriter {
  public readonly objects = new Map<string, StoredExportObject>();
  public temporaryPuts = 0;
  public finalPuts = 0;
  public failNextFinalPut = false;

  public async get(key: string): Promise<StoredExportObject | null> {
    return this.objects.get(key) ?? null;
  }

  public async putTemporaryIfAbsent(
    key: string,
    value: string,
    checksum: string,
  ): Promise<boolean> {
    if (this.objects.has(key)) return false;
    this.temporaryPuts += 1;
    this.objects.set(key, { value, checksum });
    return true;
  }

  public async putFinalIfAbsent(key: string, value: string, checksum: string): Promise<boolean> {
    if (this.failNextFinalPut) {
      this.failNextFinalPut = false;
      throw new Error('simulated R2 finalization failure');
    }
    if (this.objects.has(key)) return false;
    this.finalPuts += 1;
    this.objects.set(key, { value, checksum });
    return true;
  }

  public async deleteTemporary(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function findExportRequestOutbox(exportId: string): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT id FROM outbox
     WHERE topic = 'access-control.export.requested'
       AND json_extract(payload_json, '$.exportId') = ?`,
  )
    .bind(exportId)
    .first<{ id: string }>();
  if (row === null) throw new Error(`Export ${exportId} has no request Outbox record.`);
  return row.id;
}

function workerEnvironment(queue: RecordingQueue): Env {
  return {
    DB: env.DB,
    EXPORTS_BUCKET: env.EXPORTS_BUCKET,
    OUTBOX_QUEUE: queue,
  } as unknown as Env;
}

function queueMessage(id: string, body: unknown) {
  let acked = false;
  let retried = false;
  const result = {
    message: {
      id,
      timestamp: new Date(FIXTURE_TIME),
      body,
      attempts: 1,
      ack: () => {
        acked = true;
      },
      retry: () => {
        retried = true;
      },
    } satisfies Message<unknown>,
    get acked() {
      return acked;
    },
    get retried() {
      return retried;
    },
  };
  return result;
}

function queueBatch(message: Message<unknown>): MessageBatch<unknown> {
  return {
    messages: [message],
    queue: 'access-control-test-outbox',
    metadata: { metrics: { backlogBytes: 0, backlogCount: 1 } },
    retryAll: () => undefined,
    ackAll: () => undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
