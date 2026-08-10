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

## GitHub Environment inputs

Pull request validation does not select a GitHub Environment and receives no credentials. Manual
deployment selects one protected Environment. Add these values to each Environment after creating
its Cloudflare credentials; do not send them through an issue, pull request, chat, or Git commit.

| Storage  | Name                      | Required    | Use                                                                                      |
| -------- | ------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| Variable | `CLOUDFLARE_ACCOUNT_ID`   | Yes         | Account containing the pre-created Worker, D1, R2, and Queue resources                   |
| Variable | `CF_ACCESS_CLIENT_ID`     | Yes         | Public identifier of the environment's Access service token                              |
| Secret   | `CLOUDFLARE_API_TOKEN`    | Yes         | Cloudflare management API credential used by Wrangler and D1 migration commands          |
| Secret   | `CF_ACCESS_CLIENT_SECRET` | Yes         | Secret half of the environment's Access service token                                    |
| Secret   | `WORKER_SECRET_VALUES`    | Conditional | Exact JSON map for the `credentialRef` names in `runtime.json`; omit when there are none |

For example, an environment with two references stores this value in `WORKER_SECRET_VALUES`:

```json
{
  "GITHUB_CREDENTIAL": "<secret value>",
  "GOOGLE_DIRECTORY_CREDENTIAL": "<secret value>"
}
```

The map must contain exactly the credential references in the selected runtime manifest. Values are written to a mode-`0600` temporary file and uploaded with the Worker version through Wrangler's secrets-file input. The temporary directory is removed after the command. Unlisted existing Worker secrets are preserved.

If the runtime manifest has no credential references, `WORKER_SECRET_VALUES` may be absent.

The variable name `CF_ACCESS_CLIENT_ID` is intentionally the same in both Environments. Enter the
staging service-token client ID in the `staging` Environment and a different production client ID
in the `production` Environment. The workflow selects the Environment before evaluating
`${{ vars.CF_ACCESS_CLIENT_ID }}`, so no `_STAGING` or `_PRODUCTION` suffix and no workflow branch is
needed.

### Cloudflare deployment API token

For the current deployment contract, create an account-scoped API token with exactly these
permissions and restrict its resource scope to the target Cloudflare account:

| Permission             | API operations used by the pinned deployment tooling                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workers Scripts Edit` | Upload the Worker and its secret values; update its custom domain, `workers.dev` state, cron schedules, and Queue consumer; read the pre-created Queues |
| `D1 Edit`              | Read `d1_migrations` and apply pending migrations through the D1 query API                                                                              |

The relevant endpoint families are:

```text
PUT  /accounts/{account_id}/workers/scripts/{script_name}
GET  /accounts/{account_id}/queues
POST /accounts/{account_id}/queues/{queue_id}/consumers
PUT  /accounts/{account_id}/queues/{queue_id}/consumers/{consumer_id}
PUT  /accounts/{account_id}/workers/scripts/{script_name}/domains/records
PUT  /accounts/{account_id}/workers/scripts/{script_name}/schedules
POST /accounts/{account_id}/d1/database/{database_id}/query
```

Wrangler may also read or update script settings under the same Workers Scripts permission. The
generated configuration binds existing D1, R2, and Queue resources, and the command passes
`--experimental-auto-create=false`. Therefore the persistent deployment token does not need
`Queues Edit`, `Workers R2 Storage Edit`, `Workers Routes Edit`, `Zone Read`, `DNS Edit`, Access
management, Workers Builds management, or API token management permissions. Re-evaluate this list
before changing the deployment tooling to create resources, use zone routes, or manage Access.

Cloudflare defines an `Edit` permission as create, read, update, delete, and list access. These two
permissions are account-scoped rather than restricted to one Worker or one D1 database. The token
can therefore affect other Workers and D1 databases in the selected account even though this
workflow does not call those APIs. Use a different token for each GitHub Environment, protect the
Environment, and use a dedicated Cloudflare account when resource-level isolation is required.

Resource creation, Access service token and policy setup, and Workers Builds connection changes
are one-time operator tasks. Keep their broader permissions out of GitHub. When those tasks are
performed through the Cloudflare API, service token creation needs `Access: Service Tokens Write`,
Access application or policy changes need `Access: Apps and Policies Write`, and Workers Builds
configuration changes need `Workers Builds Configuration Edit` plus `Workers Scripts Read`.

### Deployment identity

Create one Access service token per environment. Allow it in that environment's Access policy and
register its exact JWT `common_name` as an active protected `operator` service Subject. The same
identity reads the preflight plan and applies runtime desired state during the explicit deployment.
Staging and production use different identities. Pull requests do not contact either live instance,
so a second plan-only identity is not required.

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

Create the environment's Cloudflare Access service token, allow it in the Access policy, and
register its exact JWT `common_name` as a protected `operator` service Subject. An active human
administrator must already exist:

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

Keep the private workflows thin and separate by effect.

The pull request workflow uses only `contents: read`. It checks out the proposed deployment state
and each immutable source release, installs locked dependencies, runs the source checks, validates
all three manifests, and runs `deployment dry-run`. It does not select a GitHub Environment, use
`pull_request_target`, contact a live instance, or receive a secret.

After merge, the manual deployment workflow should:

1. check out the merged deployment repository;
2. read the chosen environment's `release.json`;
3. check out that exact public repository and commit into a separate working directory;
4. install the source repository's locked tools and dependencies;
5. select the matching protected GitHub Environment; and
6. run `deployment deploy` with only that Environment's variables and secrets.

`deployment deploy` validates the manifests, produces a live preflight plan, performs its own
Worker dry-run, checks migration compatibility, publishes, migrates D1, applies runtime desired
state, and verifies convergence. Repeating those commands in the workflow adds no independent
gate.

Use separate concurrency groups for staging and production, and disable cancellation once a
state-changing deployment begins. Deployment should require `workflow_dispatch` or another
explicit protected-environment approval.

## Promotion and rollback

Upgrade staging by changing only its release pin to a reviewed source commit. Validate and deploy staging, observe the application and scheduled/Queue behavior, then copy that known commit SHA to production and deploy production.

Rollback by restoring the previous known-good release pin and deploying again. A software rollback never reverses D1 migrations. Before changing the Worker, the deployment command compares the remote migration records with the pinned source tree. If the database contains a migration unknown to the older release, rollback stops and requires an explicit forward-compatible remediation.
