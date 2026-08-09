import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  ConfigurationApiClient,
  applyRuntimeConfiguration,
  createConfigurationPlan,
  type ConfigurationPlan,
} from '@access-control/config';
import {
  assertAppliedMigrationsCompatible,
  credentialReferences,
  d1QueryRows,
  generateWranglerConfiguration,
  loadAcceptedMigrationNames,
  migrationNamesFromD1Response,
  parseWorkerSecretValues,
  validateEnvironmentManifests,
  type EnvironmentManifests,
} from '@access-control/deployment';

type DeploymentCommand =
  'apply' | 'deploy' | 'dry-run' | 'generate' | 'plan' | 'publish' | 'validate';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const baseConfigPath = resolve(repositoryRoot, 'apps/worker/wrangler.json');
const migrationsDirectory = resolve(repositoryRoot, 'migrations');

interface Arguments {
  command: DeploymentCommand;
  directory: string;
  expectedEnvironment?: 'production' | 'staging';
  output?: string;
  planHash?: string;
  sourceCommit?: string;
  sourceRepository?: string;
}

async function main(): Promise<void> {
  const argumentsValue = parseCommandArguments(process.argv.slice(2));
  const manifests = await validateEnvironmentManifests({
    directory: argumentsValue.directory,
    ...(argumentsValue.expectedEnvironment === undefined
      ? {}
      : { expectedEnvironment: argumentsValue.expectedEnvironment }),
    ...(argumentsValue.sourceCommit === undefined
      ? {}
      : { sourceCommit: argumentsValue.sourceCommit }),
    ...(argumentsValue.sourceRepository === undefined
      ? {}
      : { sourceRepository: argumentsValue.sourceRepository }),
  });

  switch (argumentsValue.command) {
    case 'validate':
      printJson(validationResult(manifests));
      return;
    case 'generate': {
      if (argumentsValue.output === undefined) {
        throw new Error('deployment generate requires --output.');
      }
      const outputPath = resolve(argumentsValue.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeGeneratedConfiguration(outputPath, manifests);
      printJson({ environment: manifests.deployment.environment, output: outputPath });
      return;
    }
    case 'dry-run':
      await withGeneratedConfiguration(manifests, async (configPath) => {
        runWrangler([
          'deploy',
          '--config',
          configPath,
          '--dry-run',
          '--experimental-auto-create=false',
        ]);
      });
      printJson({ environment: manifests.deployment.environment, dryRun: true });
      return;
    case 'plan': {
      const plan = await createRemotePlan(manifests);
      printJson(plan);
      assertPlanUnblocked(plan);
      return;
    }
    case 'apply': {
      if (argumentsValue.planHash === undefined) {
        throw new Error('deployment apply requires --plan-hash from a fresh deployment plan.');
      }
      const finalPlan = await applyRemotePlan(manifests, argumentsValue.planHash);
      printJson({
        environment: manifests.deployment.environment,
        appliedPlanHash: argumentsValue.planHash,
        finalPlanHash: finalPlan.planHash,
        converged: finalPlan.changes.length === 0 && finalPlan.blockedChanges.length === 0,
      });
      return;
    }
    case 'publish':
      await publishEnvironment(manifests);
      return;
    case 'deploy':
      await deployEnvironment(manifests);
      return;
  }
}

async function deployEnvironment(manifests: EnvironmentManifests): Promise<void> {
  const preflightPlan = await createRemotePlan(manifests);
  printJson({ phase: 'preflight', ...preflightPlan });
  assertPlanUnblocked(preflightPlan);
  await publishEnvironment(manifests);
  const plan = await createRemotePlan(manifests);
  printJson(plan);
  assertPlanUnblocked(plan);
  const finalPlan =
    plan.changes.length === 0 ? plan : await applyRemotePlan(manifests, plan.planHash);
  printJson({
    environment: manifests.deployment.environment,
    releaseCommit: manifests.release.commit,
    worker: manifests.deployment.worker.name,
    finalPlanHash: finalPlan.planHash,
    converged: finalPlan.changes.length === 0 && finalPlan.blockedChanges.length === 0,
  });
}

async function publishEnvironment(manifests: EnvironmentManifests): Promise<void> {
  const workerSecrets = parseWorkerSecretValues(
    process.env.WORKER_SECRET_VALUES,
    manifests.runtime,
  );
  await withGeneratedConfiguration(manifests, async (configPath) => {
    runWrangler([
      'deploy',
      '--config',
      configPath,
      '--dry-run',
      '--experimental-auto-create=false',
    ]);
    const appliedMigrations = readAppliedMigrationNames(
      configPath,
      manifests.deployment.resources.database.name,
    );
    const acceptedMigrations = await loadAcceptedMigrationNames({
      migrationsDirectory,
    });
    assertAppliedMigrationsCompatible(appliedMigrations, acceptedMigrations);
    const deployArguments = ['deploy', '--config', configPath, '--experimental-auto-create=false'];
    if (Object.keys(workerSecrets).length > 0) {
      const secretsPath = resolve(dirname(configPath), 'worker-secrets.json');
      await writeFile(secretsPath, JSON.stringify(workerSecrets) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
      deployArguments.push('--secrets-file', secretsPath);
    }
    runWrangler(deployArguments);
    runWrangler([
      'd1',
      'migrations',
      'apply',
      manifests.deployment.resources.database.name,
      '--config',
      configPath,
      '--remote',
      '--experimental-auto-create=false',
    ]);
  });

  printJson({
    environment: manifests.deployment.environment,
    releaseCommit: manifests.release.commit,
    worker: manifests.deployment.worker.name,
    published: true,
  });
}

async function createRemotePlan(manifests: EnvironmentManifests): Promise<ConfigurationPlan> {
  const client = configurationClient(manifests);
  return createConfigurationPlan({
    environment: manifests.deployment.environment,
    manifest: manifests.runtime,
    snapshot: await client.loadSnapshot(),
    generatedAt: new Date().toISOString(),
  });
}

async function applyRemotePlan(
  manifests: EnvironmentManifests,
  planHash: string,
): Promise<ConfigurationPlan> {
  return applyRuntimeConfiguration({
    environment: manifests.deployment.environment,
    manifest: manifests.runtime,
    client: configurationClient(manifests),
    planHash,
  });
}

function configurationClient(manifests: EnvironmentManifests): ConfigurationApiClient {
  return new ConfigurationApiClient({
    baseUrl: manifests.deployment.worker.baseUrl,
    accessClientId: requiredEnvironmentVariable('CF_ACCESS_CLIENT_ID'),
    accessClientSecret: requiredEnvironmentVariable('CF_ACCESS_CLIENT_SECRET'),
  });
}

async function withGeneratedConfiguration(
  manifests: EnvironmentManifests,
  operation: (configPath: string) => Promise<void>,
): Promise<void> {
  const workDirectory = await mkdtemp(resolve(tmpdir(), 'access-control-deployment-'));
  const configPath = resolve(workDirectory, 'wrangler.json');
  try {
    await writeGeneratedConfiguration(configPath, manifests);
    await operation(configPath);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function writeGeneratedConfiguration(
  outputPath: string,
  manifests: EnvironmentManifests,
): Promise<void> {
  const config = await generateWranglerConfiguration({
    baseConfigPath,
    outputPath,
    deployment: manifests.deployment,
    requiredSecrets: credentialReferences(manifests.runtime),
  });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function readAppliedMigrationNames(configPath: string, databaseName: string): string[] {
  const baseArguments = [
    'd1',
    'execute',
    databaseName,
    '--config',
    configPath,
    '--remote',
    '--experimental-auto-create=false',
    '--json',
  ];
  const tables = d1QueryRows(
    captureWrangler([
      ...baseArguments,
      '--command',
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'",
    ]),
  );
  if (tables.length === 0) return [];
  return migrationNamesFromD1Response(
    captureWrangler([...baseArguments, '--command', 'SELECT name FROM d1_migrations ORDER BY id']),
  );
}

function runWrangler(arguments_: string[]): void {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Wrangler failed with status ${result.status ?? 'unknown'}.`);
  }
}

function captureWrangler(arguments_: string[]): string {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Wrangler failed with status ${result.status ?? 'unknown'}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function assertPlanUnblocked(plan: ConfigurationPlan): void {
  if (plan.blockedChanges.length === 0) return;
  const codes = [...new Set(plan.blockedChanges.map((change) => change.blockedCode))].sort();
  throw new Error(`Configuration plan is blocked by: ${codes.join(', ')}.`);
}

function validationResult(manifests: EnvironmentManifests) {
  return {
    environment: manifests.deployment.environment,
    repository: manifests.release.repository,
    commit: manifests.release.commit,
    worker: manifests.deployment.worker.name,
    valid: true,
  };
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parseCommandArguments(values: string[]): Arguments {
  const commandArguments = [...values];
  if (commandArguments[0] === '--') commandArguments.shift();
  const command = commandArguments.shift();
  if (!isDeploymentCommand(command)) {
    throw new Error(
      'Usage: deployment.ts <validate|generate|dry-run|plan|apply|publish|deploy> --directory <path>.',
    );
  }
  const parsed = parseArgs({
    args: commandArguments,
    options: {
      directory: { type: 'string' },
      'expected-environment': { type: 'string' },
      output: { type: 'string' },
      'plan-hash': { type: 'string' },
      'source-commit': { type: 'string' },
      'source-repository': { type: 'string' },
    },
    strict: true,
  }).values;
  if (parsed.directory === undefined || parsed.directory.trim().length === 0) {
    throw new Error('--directory is required.');
  }
  if (
    parsed['expected-environment'] !== undefined &&
    parsed['expected-environment'] !== 'staging' &&
    parsed['expected-environment'] !== 'production'
  ) {
    throw new Error('--expected-environment must be staging or production.');
  }
  if (parsed['source-commit'] !== undefined && !/^[a-f0-9]{40}$/.test(parsed['source-commit'])) {
    throw new Error('--source-commit must be a full lowercase Git SHA.');
  }
  if (parsed['plan-hash'] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(parsed['plan-hash'])) {
    throw new Error('--plan-hash must use the sha256:<64 lowercase hex characters> format.');
  }
  return {
    command,
    directory: parsed.directory,
    ...(parsed['expected-environment'] === undefined
      ? {}
      : { expectedEnvironment: parsed['expected-environment'] }),
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed['plan-hash'] === undefined ? {} : { planHash: parsed['plan-hash'] }),
    ...(parsed['source-commit'] === undefined ? {} : { sourceCommit: parsed['source-commit'] }),
    ...(parsed['source-repository'] === undefined
      ? {}
      : { sourceRepository: parsed['source-repository'] }),
  };
}

function isDeploymentCommand(value: string | undefined): value is DeploymentCommand {
  return (
    value === 'apply' ||
    value === 'deploy' ||
    value === 'dry-run' ||
    value === 'generate' ||
    value === 'plan' ||
    value === 'publish' ||
    value === 'validate'
  );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      process.stderr.write(`${issue.path.join('.') || '<root>'}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Deployment command failed.'}\n`,
    );
  }
  process.exitCode = 1;
});
