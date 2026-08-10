# Contributing

## Repository layout

```text
apps/worker/                 Cloudflare Worker entrypoints, routes, UI, Queue, and cron handlers
packages/domain/             Domain schemas, entities, and invariants
packages/application/        Application services and repository ports
packages/contracts/          API, directory, export, and provider contracts
packages/config/             Runtime configuration validation, planning, and apply client
packages/deployment/         Deployment manifest schemas and generated Wrangler configuration
packages/adapters/d1/        Cloudflare D1 repositories
packages/adapters/*/         Google, GitHub, Proxmox, Zabbix, and POSIX adapters
migrations/                  Ordered D1 migrations
deployment/                  Fictional manifests and generated JSON Schemas
scripts/                     Bootstrap, configuration, and deployment commands
test/                        Unit, integration, API, UI, and adapter tests
```

The dependency direction is:

```text
Worker routes -> application services -> domain
adapters -> application ports and domain contracts
```

## Local setup

```sh
mise trust
mise install --locked
mise run bootstrap
```

`mise run bootstrap` installs the locked pnpm workspace and generates `worker-configuration.d.ts` from `apps/worker/wrangler.json`.

## Commands

| Command                                                       | Effect                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mise run dev`                                                | Starts the local Worker with loopback development authentication                                     |
| `mise run smoke`                                              | Applies local D1 migrations and runs the Worker runtime integration test                             |
| `mise run check`                                              | Validates fictional manifests and schemas, generates binding types, and runs static checks and tests |
| `mise run deploy-dry-run`                                     | Builds the fictional deployment example without publishing it                                        |
| `pnpm run db:migrate:local`                                   | Applies the ordered migrations to the local D1 database                                              |
| `pnpm run config -- validate --file config/example.json`      | Validates a runtime configuration manifest without contacting the API                                |
| `pnpm deployment validate --directory <path>`                 | Validates one complete environment manifest set                                                      |
| `pnpm deployment generate --directory <path> --output <file>` | Generates one temporary Wrangler configuration for inspection                                        |
| `git diff --check`                                            | Checks changed files for whitespace errors                                                           |

The CI workflow runs `mise run bootstrap`, `mise run check`, and `mise run deploy-dry-run` for pull requests and pushes to `master`. It receives no deployment credentials.

## Change constraints

- Keep Worker routes dependent on application services, not on D1 or provider implementations directly.
- Keep mutable records under expected-revision checks.
- Commit state changes, audit events, and outbox records together through the repository mutation boundary.
- Represent lifecycle removal with status changes; the D1 schema rejects hard deletion for governed records.
- Keep provider operations behind observations, persisted operation plans, explicit operations, and verification.
- Keep configuration manifests, fixtures, and tests limited to fictional identities, resources, and provider responses.
- Use runtime binding names such as `GOOGLE_CREDENTIAL` or `GITHUB_CREDENTIAL` instead of credential values in manifests.

Do not commit credentials, Cloudflare Access assertions, provider responses, local Wrangler state, generated runtime types, Cloudflare account IDs, or D1 UUIDs.

## Database changes

Add a new ordered SQL file under `migrations/`. Never rename, edit, or remove an applied migration. Apply the complete set locally with `pnpm run db:migrate:local`. Tests apply the same migration set through the Cloudflare Worker test pool, and private deployment workflows use it from an immutable source commit.

Use the pull request fields in [.github/pull_request_template.md](.github/pull_request_template.md) and keep unrelated changes separate.
