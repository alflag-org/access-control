import { z } from 'zod';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(jsonValueSchema),
      z.record(z.string(), jsonValueSchema),
    ]),
  )
  .meta({ id: 'JsonValue' });

export const jsonObjectSchema: z.ZodType<JsonObject> = z
  .record(z.string(), jsonValueSchema)
  .meta({ id: 'JsonObject' });

export const idSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Must be a stable machine identifier.');

export const keySchema = z
  .string()
  .min(1)
  .max(96)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
    'Must start with a lowercase letter and contain lowercase segments.',
  );

export const nonEmptyTextSchema = z.string().trim().min(1).max(500);
export const displayNameSchema = z.string().trim().min(1).max(160);
export const emailSchema = z.email().max(320);
export const timestampSchema = z.iso.datetime({ offset: true });
export const revisionSchema = z.int().positive();
export const initialRevisionSchema = z.literal(1);
export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const bindingReferenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be a runtime binding name, not a credential value.');
export const httpsUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === 'https:', 'Must use HTTPS.');

export const auditMetadataSchema = z
  .object({
    revision: revisionSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    createdBy: idSchema,
    updatedBy: idSchema,
  })
  .strict();

export type AuditMetadata = z.infer<typeof auditMetadataSchema>;

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
    .join(',')}}`;
}

export function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function deterministicId(prefix: string, parts: readonly string[]): string {
  const input = canonicalJson([...parts]);
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  const digest = seeds
    .map((seed) => {
      let hash = seed;
      for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    })
    .join('');
  return `${prefix}:${digest}`;
}
