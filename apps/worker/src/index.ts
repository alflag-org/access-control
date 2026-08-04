import { createApp } from './api/app';
import { consumeOutboxBatch, dispatchPendingOutbox } from './queue/outbox';
import { runScheduledMaintenance } from './scheduled/maintenance';

const app = createApp();

export default {
  async fetch(request, env, context): Promise<Response> {
    const response = await app.fetch(request, env, context);
    const path = new URL(request.url).pathname;
    if (
      response.ok &&
      ['DELETE', 'PATCH', 'POST', 'PUT'].includes(request.method) &&
      path.startsWith('/api/v1/')
    ) {
      context.waitUntil(dispatchPendingOutbox(env));
    }
    return response;
  },

  async queue(batch, env): Promise<void> {
    await consumeOutboxBatch(batch, env);
  },

  async scheduled(event, env, context): Promise<void> {
    context.waitUntil(runScheduledMaintenance(event, env));
  },
} satisfies ExportedHandler<Env>;
