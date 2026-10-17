# AWS IAM Identity Center provisioning via Access Control

Status: proposed design (no production integration or credential changes)
Owner: Access Control
Primary objective: Google Workspace remains the identity authority; Access Control provisions identities and group memberships to AWS IAM Identity Center without an additional identity provider, ssosync deployment, AWS Lambda, or long-lived AWS IAM access keys.

## Decisions and boundaries

1. **Authentication stays at Google Workspace.** AWS IAM Identity Center trusts Google via SAML 2.0. Access Control never handles passwords, MFA, SAML signing certificates, or identity-provider login sessions.
2. **Google Directory is the source of truth.** Only managed users and **direct** memberships of explicitly scoped access groups are eligible for AWS provisioning. No group nesting, external member, alias-as-identity, or guest expansion.
3. **Access Control is the provisioning control plane.** The Google Directory adapter produces a validated snapshot; reconciliation observes target state, produces a version-bound and auditable plan, and applies bounded changes via the AWS IAM Identity Center SCIM 2.0 API.
4. **AWS owns authorization infrastructure.** Permission sets, target AWS accounts, and group-to-permission-set account assignments remain declaratively managed in infrastructure-as-code. Access Control manages user and group **membership**, not IAM policies, account creation, billing, or AWS Organizations. Avoid parallel ownership of group memberships by Terraform, Google Workspace auto-provisioning, and Access Control.
5. **No destructive reconciliation by default.** User deletion, group deletion, mass membership changes, protected administrator membership removal, and unowned AWS records require explicit operator review. An approved, bounded removal of an ordinary membership is a supported revocation, not a delete of its user or group.

This follows the existing architecture's observation, planning, explicit operation, verification, revision, lock, audit, and outbox principles.

## Existing code and necessary gaps

| Component | Present | Change |
| --- | --- | --- |
| Google Directory snapshot | `packages/adapters/google` reads users, groups, direct memberships | Preserve; export structured given/family names and define AWS eligibility rules |
| Directory publication / grants | `DirectorySyncService` publishes validated snapshots | Expose versioned, complete AWS desired state; fail closed on bad source data |
| Provider reconciliation | `ReconciliationService` is currently per-subject/per-entitlement | Add **directory-target reconciliation** for shared users/groups and membership sets; do not create an AWS group as a hidden side effect of an unrelated subject operation |
| Provider adapters | Google, GitHub, Proxmox, Zabbix, POSIX | Add `packages/adapters/aws-identity-center` and contracts |
| Worker provider wiring | GitHub transport supports apply; other listed providers largely observe | Wire AWS SCIM transport behind production write gate |
| Scheduled jobs | Guest expiration and outbox dispatch only | Add bounded, locked Google Directory sync and AWS reconciliation |
| Declarative configuration | Provider connections / entitlements / mappings | Validate AWS SCIM connection and scoped directory target in versioned manifest |
| Tests | Domain/application/provider/Worker tests | Add SCIM contract, idempotence, failure, safety, and integration tests |

### Required Google attributes

The current `ObservedDirectoryUser` and `normalizeUser` retain a full display name but discard Google's `name.givenName` and `name.familyName`. AWS SCIM `CreateUser` requires `givenName`, `familyName`, `userName`, and `displayName`. Add properly typed given/family name fields to the directory contract and normalized snapshot; do **not** guess by splitting `fullName`.

## AWS SCIM connection and data mapping

Connection type: `aws_identity_center` (proposed).
Transport: HTTPS requests to an **explicitly configured, allowlisted AWS SCIM endpoint** from IAM Identity Center's Automatic provisioning page.

- Authentication: `Authorization: Bearer <token>`, with the token in a Cloudflare Worker secret binding. Never place it in D1, a repository, manifest, audit payload, HTTP response, or log.
- Endpoint: use the exact AWS-issued `https://scim.<region>.amazonaws.com/<tenant>/scim/v2` URL (or AWS-issued dual-stack variant); no guessed tenant IDs or hostnames.
- Protect against SSRF: validate protocol, exact AWS SCIM host pattern, region, tenant path, redirects disabled, and no user-provided path overrides.
- Tokens expire after one year. Support secret rotation, explicit expiry monitoring and alerts, and health checks. AWS permits two tokens during rotation.
- The AWS SCIM API uses bearer tokens; no AWS IAM access key, SigV4 signing, Lambda, NAT Gateway, or new identity provider is necessary for the provisioning path.

### Identity mapping

| Source | AWS SCIM | Rule |
| --- | --- | --- |
| Google user immutable ID | `User.externalId` | Stable matching across email changes |
| Google `primaryEmail` | `User.userName`, `emails[0].value` | Must match Google SAML NameID; one primary email only |
| Google `name.givenName` / `name.familyName` | `User.name.givenName` / `name.familyName` | Required; do not infer from fullName |
| Google display name | `User.displayName` | Present, validated |
| Google suspended / lifecycle state | `User.active` and effective memberships | Suspended users cannot keep active access |
| Google group immutable ID | `Group.externalId` | Stable group mapping |
| Google group canonical email | `Group.displayName` | Deterministic human-readable value; normalize case |
| Direct eligible group members | `Group.members` | Refer to provisioned AWS SCIM user IDs |

Source scope defaults to **managed users who have direct membership in explicitly configured `access.aws.*` groups**; source groups outside the allowlist must not be provisioned to AWS. An admin bootstrap subject may be explicitly marked protected, but does not bypass external-identity validation.

Maintain a durable provider-ID mapping in D1 for observed AWS IDs, linked to Google immutable IDs. On the first import, use `externalId` filtering and examine any existing records for conflicts. Never assume a matching display name is proof of ownership or automatically take over manually created records.

### Read, plan, apply, verify

1. **Source snapshot:** fully list Google users, scoped groups and direct memberships; publish only a complete validated snapshot with snapshot hash/version and freshness timestamp. If the Google API fails, keep the last verified snapshot and **do not** issue removals based on a partial/empty read.
2. **Target observation:** list/filter AWS SCIM Users and Groups using `externalId` and cursor pagination. **Important:** AWS `GetGroup` and `ListGroups` omit actual member lists; observe memberships with the documented membership-filtered `ListUsers`/`ListGroups` operations rather than trusting the empty `members` field.
3. **Planning:** compare source and observed target; generate a deterministic ordered plan (create user, create group, add memberships, update profile, remove revoked membership, suspend inactive users). Bind plan hash to source snapshot, target observation, configuration version and protected-resource flags.
4. **Execution:** require successful source validation, eligible target, unexpired plan, non-overlapping D1 lock, configured write mode, protected-entity checks, and max-change thresholds. Use idempotency checks and bounded 429/5xx retries; surface 401/403 as errors and stop.
5. **Verification:** re-observe the affected AWS resources, persist per-step evidence, reconcile the updated state, and emit audit/outbox records without email lists or credentials in logs.

Implement this as a dedicated **directory-target reconciliation service**, extending the existing provider model where appropriate. The current per-subject provisioning-state contract is insufficient for a shared directory of users and groups; do not bypass its invariants or overload a per-user entitlement with hidden directory-wide mutations.

### Revocation and deletion rules

- A Google user suspended or explicitly removed from AWS access groups must lose active AWS group memberships after a complete source snapshot and approved/bounded apply.
- Suspend/deactivate the user when applicable, but do **not** hard-delete AWS users or groups in v1.
- Missing Google groups, major membership-count drops, Google API failures and orphaned AWS objects must block destructive automation and raise operator-visible drift.
- Validate nested/external group members as unsupported and fail closed for effective AWS grants.
- Protect the final administrative access path and maintain a verified emergency/root recovery path. Avoid granting AWS management account administrator access to synchronization workers.

AWS SCIM `PatchGroup` does **not** support replacing/removing *all* memberships in one request and supports at most 100 membership changes per call. Perform specific member removals with verification and bounded batches.

## Operations, scheduling and security

- Initial connection mode `observe`; import/inspect existing AWS identities; test a nonprivileged account before enabling writes.
- First write phase: operator-reviewed plan, then explicit apply. Enable scheduled small-diff convergence only after a successful validation window. For important revocations provide a manual immediate sync/apply action.
- Extend the existing Worker `scheduled` handler to coordinate Google directory sync, AWS observation/reconciliation, and outbox processing. Keep the existing maintenance actions unchanged.
- Target a 15-minute trigger; make the schedule configurable. Use D1 locking, continuation/Queue batches, bounded external subrequests, and retryable cursors to respect Cloudflare Free Workers limits. A single invocation must not assume a large Google Directory or AWS dataset fits under Free plan limits.
- Cloudflare Worker secrets: existing Google credentials plus the AWS SCIM bearer token. Do not introduce a second Google Directory credentials store. Maintain secret rotation runbooks.
- The data plane stores provider identifiers and operation evidence; restrict PII access, audit management changes, avoid credential logging.
- Limit writes to configured AWS IAM Identity Center instance and only to the identity store scope; SCIM cannot manage AWS permission sets or Organizations resources.
- Prevent competing writers: Google Workspace's native AWS SCIM auto-provisioning and ssosync **must remain disabled** for this destination. One authoritative writer: Access Control.

## AWS infrastructure integration

- Create/access the IAM Identity Center organization instance and Google SAML application through administrative bootstrap; **first resolve and test the current SAML login error separately**.
- Enable Automatic provisioning to obtain an AWS SCIM endpoint and token. Add only the endpoint reference and secret binding to a private deployment configuration, never real tenant IDs or tokens in this public repository.
- Create a source Google Group representing the intended AWS access, e.g. `access.aws.isucon.operator@example.org`.
- Access Control owns creation/synchronization of AWS users, groups, and memberships.
- OpenTofu owns the `AdministratorAccess` (or least-privilege) Permission Set and the AWS account assignment referencing the **AWS-side group ID**. Resolve the group by an audited, unique name or recorded ID; do not let OpenTofu create/update members.
- Once provisioned, removing a managed Google user from that Google Group revokes their inherited AWS account assignment through group membership. Preexisting AWS role sessions may remain valid until expiry or explicit revocation.
- **Future extension, not v1:** if centrally editing group-to-permission-set assignments is required, add a separate AWS `sso-admin` provider with audited IAM-role credentials and its own authorization review. Do not expand the SCIM token's responsibilities or introduce long-lived IAM keys as a shortcut.

## Delivery sequence

### Phase 0: unblock SSO, secrets and test environment
- Verify Google-to-AWS SAML initiation and userName/NameID compatibility independently from SCIM; record reproducible results for the reported login error.
- Enable AWS SCIM automatic provisioning but do not enable a second auto-provisioning writer.
- Prepare a protected admin/bootstrap account and a non-production test target.

### Phase 1: implement and test AWS SCIM directory provisioning
- Expand Directory user name contracts with Google given/family names.
- Add typed AWS SCIM transport/adapter, provider schema, source/target identity matching, and observation.
- Add versioned directory target plan/apply/verify records and appropriate D1 migrations.
- Implement user, group, membership create/update/revoke/suspend operations; no hard delete.
- Wire secrets, route contracts/API operations, deployment schemas and UI operational status.

### Phase 2: automatic reconciliation
- Add timed complete Google snapshots, D1 job lease, bounded Queue processing, configurable scoped targets, change thresholds, protected resources and alerting.
- Start in observe-only; verify no-op and safe add/revoke behavior; then enable automatic bounded reconciliation.

### Phase 3: AWS account authorization
- Attach the AWS-created groups to permission sets/account assignments in the existing cloud infrastructure OpenTofu repository.
- Test SAML login, account portal visibility, CLI SSO, and a user removed from Google Groups.
- Consider further AWS SSOAdmin automation only as a separately reviewed expansion.

## Acceptance criteria

- A new eligible Google user and direct AWS access-group membership result in one matching AWS user, group and membership without manual AWS user creation.
- Unchanged snapshots cause zero writes; Google email/group renames preserve AWS bindings by immutable IDs.
- Suspended users and ordinary revoked memberships lose access without deleting identities; unowned groups and last-admin protection block unsafe changes.
- Transient AWS 429/5xx retries converge; AWS 401/403 or incomplete Google snapshots do not cause mass changes; group memberships are read using supported SCIM filtered operations.
- Multiple cron invocations cannot race; a retry cannot duplicate account objects; operations are fully auditable.
- Google SAML NameID matches provisioned AWS username. AWS console and CLI SSO work with an explicitly assigned AWS-side group and Permission Set.
- No Okta, ssosync service, Lambda, new long-lived AWS IAM keys, or duplicate provisioning controller is required.
- `pnpm run check` and Worker integration tests pass after implementation. This design-only PR does **not** claim the feature is implemented.

## References

- [AWS: Provision users and groups by SCIM](https://docs.aws.amazon.com/singlesignon/latest/userguide/provision-automatically.html)
- [AWS: CreateUser](https://docs.aws.amazon.com/singlesignon/latest/developerguide/createuser.html)
- [AWS: ListGroups (members limitation)](https://docs.aws.amazon.com/singlesignon/latest/developerguide/listgroups.html)
- [AWS: PatchGroup](https://docs.aws.amazon.com/singlesignon/latest/developerguide/patchgroup.html)
- [AWS: SCIM token rotation](https://docs.aws.amazon.com/singlesignon/latest/userguide/rotate-token.html)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
