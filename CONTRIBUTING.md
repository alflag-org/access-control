# Contributing

## Repository layout

```text
apps/worker/                 Cloudflare Worker entrypoints, routes, UI, Queue, and cron handlers
packages/domain/             Domain schemas, entities, and invariants
packages/application/        Application services and repository ports
packages/contracts/          API, directory, export, and provider contracts
packages/config/             Runtime configuration validation, planning, and apply client
packages/adapters/d1/        Cloudflare D1 repositories
packages/adapters/*/         Google, GitHub, Proxmox, Zabbix, and POSIX adapters
migrations/                  Ordered D1 migrations
scripts/                     Bootstrap and configuration commands
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

`mise run bootstrap` installs the locked pnpm workspace and generates `worker-configuration.d.ts` from `apps/worker/wrangler.jsonc`.

## Commands

| Command                                                  | Effect                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mise run dev`                                           | Starts the local Worker with loopback development authentication                                                 |
| `mise run smoke`                                         | Applies local D1 migrations and runs the Worker runtime integration test                                         |
| `mise run check`                                         | Validates the example manifest, generates binding types, runs TypeScript, ESLint, Prettier, and all Vitest tests |
| `mise run deploy-dry-run`                                | Builds and validates both named Worker environments without publishing them                                      |
| `mise run deploy`                                        | Publishes the production Worker and applies production D1 migrations                                             |
| `mise run deploy:staging`                                | Publishes the staging Worker and applies staging D1 migrations                                                   |
| `mise run deploy:production`                             | Publishes the production Worker and applies production D1 migrations                                             |
| `pnpm run db:migrate:local`                              | Applies the ordered migrations to the local D1 database                                                          |
| `pnpm run config -- validate --file config/example.json` | Validates a runtime configuration manifest without contacting the API                                            |
| `git diff --check`                                       | Checks changed files for whitespace errors                                                                       |

The CI workflow runs `mise run bootstrap`, `mise run smoke`, `mise run check`, `mise run deploy-dry-run`, and `git diff --check` for pull requests and pushes to `master`.

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

Add a new ordered SQL file under `migrations/`. Apply it locally with `pnpm run db:migrate:local`; the same migration directory is used by `pnpm run db:migrate:remote` during deployment. Tests apply the migration set through the Cloudflare Worker test pool.

Use the pull request fields in [.github/pull_request_template.md](.github/pull_request_template.md) and keep unrelated changes separate.
