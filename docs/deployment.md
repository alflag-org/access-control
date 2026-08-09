# Deployment

## Repository boundary

This repository is the Access Control source repository: the public application source, domain and configuration schemas, D1 migrations, tests, and environment-independent deployment tooling. It contains no real organization names, Cloudflare resource identifiers, hostnames, Access audiences, or credentials.

A deployed instance uses a separate standalone private deployment repository. That repository stores desired state only:

```text
environments/
  staging/
    release.json
    deployment.json
    runtime.json
  production/
    release.json
    deployment.json
    runtime.json
.github/workflows/
  validate.yml
  deploy.yml
```

Do not fork, mirror, copy, vendor, or submodule this source tree into the deployment repository. The deployment repository checks out the immutable source commit selected by each environment and runs the deployment commands from that checkout.

The private deployment repository is the only deployment authority. Do not connect this public repository directly to a persistent Worker through Workers Builds or another automatic deployment integration.

## Environment manifests

Each environment has three JSON files:

| File              | Contents                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `release.json`    | Source repository in `owner/name` form and a full 40-character lowercase Git commit SHA                                                    |
| `deployment.json` | Worker name and URL, routes, D1/R2/Queue resources, Cloudflare Access settings, feature gates, observability overrides, and cron schedules |
| `runtime.json`    | Organization settings, Directory Sources, applications, provider connections, provisioning targets, and mappings                           |

`release.json` is the release pin. Branch names and tags are rejected because they can move.

`deployment.json` contains identifiers and non-secret Cloudflare settings. Deployed environments force `workers_dev=false`, `preview_urls=false`, and `ALLOW_LOCAL_AUTH=false`. Automatic resource creation is disabled.

`runtime.json` uses `credentialRef` values such as `GOOGLE_DIRECTORY_CREDENTIAL`. A credential reference is a Worker binding name, never a credential value.

Schemas are committed under `deployment/schemas/`. `deployment/example/` is a fictional complete example. Regenerate or verify schemas with:

```sh
pnpm deployment:schemas
pnpm deployment:schemas:check
```

The command-line validator also checks relationships that cannot be expressed across three independent JSON Schema documents.

## Validate and build

From a checkout of the source commit selected by `release.json`:

```sh
source_commit=$(git rev-parse HEAD)

pnpm deployment validate \
  --directory /path/to/deployment-repository/environments/staging \
  --expected-environment staging \
  --source-repository example/access-control \
  --source-commit "$source_commit"

pnpm deployment dry-run \
  --directory /path/to/deployment-repository/environments/staging \
  --expected-environment staging \
  --source-repository example/access-control \
  --source-commit "$source_commit"
```

`validate` rejects unknown fields, movable release pins, mismatched environments, source checkout mismatches, invalid resource values, plaintext credential-like fields, and inconsistent runtime references.

`dry-run` combines `apps/worker/wrangler.json` with one `deployment.json` in a temporary generated Wrangler configuration, then runs `wrangler deploy --dry-run` with automatic resource creation disabled. The generated file is not deployment state and must not be committed.

Use `generate` only when inspecting that intermediate configuration:

```sh
pnpm deployment generate \
  --directory /path/to/environment \
  --output /tmp/access-control-wrangler.json
```

## Deployment secrets

Store secrets in the matching protected GitHub Environment. An environment with pull request
planning and deployment needs:

| GitHub Environment secret      | Use                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`        | Cloudflare account containing the declared resources                                            |
| `CLOUDFLARE_API_TOKEN`         | Least-privilege token for Worker, D1, R2, Queue, route, and secret changes used by the workflow |
| `CF_ACCESS_PLAN_CLIENT_ID`     | Access service token client ID used only for pull request plans                                 |
| `CF_ACCESS_PLAN_CLIENT_SECRET` | Access service token client secret used only for pull request plans                             |
| `CF_ACCESS_CLIENT_ID`          | Access service token client ID used for deployment plan/apply                                   |
| `CF_ACCESS_CLIENT_SECRET`      | Access service token client secret used for deployment plan/apply                               |
| `WORKER_SECRET_VALUES`         | JSON object mapping every `credentialRef` in `runtime.json` to its secret value                 |

For example, an environment with two references stores this value in `WORKER_SECRET_VALUES`:

```json
{
  "GITHUB_CREDENTIAL": "<secret value>",
  "GOOGLE_DIRECTORY_CREDENTIAL": "<secret value>"
}
```

The map must contain exactly the credential references in the selected runtime manifest. Values are written to a mode-`0600` temporary file and uploaded with the Worker version through Wrangler's secrets-file input. The temporary directory is removed after the command. Unlisted existing Worker secrets are preserved.

If the runtime manifest has no credential references, `WORKER_SECRET_VALUES` may be absent.

Both Access service tokens must be allowed by the environment's Access policy. Register the plan
identity as an active protected `auditor` service Subject and the deployment identity as an active
protected `operator` service Subject. Keep both identities separate between staging and production.

## First deployment

First publish the Worker, Worker secrets, and D1 migrations without attempting runtime configuration:

```sh
pnpm deployment publish \
  --directory /path/to/environment \
  --expected-environment staging \
  --source-repository example/access-control \
  --source-commit "$(git rev-parse HEAD)"
```

Create the first administrator once the database is available:

```sh
pnpm bootstrap:admin -- \
  --environment staging \
  --database access-control-staging \
  --identity access:your-access-subject \
  --issuer https://your-team.cloudflareaccess.com \
  --display-name "Administrator" \
  --organization-name "Example Organization"
```

The command refuses to create a second active administrator.

Create separate plan and deployment Cloudflare Access service tokens, allow both in the
environment's Access policy, and register each exact JWT `common_name` as a protected service
Subject. An active human administrator must already exist:

```sh
pnpm bootstrap:service-principal -- \
  --environment staging \
  --database access-control-staging \
  --issuer https://your-team.cloudflareaccess.com \
  --common-name access-control-plan-staging \
  --role auditor
```

```sh
pnpm bootstrap:service-principal -- \
  --environment staging \
  --database access-control-staging \
  --issuer https://your-team.cloudflareaccess.com \
  --common-name access-control-deployment-staging \
  --role operator
```

The command rejects a missing administrator or duplicate Access identity and writes the Subject,
identity, role grant, audit event, and outbox record as one guarded D1 operation.

Create a runtime configuration plan with the environment's Access service token:

```sh
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
pnpm deployment plan \
  --directory /path/to/environment \
  --expected-environment staging
```

Review `changes` and `blockedChanges`. Apply only a fresh reviewed hash:

```sh
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
pnpm deployment apply \
  --directory /path/to/environment \
  --expected-environment staging \
  --plan-hash sha256:<64-lowercase-hex-characters>
```

Apply recomputes the plan, rejects a stale hash or blocked change, performs ordered changes, and verifies convergence.

## Routine deployment

`deploy` performs the publish path and then plans and applies runtime desired state:

```sh
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
WORKER_SECRET_VALUES='{}' \
pnpm deployment deploy \
  --directory /path/to/environment \
  --expected-environment staging \
  --source-repository example/access-control \
  --source-commit "$(git rev-parse HEAD)"
```

The command:

1. validates all manifests and the release pin;
2. reads current runtime state and rejects a blocked preflight plan;
3. performs a Worker bundle dry-run;
4. reads the remote `d1_migrations` table and stops if the database contains a migration absent from the pinned source release;
5. publishes the generated Worker configuration and referenced secrets;
6. applies pending D1 migrations by database name; and
7. recomputes, applies, and verifies runtime desired state.

D1 migration files are append-only operational state. Do not rename, edit, or remove an applied migration.

## Private workflow contract

A thin private workflow has separate pull request and deployment paths.

The pull request path first runs without secrets. It checks out the proposed deployment state and
its immutable source release, installs locked dependencies, runs the source checks, validates all
three manifests, and runs `deployment dry-run`.

A second read-only job produces the runtime configuration plan with the plan identity. In GitHub
Actions, run this job from the trusted base branch with `pull_request_target`. Do not check out or
execute pull request code in that job. Use the base branch's workflow, `release.json`,
`deployment.json`, and pinned source release; download the proposed `runtime.json` only as input
data for the trusted `deployment plan` command. The job receives
`CF_ACCESS_PLAN_CLIENT_ID` and `CF_ACCESS_PLAN_CLIENT_SECRET`, mapped to the CLI's
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. It receives no Cloudflare deployment token,
Worker secret value, or deployment identity.

After merge, the deployment path should:

1. check out the merged deployment repository;
2. read the chosen environment's `release.json`;
3. check out that exact public repository and commit into a separate working directory;
4. install the source repository's locked tools and dependencies;
5. repeat the source checks, manifest validation, and `deployment dry-run`;
6. select the matching protected GitHub Environment; and
7. run `deployment deploy` with only that environment's deployment secrets.

Use separate concurrency groups for staging and production, and disable cancellation once a
state-changing deployment begins. Deployment should require `workflow_dispatch` or another
explicit protected-environment approval.

## Promotion and rollback

Upgrade staging by changing only its release pin to a reviewed source commit. Validate and deploy staging, observe the application and scheduled/Queue behavior, then copy that known commit SHA to production and deploy production.

Rollback by restoring the previous known-good release pin and deploying again. A software rollback never reverses D1 migrations. Before changing the Worker, the deployment command compares the remote migration records with the pinned source tree. If the database contains a migration unknown to the older release, rollback stops and requires an explicit forward-compatible remediation.
