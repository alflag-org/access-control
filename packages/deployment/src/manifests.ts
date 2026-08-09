import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { z } from 'zod';
import {
  deploymentManifestSchema,
  environmentManifestsSchema,
  releaseManifestSchema,
} from './schema';
import { runtimeConfigurationManifestSchema } from '@access-control/config';

export interface ManifestValidationOptions {
  directory: string;
  expectedEnvironment?: 'production' | 'staging';
  sourceCommit?: string;
  sourceRepository?: string;
}

export async function loadEnvironmentManifests(directory: string) {
  const root = resolve(directory);
  const [release, deployment, runtime] = await Promise.all([
    loadJson(resolve(root, 'release.json'), releaseManifestSchema),
    loadJson(resolve(root, 'deployment.json'), deploymentManifestSchema),
    loadJson(resolve(root, 'runtime.json'), runtimeConfigurationManifestSchema),
  ]);
  return environmentManifestsSchema.parse({ release, deployment, runtime });
}

export async function validateEnvironmentManifests(options: ManifestValidationOptions) {
  const manifests = await loadEnvironmentManifests(options.directory);
  if (
    options.expectedEnvironment !== undefined &&
    manifests.deployment.environment !== options.expectedEnvironment
  ) {
    throw new Error(
      `Deployment environment ${manifests.deployment.environment} does not match ${options.expectedEnvironment}.`,
    );
  }
  if (options.sourceCommit !== undefined && manifests.release.commit !== options.sourceCommit) {
    throw new Error(
      `Release pin ${manifests.release.commit} does not match source checkout ${options.sourceCommit}.`,
    );
  }
  if (
    options.sourceRepository !== undefined &&
    manifests.release.repository !== options.sourceRepository
  ) {
    throw new Error(
      `Release repository ${manifests.release.repository} does not match ${options.sourceRepository}.`,
    );
  }
  return manifests;
}

async function loadJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T>> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Required manifest ${path} could not be read.`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Manifest ${path} is not valid JSON.`, { cause: error });
  }
  return schema.parse(value);
}
