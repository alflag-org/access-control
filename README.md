# Access Control

Access Control is a Cloudflare Workers application for directory-backed application access and provider provisioning. It provides an application portal, an authenticated JSON API, declarative runtime configuration, audit records, and recovery exports.

The application stores its runtime records in Cloudflare D1, uses Cloudflare Queue for asynchronous outbox processing, and stores completed recovery exports in Cloudflare R2. Cloudflare Access supplies the external authentication boundary.

## Current capabilities

- Maps Cloudflare Access identities to managed Subjects and administration roles.
- Reads Google Directory users, groups, and direct group memberships as complete snapshots.
- Calculates effective application entitlements from source-group mappings.
- Manages application catalog entries, sponsored guests, provider connections, and provisioning targets.
- Observes provider state, persists SHA-256-bound operation plans, and executes explicit operations.
- Records mutations in append-only audit events and delivers outbox messages through Queue.
- Creates schema-versioned recovery exports and verifies their R2 checksum.
  Provider behavior is divided by the current Worker wiring:

| Provider               | Worker behavior                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Directory       | Directory observation and snapshot publication                                                                                                                      |
| GitHub                 | Observation, plan creation, explicit apply, and verification                                                                                                        |
| Proxmox, Zabbix, POSIX | Adapter modules for observation, planning, and verification; the Worker does not configure a production observation transport and their apply methods reject writes |

## Requirements

The following software is required to run the application locally:

- Node.js 24.x
- pnpm 11.20.x
- Wrangler 4.x (the repository uses the locked version from `package.json`)

The following Cloudflare services are required to run the application in production:

- Cloudflare Workers
- Cloudflare D1
- Cloudflare Queue
- Cloudflare R2

## Run locally

```sh
mise trust
mise install --locked
mise run bootstrap
pnpm run db:migrate:local
pnpm run bootstrap:admin -- \
  --environment development \
  --database DB \
  --identity access:local-admin \
  --display-name "Local Administrator" \
  --organization-name "Example Organization"
mise run dev
```

The local Worker listens on `http://localhost:8787`. Open `http://localhost:8787/applications` after bootstrapping the local administrator.

Local authentication is enabled by the `mise run dev` command only for loopback requests. The default development identity is `access:local-admin`; a request can override it with the `x-access-control-dev-identity` header using the `access:<subject>` or `service:<common-name>` format.

## Deploy an instance

Keep real environment state in a standalone private deployment repository. Each environment selects an immutable source commit and supplies three manifests:

- `release.json` selects this repository and a full Git commit SHA.
- `deployment.json` selects the Worker and Cloudflare resources.
- `runtime.json` declares the instance's runtime desired state with credential references instead of credential values.

Validate the fictional example and build its generated Worker configuration without publishing:

```sh
pnpm deployment validate --directory deployment/example
mise run deploy-dry-run
```

This public repository does not deploy a persistent environment automatically. See [Deployment](docs/deployment.md) for the private repository boundary, schemas, secrets, first deployment, promotion, and rollback contract.

## License

This repository is distributed under the [Apache License 2.0](LICENSE).
