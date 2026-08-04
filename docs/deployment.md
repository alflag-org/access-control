# Deployment

## Deployment files

The Worker deployment is configured in `apps/worker/wrangler.jsonc`. The repository also contains the deployment tasks in `mise.toml` and the D1 migrations in `migrations/`.

The current base configuration has:

- Worker name `access-control` and entrypoint `apps/worker/src/index.ts`.
- Compatibility date `2026-07-30` and `nodejs_compat`.
- `workers_dev: true` and `preview_urls: false`.
- D1 binding `DB` with migration directory `migrations`.
- R2 binding `EXPORTS_BUCKET`.
- Queue producer and consumer binding `OUTBOX_QUEUE` for `access-control-outbox`.
- Queue batches of up to 10 messages, a 10-second maximum batch timeout, three retries, and dead-letter queue `access-control-dead-letter`.
- Cron trigger `0 */6 * * *`.

Account-specific resource identifiers are not stored in the repository. Configure or provision the bindings declared by the Wrangler configuration in the target Cloudflare account before using the deployed Worker.

## Access configuration

Set these Worker variables for a deployed environment:

| Variable                   | Use                                                  |
| -------------------------- | ---------------------------------------------------- |
| `ENVIRONMENT`              | `production`, `staging`, or `development`            |
| `ACCESS_TEAM_DOMAIN`       | Cloudflare Access team domain used as the JWT issuer |
| `ACCESS_AUD`               | Expected Cloudflare Access application audience      |
| `ALLOW_LOCAL_AUTH`         | `false` for deployed environments                    |
| `LOCAL_BOOTSTRAP_IDENTITY` | Development-only fallback identity                   |
| `PROVIDER_WRITES_ENABLED`  | `false` unless GitHub writes are explicitly enabled  |

The Worker returns a configuration error when deployed Access settings are unset. Local authentication is rejected outside development and outside the loopback interface.

## Secrets

Set secrets with Wrangler. A Google Directory Source uses the secret name in its `credentialRef`; the current Worker reads the GitHub App credential from the fixed binding name `GITHUB_CREDENTIAL`:

```sh
pnpm exec wrangler secret put GOOGLE_CREDENTIAL --config apps/worker/wrangler.jsonc
pnpm exec wrangler secret put GITHUB_CREDENTIAL --config apps/worker/wrangler.jsonc
```

The Google Directory secret is a JSON service-account credential with `client_email`, `private_key`, and the Google OAuth token URI. The GitHub secret is a JSON GitHub App credential with `appId`, `installationId`, and `privateKey`. The values are read from Worker bindings at request time and are not stored in the configuration manifest.

## Resource and deployment checks

Authenticate Wrangler, validate the non-secret manifest, and validate the Worker bundle:

```sh
pnpm exec wrangler login
pnpm run config -- validate --file config/example.json
mise run deploy-dry-run
```

`mise run deploy-dry-run` runs `wrangler deploy --dry-run`; it uploads no Worker version and reports the bundle and declared bindings.

## Publish and migrate

```sh
mise run deploy
```

`mise run deploy` runs the repository's `pnpm deploy` script. That script publishes the Worker with `wrangler deploy` and then applies the remote migrations with:

```sh
pnpm run db:migrate:remote
```

The migration directory is ordered by filename. Apply the same directory to a local database with `pnpm run db:migrate:local`.

## First administrator

The first administrator is created by `scripts/bootstrap-admin.ts`. The command refuses to create another active administrator when one already exists.

Development:

```sh
pnpm run bootstrap:admin -- \
  --environment development \
  --database DB \
  --identity access:local-admin \
  --display-name "Local Administrator" \
  --organization-name "Example Organization"
```

Production requires an HTTPS `--issuer` value:

```sh
pnpm run bootstrap:admin -- \
  --environment production \
  --database DB \
  --identity access:your-access-subject \
  --issuer https://your-team.cloudflareaccess.com \
  --display-name "Administrator" \
  --organization-name "Example Organization"
```

The `--identity` value uses the canonical `access:<subject>` format. The production issuer must match the issuer in the Cloudflare Access JWT used by the Worker.
