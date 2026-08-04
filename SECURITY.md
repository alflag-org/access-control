# Security policy

## Authentication and authorization

Deployed requests use the `Cf-Access-Jwt-Assertion` header from Cloudflare Access. The Worker verifies the JWT issuer, audience, time claims, signing key, and signature before resolving the external identity to a Subject.

Production and staging reject local authentication. Local authentication is accepted only when `ENVIRONMENT=development`, `ALLOW_LOCAL_AUTH=true`, and the request hostname is `localhost`, `127.0.0.1`, or `[::1]`.

The Worker maps an authenticated principal to an active Subject and its active administration role grants. The administration roles are `admin`, `operator`, and `auditor`. Mutating browser requests from another origin are rejected.

## Secret handling

Store provider credentials in Worker secret bindings. Configuration manifests store only uppercase runtime binding names in `credentialRef` fields. The manifest validator rejects credential-like fields and private-key material.

The current Worker reads Google Directory credentials through the binding named by a Directory Source and reads the GitHub App credential from `GITHUB_CREDENTIAL`. Logs, exports, examples, tests, migrations, and audit payloads must not contain secret values or real organization data.

Keep local secrets in an uncommitted `.dev.vars` file. Do not commit `.dev.vars`, provider responses, Cloudflare Access assertions, or account-specific identifiers.

## Provider writes

`PROVIDER_WRITES_ENABLED` is `false` in the Worker configuration. GitHub writes require that setting to be `true`, a current persisted plan, a running explicit operation, and live precondition checks. Protected changes are rejected by the operation executor. Proxmox, Zabbix, and POSIX apply methods reject production writes in the current adapter implementations.

Test provider write paths only against systems that you own or are authorized to test.

## Vulnerability reports

Report vulnerabilities privately through the repository's Security tab. Include the affected commit, deployment assumptions, reproduction steps using fictional data, impact, and proposed mitigation. Do not open a public issue containing exploit details, credentials, personal data, or deployment identifiers.
