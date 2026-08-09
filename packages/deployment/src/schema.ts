import { z } from 'zod';
import { httpsUrlSchema } from '@access-control/domain';
import { runtimeConfigurationManifestSchema } from '@access-control/config';

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must use the owner/name format.');
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/, 'Commit must be a full lowercase Git SHA.');
const workerNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,253}[a-z0-9])?$/, 'Worker name is invalid.');
const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Hostname is invalid.',
  );
const resourceNameSchema = z.string().trim().min(1).max(255);

export const releaseManifestSchema = z
  .object({
    repository: repositorySchema,
    commit: commitSchema,
  })
  .strict();

const customDomainRouteSchema = z
  .object({
    pattern: hostnameSchema,
    customDomain: z.literal(true),
  })
  .strict();

const zoneRouteSchema = z
  .object({
    pattern: z.string().trim().min(1).max(512),
    zoneName: hostnameSchema,
  })
  .strict();

const observabilityOverrideSchema = z
  .object({
    logsHeadSamplingRate: z.number().min(0).max(1).optional(),
    tracesEnabled: z.boolean().optional(),
    tracesHeadSamplingRate: z.number().min(0).max(1).optional(),
  })
  .strict();

export const deploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['staging', 'production']),
    worker: z
      .object({
        name: workerNameSchema,
        baseUrl: httpsUrlSchema,
        routes: z
          .array(z.union([customDomainRouteSchema, zoneRouteSchema]))
          .min(1)
          .max(100),
      })
      .strict(),
    resources: z
      .object({
        database: z
          .object({
            name: resourceNameSchema,
            id: z.uuid(),
          })
          .strict(),
        exportsBucket: resourceNameSchema,
        outboxQueue: resourceNameSchema,
        deadLetterQueue: resourceNameSchema,
      })
      .strict(),
    access: z
      .object({
        teamDomain: hostnameSchema,
        audience: z.string().trim().min(16).max(512),
      })
      .strict(),
    features: z
      .object({
        providerWritesEnabled: z.boolean(),
      })
      .strict(),
    observability: observabilityOverrideSchema.optional(),
    crons: z.array(z.string().trim().min(1).max(100)).max(20),
  })
  .strict()
  .superRefine((manifest, context) => {
    uniqueValues(
      manifest.worker.routes.map((route) => JSON.stringify(route)),
      ['worker', 'routes'],
      context,
    );
    uniqueValues(manifest.crons, ['crons'], context);
    const baseUrl = new URL(manifest.worker.baseUrl);
    if (
      baseUrl.username !== '' ||
      baseUrl.password !== '' ||
      baseUrl.port !== '' ||
      baseUrl.pathname !== '/' ||
      baseUrl.search !== '' ||
      baseUrl.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        path: ['worker', 'baseUrl'],
        message: 'Worker baseUrl must be an HTTPS origin without credentials, a port, or a path.',
      });
    }
    const matchingCustomDomain = manifest.worker.routes.some(
      (route) => 'customDomain' in route && route.pattern === baseUrl.hostname,
    );
    if (!matchingCustomDomain) {
      context.addIssue({
        code: 'custom',
        path: ['worker', 'baseUrl'],
        message: 'Worker baseUrl must match a custom-domain route.',
      });
    }
    if (manifest.access.teamDomain === baseUrl.hostname) {
      context.addIssue({
        code: 'custom',
        path: ['access', 'teamDomain'],
        message: 'Access team domain and Worker base URL must be different hosts.',
      });
    }
  });

export const environmentManifestsSchema = z
  .object({
    release: releaseManifestSchema,
    deployment: deploymentManifestSchema,
    runtime: runtimeConfigurationManifestSchema,
  })
  .strict()
  .superRefine((manifests, context) => {
    const credentialReferences = new Set([
      ...manifests.runtime.directorySources.map((source) => source.credentialRef),
      ...manifests.runtime.providerConnections.flatMap((connection) =>
        connection.credentialRef === undefined ? [] : [connection.credentialRef],
      ),
    ]);
    if (credentialReferences.size > 100) {
      context.addIssue({
        code: 'custom',
        path: ['runtime'],
        message: 'A deployment can reference at most 100 distinct Worker secrets.',
      });
    }
  });

export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type DeploymentManifest = z.infer<typeof deploymentManifestSchema>;
export type EnvironmentManifests = z.infer<typeof environmentManifestsSchema>;

function uniqueValues(values: string[], path: PropertyKey[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: 'custom', path: [...path, index], message: 'Duplicate value.' });
    }
    seen.add(value);
  }
}
