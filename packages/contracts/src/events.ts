import { z } from 'zod';
import { idSchema } from '@access-control/domain';

export const outboxQueueMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('outbox.deliver'),
      outboxId: idSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('export.create'),
      outboxId: idSchema,
      exportId: idSchema,
    })
    .strict(),
]);

export type OutboxQueueMessage = z.infer<typeof outboxQueueMessageSchema>;
