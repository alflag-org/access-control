import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  ConfigurationApiClient,
  applyRuntimeConfiguration,
  configurationEnvironmentSchema,
  createConfigurationPlan,
  runtimeConfigurationManifestSchema,
  type ConfigurationEnvironment,
} from '@access-control/config';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

interface Arguments {
  command: 'apply' | 'plan' | 'validate';
  file: string;
  environment?: ConfigurationEnvironment;
  planHash?: string;
}

async function main(): Promise<void> {
  const commandArguments = process.argv.slice(2);
  if (commandArguments[0] === '--') commandArguments.shift();
  const argumentsValue = parseArguments(commandArguments);
  const manifest = await loadManifest(argumentsValue.file);
  if (argumentsValue.command === 'validate') {
    process.stdout.write(
      `${JSON.stringify({ file: argumentsValue.file, schemaVersion: manifest.schemaVersion, valid: true })}\n`,
    );
    return;
  }

  const environment = argumentsValue.environment;
  if (environment === undefined) throw new Error('--environment is required for plan and apply.');
  const baseUrl = requiredEnvironmentVariable('ACCESS_CONTROL_BASE_URL');
  assertTransport(environment, baseUrl);
  const client = new ConfigurationApiClient({
    baseUrl,
    accessClientId: requiredEnvironmentVariable('CF_ACCESS_CLIENT_ID'),
    accessClientSecret: requiredEnvironmentVariable('CF_ACCESS_CLIENT_SECRET'),
  });
  if (argumentsValue.command === 'plan') {
    const plan = await createConfigurationPlan({
      environment,
      manifest,
      snapshot: await client.loadSnapshot(),
      generatedAt: new Date().toISOString(),
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  if (argumentsValue.planHash === undefined) {
    throw new Error('config apply requires --plan-hash sha256:... from a fresh config plan.');
  }
  const finalPlan = await applyRuntimeConfiguration({
    environment,
    manifest,
    client,
    planHash: argumentsValue.planHash,
  });
  process.stdout.write(
    `${JSON.stringify({ environment, appliedPlanHash: argumentsValue.planHash, converged: true, finalPlanHash: finalPlan.planHash })}\n`,
  );
}

async function loadManifest(file: string) {
  const path = resolve(repositoryRoot, file);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    throw new Error(
      code === 'ENOENT'
        ? `Configuration manifest ${file} does not exist.`
        : `Configuration manifest ${file} could not be read.`,
      { cause: error },
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Configuration manifest ${file} is not valid JSON.`);
  }
  return runtimeConfigurationManifestSchema.parse(value);
}

function parseArguments(values: string[]): Arguments {
  const [commandValue, ...options] = values;
  if (commandValue !== 'validate' && commandValue !== 'plan' && commandValue !== 'apply') {
    throw new Error(
      'Usage: config.ts <validate|plan|apply> --file <path> [--environment <name>] [--plan-hash sha256:...].',
    );
  }
  let file: string | undefined;
  let environmentValue: string | undefined;
  let planHash: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const value = options[index + 1];
    if (option === '--file' && value !== undefined) {
      file = value;
      index += 1;
      continue;
    }
    if (option === '--environment' && value !== undefined) {
      environmentValue = value;
      index += 1;
      continue;
    }
    if (option === '--plan-hash' && value !== undefined) {
      planHash = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported configuration argument ${option ?? '(missing)'}.`);
  }
  if (file === undefined || file.trim().length === 0) throw new Error('--file is required.');
  const environment =
    environmentValue === undefined
      ? undefined
      : configurationEnvironmentSchema.parse(environmentValue);
  if (commandValue !== 'validate' && environment === undefined) {
    throw new Error('--environment is required for plan and apply.');
  }
  if (planHash !== undefined && !/^sha256:[a-f0-9]{64}$/.test(planHash)) {
    throw new Error('--plan-hash must use the sha256:<64 lowercase hex characters> format.');
  }
  return {
    command: commandValue,
    file,
    ...(environment === undefined ? {} : { environment }),
    ...(planHash === undefined ? {} : { planHash }),
  };
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function assertTransport(environment: ConfigurationEnvironment, baseUrl: string): void {
  const url = new URL(baseUrl);
  if (environment !== 'development' && url.protocol !== 'https:') {
    throw new Error('Staging and production configuration requests require HTTPS.');
  }
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      process.stderr.write(`${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Configuration command failed.'}\n`,
    );
  }
  process.exitCode = 1;
});
