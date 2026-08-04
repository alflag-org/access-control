# Architecture

## Runtime entrypoints

The Cloudflare Worker in `apps/worker/src/index.ts` exposes three handlers:

- `fetch` serves the browser portal, JSON API, OpenAPI document, and Swagger UI.
- `queue` consumes outbox messages and materializes recovery exports when requested.
- `scheduled` runs every six hours from the cron trigger in `apps/worker/wrangler.jsonc`. It expires managed guests and dispatches pending outbox records.

The Worker uses Hono and OpenAPIHono for routing and Zod schemas for request and response validation. A request receives a request ID, is authenticated, is mapped to a Subject and active roles, and then reaches an authorized route handler.

## Cloudflare resources

| Resource          | Binding          | Current use                                                                                                                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1                | `DB`             | Subjects, identities, guests, directory snapshots, applications, entitlements, provider state, plans, operations, audit events, outbox records, and export records |
| R2                | `EXPORTS_BUCKET` | Temporary and final recovery export objects                                                                                                                        |
| Queue             | `OUTBOX_QUEUE`   | Asynchronous delivery of audit-linked outbox messages and export materialization                                                                                   |
| Cloudflare Access | request JWT      | External authentication and principal identity                                                                                                                     |

The Worker configuration enables observability logs and traces, Node.js compatibility, and the `0 */6 * * *` cron trigger.

## Package boundaries

```text
apps/worker/src/api       HTTP routes, authentication middleware, and UI
apps/worker/src/queue     Outbox dispatch, Queue consumption, and R2 export objects
apps/worker/src/scheduled Guest expiration and scheduled outbox dispatch
packages/domain           Domain objects, schemas, status transitions, and invariants
packages/application      Use cases and repository ports
packages/adapters/d1      D1 repository implementations
packages/adapters/*      External directory and provider adapters
packages/config           Manifest validation, plan generation, and API apply client
packages/contracts        Shared API, directory, export, and provider contracts
```

Application services depend on repository and provider ports. The Worker supplies D1 repositories and the provider transports. Domain packages do not depend on Worker or D1 modules.

## Identity and access flow

1. Cloudflare Access supplies a JWT assertion for a deployed request.
2. The Worker validates the issuer, audience, time claims, RSA signing key, and signature.
3. The verified principal is looked up by provider, issuer, and provider subject.
4. An active external identity resolves to an active Subject and active platform roles.
5. Route contracts authorize the Subject by role before an application service runs.

An authenticated principal without a mapped active Subject can use the session response and access-required surface, but protected portal and API resources require an active Subject.

## Directory and entitlement flow

The Google Directory adapter reads all pages of users, groups, and direct group memberships. The directory service validates the complete snapshot, derives lifecycle state and violations, recalculates effective grants, and publishes the snapshot through the D1 repository boundary. A failed or incomplete read does not publish a partial snapshot.

An active source-group mapping refers to one or more application entitlements. Effective grants combine the mapping, source-group membership, Subject identity, validity dates, and lifecycle statuses. Applications are visible to all active Subjects or only to Subjects with an active effective grant, according to the application visibility setting.

## Provider operation flow

Provider reconciliation stores these records in D1:

1. A provider observation contains provider state and a SHA-256 checksum.
2. A persisted operation plan binds the observation, input revisions, effective grants, required targets, and plan hash.
3. A caller explicitly creates one operation for a plan.
4. The executor rechecks current revisions, the plan hash, provider mode, bulk-change limit, protection flags, and provider state before applying a change.
5. The executor records step evidence and verifies the provider state.

`observe` mode blocks plan creation and provider apply. `plan` and `automatic` modes are accepted by the configuration schema, but the Worker operation API still requires an explicit operation. GitHub is the only provider with a configured Worker transport; its writes are additionally gated by `PROVIDER_WRITES_ENABLED`. The Proxmox, Zabbix, and POSIX transports in the Worker use an unavailable transport, and those adapters reject apply calls.

## Persistence invariants

- Mutable records use positive integer revisions and expected-revision checks.
- Stable identity fields and plan content are immutable after creation.
- Governed records use lifecycle statuses; D1 triggers reject hard deletion.
- State mutation, audit event creation, and outbox creation are committed together by repository mutation methods.
- Audit events are append-only.
- Outbox payloads are immutable and delivery uses claims and delivery receipts.
- Export records reference an R2 object key and checksum after successful materialization.

## API contract

Route definitions in `apps/worker/src/api/route-contracts.ts` generate the OpenAPI 3.1 document at `/openapi.json`. The authenticated `/docs` route renders Swagger UI from that document. JSON errors use an `error` object with a stable code and a request ID; validation errors may include violation entries.
