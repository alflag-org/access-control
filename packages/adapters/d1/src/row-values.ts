import { AccessControlError, jsonValueSchema, type JsonValue } from '@access-control/domain';

export type DatabaseRow = Record<string, unknown>;

export function text(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw invalidRow(key);
  return value;
}

export function optionalText(row: DatabaseRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRow(key);
  return value;
}

export function integer(row: DatabaseRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalidRow(key);
  return value;
}

export function optionalInteger(row: DatabaseRow, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalidRow(key);
  return value;
}

export function booleanValue(row: DatabaseRow, key: string): boolean {
  const value = integer(row, key);
  if (value !== 0 && value !== 1) throw invalidRow(key);
  return value === 1;
}

export function jsonValue(row: DatabaseRow, key: string): JsonValue {
  const serialized = text(row, key);
  try {
    return jsonValueSchema.parse(JSON.parse(serialized));
  } catch {
    throw invalidRow(key);
  }
}

export function optionalJsonValue(row: DatabaseRow, key: string): JsonValue | undefined {
  const serialized = optionalText(row, key);
  if (serialized === undefined) return undefined;
  try {
    return jsonValueSchema.parse(JSON.parse(serialized));
  } catch {
    throw invalidRow(key);
  }
}

function invalidRow(key: string): AccessControlError {
  return new AccessControlError(
    503,
    'invalid_persisted_state',
    `Persisted field ${key} does not match the current domain contract.`,
  );
}
