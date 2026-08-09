import type { RuntimeConfigurationManifest } from '@access-control/config';

export function credentialReferences(manifest: RuntimeConfigurationManifest): string[] {
  return [
    ...new Set([
      ...manifest.directorySources.map((source) => source.credentialRef),
      ...manifest.providerConnections.flatMap((connection) =>
        connection.credentialRef === undefined ? [] : [connection.credentialRef],
      ),
    ]),
  ].sort();
}

export function parseWorkerSecretValues(
  source: string | undefined,
  manifest: RuntimeConfigurationManifest,
): Record<string, string> {
  const expected = credentialReferences(manifest);
  if (expected.length > 100) {
    throw new Error('A deployment can upload at most 100 Worker secrets.');
  }
  if (source === undefined || source.trim().length === 0) {
    if (expected.length === 0) return {};
    throw new Error('WORKER_SECRET_VALUES is required for every runtime credentialRef.');
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('WORKER_SECRET_VALUES must be a JSON object.');
  }
  if (!isRecord(value)) throw new Error('WORKER_SECRET_VALUES must be a JSON object.');

  const actual = Object.keys(value).sort();
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      [
        missing.length === 0 ? undefined : `missing ${missing.join(', ')}`,
        unexpected.length === 0 ? undefined : `unexpected ${unexpected.join(', ')}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join('; '),
    );
  }

  return Object.fromEntries(
    expected.map((name) => {
      const secret = value[name];
      if (typeof secret !== 'string' || secret.length === 0) {
        throw new Error(`WORKER_SECRET_VALUES entry ${name} must be a non-empty string.`);
      }
      return [name, secret];
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
