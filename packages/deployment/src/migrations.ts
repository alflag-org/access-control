import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadAcceptedMigrationNames(input: {
  migrationsDirectory: string;
}): Promise<Set<string>> {
  const directoryEntries = await readdir(resolve(input.migrationsDirectory), {
    withFileTypes: true,
  });
  const migrationFiles = directoryEntries
    .filter((entry) => entry.isFile() && /^\d+_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name);
  if (migrationFiles.length === 0) throw new Error('No source migrations were found.');
  return new Set(migrationFiles);
}

export function assertAppliedMigrationsCompatible(
  appliedMigrationNames: string[],
  acceptedMigrationNames: ReadonlySet<string>,
): void {
  const unsupported = [...new Set(appliedMigrationNames)]
    .filter((name) => !acceptedMigrationNames.has(name))
    .sort();
  if (unsupported.length > 0) {
    throw new Error(
      `Software rollback is unsafe because the database contains migrations unknown to this release: ${unsupported.join(', ')}.`,
    );
  }
}

export function migrationNamesFromD1Response(output: string): string[] {
  return d1QueryRows(output).map((row) => {
    if (typeof row.name !== 'string') {
      throw new Error('Wrangler D1 migration rows must contain a string name.');
    }
    return row.name;
  });
}

export function d1QueryRows(output: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error('Wrangler D1 response must be an array.');
  const rows: Record<string, unknown>[] = [];
  for (const result of parsed) {
    if (!isRecord(result) || result.success !== true || !Array.isArray(result.results)) {
      throw new Error('Wrangler D1 response contains an unsuccessful or malformed result.');
    }
    for (const row of result.results) {
      if (!isRecord(row)) throw new Error('Wrangler D1 response contains a malformed row.');
      rows.push(row);
    }
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
