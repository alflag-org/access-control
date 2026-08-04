import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

type DeploymentEnvironment = 'staging' | 'production';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const environment = parseEnvironment(process.argv[2]);
const accessTeamDomain = optionalBuildVariable('ACCESS_TEAM_DOMAIN');
const accessAudience = optionalBuildVariable('ACCESS_AUD');

if ((accessTeamDomain === undefined) !== (accessAudience === undefined)) {
  throw new Error(
    'ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together in the Workers Builds environment.',
  );
}

const accessVariableArguments =
  accessTeamDomain === undefined || accessAudience === undefined
    ? []
    : ['--var', `ACCESS_TEAM_DOMAIN:${accessTeamDomain}`, '--var', `ACCESS_AUD:${accessAudience}`];

run(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--config',
    'apps/worker/wrangler.jsonc',
    '--env',
    environment,
    '--experimental-auto-create=false',
    '--keep-vars',
    ...accessVariableArguments,
  ],
  'Worker deploy',
);

run('pnpm', ['run', `db:migrate:${environment}`], 'D1 migration');

function parseEnvironment(value: string | undefined): DeploymentEnvironment {
  if (value === 'staging' || value === 'production') return value;
  throw new Error('Usage: deploy-environment.ts <staging|production>.');
}

function optionalBuildVariable(name: string): string | undefined {
  const value = process.env[name];
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 || trimmed === 'unset' ? undefined : trimmed;
}

function run(command: string, arguments_: string[], label: string): void {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status ?? 'unknown'}.`);
  }
}
