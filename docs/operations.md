# Operations

## Web surfaces

The Worker redirects `/` to `/applications`. The authenticated web surfaces include:

- `/applications` for the application catalog visible to the current Subject.
- `/access` for effective access and provenance.
- `/account` for the current Subject, external identities, guest profile, and roles.
- `/admin/people`, `/admin/guests`, `/admin/applications`, `/admin/groups`, `/admin/mappings`, `/admin/provisioning`, `/admin/audit`, and `/admin/settings` for role-authorized administration.
- `/docs` for Swagger UI and `/openapi.json` for the generated OpenAPI document.

`/healthz` requires an authenticated active Subject and returns `{ "status": "ok" }` when the request reaches the handler.

## Administration roles

The platform roles are:

| Role       | Access                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `admin`    | Administration reads and writes, role grants, organization settings, identity binding, and protected Subject changes |
| `operator` | Administration reads and operational writes allowed by route contracts                                               |
| `auditor`  | Administration reads                                                                                                 |

The database preserves at least one active administrator. Administration role grants and governed records are deactivated or retired rather than hard-deleted.

## Directory synchronization

Use the API operation `POST /api/v1/sync-runs/google-directory` with a Directory Source ID. The operation reads all Google Directory pages, records validation violations, and publishes a complete snapshot only after validation. A failed run remains visible as a failed sync record; the last complete published snapshot remains the data used by entitlement calculation.

The scheduled handler does not run directory synchronization. It processes expired managed guests and dispatches pending outbox records every six hours.

## Provider reconciliation

The provisioning API separates observation, plan creation, operation creation, execution, and verification. The normal sequence is:

1. Observe a provider connection and target.
2. Create an operation plan from the persisted observation and current D1 revisions.
3. Create an explicit operation for the plan.
4. Execute the operation.
5. Inspect operation steps, provider state, and audit events.

A plan or operation whose recorded input revisions no longer match current D1 state is rejected. Observe mode prevents plan creation and apply. Protected changes and changes above `organization.maxPlanChanges` are rejected by the operation executor. GitHub apply additionally requires `PROVIDER_WRITES_ENABLED=true`; Proxmox, Zabbix, and POSIX apply calls return an implementation error in the current adapters.

## Declarative configuration

The JSON manifest in `config/example.json` has schema version `1` and contains organization settings, Directory Sources, applications and entitlements, provider connections, provisioning targets, and mappings.

Validate a file without contacting a Worker:

```sh
pnpm run config -- validate --file config/example.json
```

Create a plan against a running Worker:

```sh
ACCESS_CONTROL_BASE_URL=https://worker.example \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
pnpm run config -- plan --file config/example.json --environment production
```

The plan command reads the current configuration through the API and emits a SHA-256 `planHash`. Apply requires that hash from a fresh plan:

```sh
ACCESS_CONTROL_BASE_URL=https://worker.example \
CF_ACCESS_CLIENT_ID=... \
CF_ACCESS_CLIENT_SECRET=... \
pnpm run config -- apply \
  --file config/example.json \
  --environment production \
  --plan-hash sha256:<64-lowercase-hex-characters>
```

The CLI requires HTTPS for staging and production. It uses HTTP only for loopback development addresses.

## Audit and outbox processing

Successful mutating API requests create an audit event and an outbox record in the same D1 mutation. The Worker dispatches pending records after mutating API requests and from scheduled maintenance. Queue delivery uses an outbox claim and delivery receipt; duplicate deliveries are acknowledged after the existing receipt is found. Failed delivery is retried by Queue and can reach the configured dead-letter queue.

## Recovery exports

`POST /api/v1/exports` creates an export record and an outbox request. Queue processing materializes the schema-versioned JSON object at `exports/<export-id>.json` in `EXPORTS_BUCKET`; staging data uses `exports/.staging/<export-id>.json`. The export record stores the final object key and SHA-256 checksum. The materializer rejects secret-like fields and validates the object before marking the record completed.

## Logs and checks

Worker observability is enabled in `apps/worker/wrangler.jsonc`. Structured error logs include an error code and request ID; provider and Queue handlers log stable error codes without logging credential values.

For a local runtime check:

```sh
mise run smoke
```

For the complete repository validation:

```sh
mise run check
```
