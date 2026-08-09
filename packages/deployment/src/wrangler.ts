import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { DeploymentManifest } from './schema';

const baseConfigSchema = z
  .object({
    $schema: z.string(),
    name: z.string(),
    main: z.string(),
    compatibility_date: z.string(),
    compatibility_flags: z.array(z.string()).optional(),
    workers_dev: z.boolean().optional(),
    preview_urls: z.boolean().optional(),
    keep_vars: z.boolean().optional(),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    d1_databases: z
      .array(
        z
          .object({
            binding: z.string(),
            migrations_dir: z.string(),
          })
          .passthrough(),
      )
      .length(1),
    r2_buckets: z.array(z.object({ binding: z.string() }).passthrough()).length(1),
    queues: z
      .object({
        producers: z
          .array(z.object({ binding: z.string(), queue: z.string() }).passthrough())
          .length(1),
        consumers: z
          .array(
            z
              .object({
                queue: z.string(),
                dead_letter_queue: z.string(),
              })
              .passthrough(),
          )
          .length(1),
      })
      .strict(),
    observability: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type GeneratedWranglerConfiguration = Record<string, unknown>;

export async function generateWranglerConfiguration(input: {
  baseConfigPath: string;
  outputPath: string;
  deployment: DeploymentManifest;
  requiredSecrets?: string[];
}): Promise<GeneratedWranglerConfiguration> {
  const baseConfigPath = resolve(input.baseConfigPath);
  return buildWranglerConfiguration({
    baseConfig: JSON.parse(await readFile(baseConfigPath, 'utf8')),
    baseConfigPath,
    outputPath: input.outputPath,
    deployment: input.deployment,
    ...(input.requiredSecrets === undefined ? {} : { requiredSecrets: input.requiredSecrets }),
  });
}

export function buildWranglerConfiguration(input: {
  baseConfig: unknown;
  baseConfigPath: string;
  outputPath: string;
  deployment: DeploymentManifest;
  requiredSecrets?: string[];
}): GeneratedWranglerConfiguration {
  const baseConfigPath = resolve(input.baseConfigPath);
  const outputPath = resolve(input.outputPath);
  const base = baseConfigSchema.parse(input.baseConfig);
  const baseDirectory = dirname(baseConfigPath);
  const outputDirectory = dirname(outputPath);
  const sourceEntrypoint = resolve(baseDirectory, base.main);
  const migrationDirectory = resolve(
    baseDirectory,
    base.d1_databases[0]?.migrations_dir ?? '../../migrations',
  );
  const schemaPath = resolve(baseDirectory, base.$schema);
  const producer = base.queues.producers[0];
  const consumer = base.queues.consumers[0];
  if (producer === undefined || consumer === undefined) {
    throw new Error('Public Worker base must define one outbox producer and consumer.');
  }
  const { env: _environments, keep_vars: _keepVariables, triggers: _triggers, ...shared } = base;
  void _environments;
  void _keepVariables;
  void _triggers;

  const observability = mergeObservability(base.observability, input.deployment.observability);
  return {
    ...shared,
    $schema: relativeConfigPath(outputDirectory, schemaPath),
    name: input.deployment.worker.name,
    main: relativeConfigPath(outputDirectory, sourceEntrypoint),
    workers_dev: false,
    preview_urls: false,
    vars: {
      ...base.vars,
      ENVIRONMENT: input.deployment.environment,
      ALLOW_LOCAL_AUTH: 'false',
      ACCESS_TEAM_DOMAIN: input.deployment.access.teamDomain,
      ACCESS_AUD: input.deployment.access.audience,
      LOCAL_BOOTSTRAP_IDENTITY: 'unset',
      PROVIDER_WRITES_ENABLED: String(input.deployment.features.providerWritesEnabled),
    },
    d1_databases: [
      {
        binding: base.d1_databases[0]?.binding ?? 'DB',
        database_name: input.deployment.resources.database.name,
        database_id: input.deployment.resources.database.id,
        migrations_dir: relativeConfigPath(outputDirectory, migrationDirectory),
      },
    ],
    r2_buckets: [
      {
        binding: base.r2_buckets[0]?.binding ?? 'EXPORTS_BUCKET',
        bucket_name: input.deployment.resources.exportsBucket,
      },
    ],
    queues: {
      producers: [
        {
          ...producer,
          queue: input.deployment.resources.outboxQueue,
        },
      ],
      consumers: [
        {
          ...consumer,
          queue: input.deployment.resources.outboxQueue,
          dead_letter_queue: input.deployment.resources.deadLetterQueue,
        },
      ],
    },
    routes: input.deployment.worker.routes.map((route) =>
      'customDomain' in route
        ? { pattern: route.pattern, custom_domain: true }
        : { pattern: route.pattern, zone_name: route.zoneName },
    ),
    observability,
    triggers: { crons: input.deployment.crons },
    ...(input.requiredSecrets === undefined || input.requiredSecrets.length === 0
      ? {}
      : { secrets: { required: [...input.requiredSecrets].sort() } }),
  };
}

function mergeObservability(
  base: Record<string, unknown>,
  override: DeploymentManifest['observability'],
): Record<string, unknown> {
  if (override === undefined) return base;
  const baseLogs = objectValue(base.logs);
  const baseTraces = objectValue(base.traces);
  return {
    ...base,
    logs: {
      ...baseLogs,
      ...(override.logsHeadSamplingRate === undefined
        ? {}
        : { head_sampling_rate: override.logsHeadSamplingRate }),
    },
    traces: {
      ...baseTraces,
      ...(override.tracesEnabled === undefined ? {} : { enabled: override.tracesEnabled }),
      ...(override.tracesHeadSamplingRate === undefined
        ? {}
        : { head_sampling_rate: override.tracesHeadSamplingRate }),
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function relativeConfigPath(from: string, to: string): string {
  const path = relative(from, to).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}
