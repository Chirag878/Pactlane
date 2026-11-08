# Deployment

**Status: not deployed.** No Cloudflare, Supabase or Vercel resource has been created. Everything here is a runbook except where marked as locally verified on 2026-11-08 with Agent-Native 0.226.0.

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 22.22 or newer | Required by the framework |
| Cloudflare account on **Workers Paid** | See the CPU limits below |
| Supabase project | Connection strings from its Connect dialog |
| LLM provider key | Any supported provider, or configure one in the app |
| `openssl` or another secure generator | For secrets |

## Connection strategy

| Purpose | Connection | Variable |
| --- | --- | --- |
| Worker traffic | Transaction pooler, `aws-[INDEX]-[REGION].pooler.supabase.com:6543` | `DATABASE_URL` |
| Migrations | Session pooler, same host on port `5432`, or direct `db.[REF].supabase.co:5432` | `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, for that process only |

Why they differ: Supabase's shared transaction pooler does not support prepared statements and is meant for short-lived serverless connections. Schema changes need a session-capable connection.

- Direct connections are IPv6 unless the project has the IPv4 add-on. The shared pooler is IPv4 on all plans, so from an IPv4-only network use the session pooler.
- `DATABASE_URL_UNPOOLED` is not in the published docs. It comes from the installed package (`dist/app-config/runtime.js`, `getMigrationDatabaseUrl` in `dist/db/client.js`). Setting `DATABASE_URL` to the session URL too means the step does not depend on that detail.
- The framework passes `prepare: false` when the URL contains `supabase` (`dist/db/client.js`).

## Connection limits

The framework's default pool size is 2 per serverless foreground context and 4 for background work. `AGENT_NATIVE_DB_POOL_MAX` overrides it. Supavisor multiplexes these over a limited number of server connections, so total concurrency is bounded by the Supabase plan.

Each Worker invocation may also have only six connections simultaneously waiting for response headers, which limits parallel database queries in one request. Hyperdrive is not used: the framework's Cloudflare guide does not cover it, so adding it would be untested scope.

## Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Transaction pooler URL |
| `BETTER_AUTH_SECRET` | Yes | 32+ random characters. Changing it signs everyone out. The framework throws at startup in production if missing. |
| `A2A_SECRET` | Yes on Workers | Signs the scheduled sweep |
| `BETTER_AUTH_URL` | Optional | Only for a custom domain |
| LLM key, such as `ANTHROPIC_API_KEY` | For the agent | Or configure a provider in the app |

Never set `AUTH_DISABLED` in production. The `.env` file is not uploaded, so set everything through the host.

## Cloudflare Workers runbook

Commands use Bash. In PowerShell, set variables with `$env:NAME = "value"`.

```bash
# 1. Authenticate (interactive)
npx wrangler login

# 2. Migrate, from a trusted machine, with the SESSION or DIRECT URL
export DATABASE_URL="<session-or-direct-url>"
export DATABASE_URL_UNPOOLED="$DATABASE_URL"
pnpm migrate:production
unset DATABASE_URL DATABASE_URL_UNPOOLED

# 3. Build
NITRO_PRESET=cloudflare_module pnpm build

# 4. Set secrets, using the TRANSACTION POOLER URL for DATABASE_URL
npx wrangler secret put DATABASE_URL --config .output/server/wrangler.json
npx wrangler secret put BETTER_AUTH_SECRET --config .output/server/wrangler.json
npx wrangler secret put A2A_SECRET --config .output/server/wrangler.json

# 5. Deploy
npx wrangler deploy --config .output/server/wrangler.json
```

On updates: migrate, build, deploy. Secrets persist. Migrate before deploying so older running code still works, and keep migrations additive.

Authentication URLs: with a `workers.dev` address the framework infers its origin. Set `BETTER_AUTH_URL` only for a custom domain.

The Worker name comes from the Git remote. Locally it generated `chirag878-pactlane`.

### Post-deployment smoke tests

1. `GET /` returns 200 and the sign-in page.
2. An action without a session returns 401.
3. Sign up and reach `/home`.
4. Create a project through the UI once actions exist, and read it back after a reload.
5. Send one agent message and confirm a streamed response.
6. Run a long agent turn to check streaming and CPU limits.
7. Confirm the cron sweep runs after up to 15 minutes.

## Vercel fallback

```bash
npx vercel login
npx vercel link
printf '%s' "$DATABASE_URL" | npx vercel env add DATABASE_URL production
printf '%s' "$BETTER_AUTH_SECRET" | npx vercel env add BETTER_AUTH_SECRET production
pnpm migrate:production
NITRO_PRESET=vercel pnpm build
npx vercel deploy --prebuilt --prod
```

Run the migration step with the session or direct URL, as above. Set `CRON_SECRET` for the sweep. The Hobby plan allows one cron run per day, so set `AGENT_NATIVE_VERCEL_CRON_SCHEDULE` to a daily expression. Functions stop at their maximum duration, 300 seconds by default.

## Risk analysis

"Verified" means observed in this repository. Everything else comes from vendor documentation and has **not** been tested in a live Worker.

| Area | Finding | State |
| --- | --- | --- |
| Build | `cloudflare_module` build succeeds and generates `wrangler.json` with `nodejs_compat` and `nodejs_als` | Verified |
| Package | `wrangler deploy --dry-run` passes: 31,119 KiB upload, 9,141 KiB gzipped, 445 assets. Cloudflare lists a 64 MiB Worker limit. | Verified |
| Build warnings | The build prints `Could not bundle: ...` for several framework modules, labeled "may not be needed at runtime". Runtime impact is unknown. | Open |
| **Startup time** | Cloudflare allows 1 second of startup. A 31 MiB module graph is large, and local cold start took tens of seconds in development mode. This is the top deployment risk. | **Untested** |
| **Free plan CPU** | Free allows 10 ms per request. Paid defaults to 30 seconds, configurable to 5 minutes. Time waiting on the database or LLM does not count. | Workers Paid needed |
| Agent streaming | HTTP duration has no limit while the client stays connected, and streaming is allowed. If the client disconnects, `waitUntil` adds only 30 seconds. | Untested |
| Background and scheduled work | The build adds a `* * * * *` cron, which needs `A2A_SECRET`. Free plan cron gets 10 ms CPU, too little for agent sweeps. Cron wall time limit is 15 minutes. | Untested |
| Database through pooler | `prepare: false` is automatic for Supabase. Supabase warns Postgres.js pipelining can misbehave in transaction mode. Whether the framework's settings avoid this needs a live test. | **Untested** |
| Sessions | Better Auth needs a stable secret. Sign-in has not been tried on Workers. | Untested |
| Environment variables | Worker secrets must be set before deploy. The deploy command does not upload `.env`. | Per framework docs |
| Migrations | Not in request handling. The framework skips app migrations at boot on hosted functions and requires the release step. | Verified in source |
| File storage | Workers have no persistent files. Transcripts stay in SQL, so no blob store is needed for text. | By design |
| Memory | 128 MB per isolate. Very long transcripts need a size limit in `create-meeting`. | Planned |

If the Worker cannot start within limits, use the Vercel fallback instead of reshaping the framework.

## Hackathon note

The official rules require a working application and a public Clips demo. A live deployment and public repository are encouraged but not required. Under deadline pressure, record the demo against the local app before spending time on hosting.
