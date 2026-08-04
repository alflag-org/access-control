import { z } from 'zod';

export const violationSchema = z
  .object({
    code: z.string().min(1),
    path: z.string(),
    message: z.string().min(1),
  })
  .strict();

export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        violations: z.array(violationSchema).optional(),
      })
      .strict(),
    requestId: z.string().min(1),
  })
  .strict();

export const expectedRevisionSchema = z
  .object({
    expectedRevision: z.int().positive(),
  })
  .strict();

export const paginationQuerySchema = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const paginationSchema = z
  .object({
    nextCursor: z.string().min(1).optional(),
  })
  .strict();
