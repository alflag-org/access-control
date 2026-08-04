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

The named Wrangler environments target the existing Cloudflare resources:

| Environment  | Worker                   | D1 database              | R2 bucket                        | Queue                           |
| ------------ | ------------------------ | ------------------------ | -------------------------------- | ------------------------------- |
| `staging`    | `access-control-staging` | `access-control-staging` | `access-control-staging-exports` | `access-control-staging-outbox` |
| `production` | `access-control-prod`    | `access-control-prod`    | `access-control-prod-exports`    | `access-control-prod-outbox`    |

The staging and production Workers use separate D1, R2, and Queue resources. The repository stores logical resource names but does not store the Cloudflare account ID or D1 UUIDs. Deployment disables automatic resource creation so a missing or misspelled resource fails the build instead of creating a new one.

## Access configuration

Set these Worker variables for a deployed environment:

| Variable                   | Use                                                                             |
| -------------------------- | ------------------------------------------------------------------------------- |
| `ENVIRONMENT`              | `production`, `staging`, or `development`                                       |
| `ACCESS_TEAM_DOMAIN`       | Cloudflare Access team domain; managed on the deployed Worker                   |
| `ACCESS_AUD`               | Expected Cloudflare Access application audience; managed on the deployed Worker |
| `ALLOW_LOCAL_AUTH`         | `false` for deployed environments                                               |
| `LOCAL_BOOTSTRAP_IDENTITY` | Development-only fallback identity                                              |
| `PROVIDER_WRITES_ENABLED`  | `false` unless GitHub writes are explicitly enabled                             |

The Worker returns a configuration error when deployed Access settings are unset. Local authentication is rejected outside development and outside the loopback interface.

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are intentionally omitted from the repository configuration. The deploy command uses `--keep-vars`, so existing values on the selected Worker are preserved. If both values are supplied as Workers Builds variables, the deploy script passes them as runtime variables; this is useful when initializing a new Worker or rotating the Access application configuration. Supplying only one value is rejected.

## Secrets

Set secrets with Wrangler. A Google Directory Source uses the secret name in its `credentialRef`; the current Worker reads the GitHub App credential from the fixed binding name `GITHUB_CREDENTIAL`:

```sh
pnpm exec wrangler secret put GOOGLE_CREDENTIAL --config apps/worker/wrangler.jsonc --env staging
pnpm exec wrangler secret put GITHUB_CREDENTIAL --config apps/worker/wrangler.jsonc --env staging
pnpm exec wrangler secret put GOOGLE_CREDENTIAL --config apps/worker/wrangler.jsonc --env production
pnpm exec wrangler secret put GITHUB_CREDENTIAL --config apps/worker/wrangler.jsonc --env production
```

The Google Directory secret is a JSON service-account credential with `client_email`, `private_key`, and the Google OAuth token URI. The GitHub secret is a JSON GitHub App credential with `appId`, `installationId`, and `privateKey`. The values are read from Worker bindings at request time and are not stored in the configuration manifest.

## Resource and deployment checks

Authenticate Wrangler, validate the non-secret manifest, and validate the Worker bundle:

```sh
pnpm exec wrangler login
pnpm run config -- validate --file config/example.json
mise run deploy-dry-run
```

`mise run deploy-dry-run` validates both named environments with `wrangler deploy --dry-run`; it uploads no Worker version and reports the bundle and declared bindings.

## Workers Builds

Connect the same repository to both existing Workers in the Cloudflare Dashboard. Use `/` as the root directory and `pnpm run check` as the build command. Configure the deploy commands as follows:

| Worker                   | Production branch | Deploy command               |
| ------------------------ | ----------------- | ---------------------------- |
| `access-control-staging` | `staging`         | `pnpm run deploy:staging`    |
| `access-control-prod`    | `master`          | `pnpm run deploy:production` |

Keep non-production branch builds disabled on these persistent environment Workers. They are separate from the `staging` branch deployment and would otherwise create preview versions without providing another data environment.

Build variables are optional for an existing Worker because its Access values are preserved by `--keep-vars`. Set both values on a trigger when initializing a new Worker or rotating its Access configuration:

- `ACCESS_TEAM_DOMAIN`: the Cloudflare Access team domain.
- `ACCESS_AUD`: the Access application audience for that Worker; mark it as a build secret.
- `NODE_VERSION=24.18.1` and `PNPM_VERSION=11.20.0`.

The Cloudflare Dashboard Worker name must match the `name` in the selected Wrangler environment. Do not connect Workers Builds until the existing Worker names and bindings have been verified.

Cloudflare documents this multi-Worker and Wrangler environment setup in [Advanced setups](https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/) and the [Workers Builds configuration reference](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## Publish and migrate

```sh
mise run deploy
```

`mise run deploy` runs the production deployment. Staging can be deployed with `mise run deploy:staging`. Both commands publish the selected Worker with the matching Wrangler environment, disable automatic resource creation, preserve existing dashboard variables, optionally apply Access values from the build environment, and then apply the matching remote migrations with:

```sh
pnpm run db:migrate:staging
pnpm run db:migrate:production
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

Staging and production require an HTTPS `--issuer` value:

```sh
pnpm run bootstrap:admin -- \
  --environment staging \
  --database DB \
  --identity access:your-access-subject \
  --issuer https://your-team.cloudflareaccess.com \
  --display-name "Administrator" \
  --organization-name "Example Organization"
```

```sh
pnpm run bootstrap:admin -- \
  --environment production \
  --database DB \
  --identity access:your-access-subject \
  --issuer https://your-team.cloudflareaccess.com \
  --display-name "Administrator" \
  --organization-name "Example Organization"
```

The `--identity` value uses the canonical `access:<subject>` format. The issuer must match the issuer in the Cloudflare Access JWT used by the selected Worker.
