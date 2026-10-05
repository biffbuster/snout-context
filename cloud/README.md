# snout-cloud

Hosted dashboard for [Snout](https://github.com/biffbuster/snout-context). Users sign in with
GitHub, connect machines with `snout login`, and see token savings across projects, coding
agents and teammates.

Lives in `cloud/` of the Snout repo, next to the CLI whose `snout login` and `snout sync`
it serves. It is its own package: run everything below from this folder.

## What it stores

Only what `snout sync` sends: per day, project, coding agent and file label, the number of
reads and the tokens that reached context or were held back. Projects are identified by a
hash of their git remote plus the folder name. No file contents, paths or reasons, ever.
`snout sync --dry-run` prints the exact payload.

## Run locally

```
npm install
npm run dev            # http://localhost:8787, PGlite in memory, "Dev sign-in" button
npx usesnout login --url http://localhost:8787
```

`npm test` runs the whole flow (sign-in, device login, ingest, teams, invites, revocation)
against PGlite, the same SQL as production.

## Deploy on Railway

1. railway.com → New Project → Deploy from GitHub repo → snout-context. In the service's
   Settings, set **Root Directory** to `/cloud` and **Watch Paths** to `/cloud/**` (so CLI-only
   commits don't redeploy). `railway.json` builds the Dockerfile and health-checks `/healthz`.
2. In the project: New → Database → PostgreSQL. On the app service, add a variable
   `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway's reference syntax).
3. App service → Settings → Networking → Generate Domain. `PUBLIC_URL` defaults to it.
4. GitHub → Settings → Developer settings → OAuth Apps → New: homepage = the domain,
   callback = `https://<domain>/auth/github/callback`.
5. Variables on the app service: `NODE_ENV=production`, `SESSION_SECRET` (run
   `openssl rand -base64 48`), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.
6. Open `https://<domain>/healthz` → `{"ok":true,"engine":"postgres"}`.

The Hobby plan (about $5/month with usage included) covers the app and the database at launch.
Any other Docker host works the same way; set `PUBLIC_URL` yourself there.

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Unset = PGlite (dev only). |
| `PUBLIC_URL` | The public origin, e.g. `https://cloud.example.com`. Used for OAuth and CSRF checks. |
| `SESSION_SECRET` | 32+ random bytes. Required when `NODE_ENV=production`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | A GitHub OAuth app with callback `PUBLIC_URL/auth/github/callback`. |
| `PORT` | Default 8787. |
| `STRIPE_SECRET_KEY` | Enables billing: "Upgrade" opens Stripe Checkout (seats, monthly or yearly by the price lookup keys `snout_team_monthly` / `snout_team_yearly`), "Manage billing" opens the Stripe portal. Use a sandbox `sk_test_` key until launch. |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_` signing secret of the webhook at `PUBLIC_URL/api/stripe/webhook` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`). Events without a valid, fresh signature are refused. |
| `UPGRADE_URL` | Where "Upgrade to Team" goes: a Stripe payment link now, Checkout later. |
| `EARLY_ACCESS` | `1` starts new teams on the Team plan (no caps) until billing is live. |
| `BETA` | `1` = private beta: after GitHub sign-in, people need a personal access code, a team invite, or a place on the allowlist. |
| `ADMIN_LOGINS` | Comma-separated GitHub usernames that can create beta codes in the dashboard (and are always let in). |
| `BETA_ALLOW` | Optional. Comma-separated GitHub usernames let in without a code. |
| `DEV_LOGIN` | `1` enables the password-less dev sign-in. Refused in production. |

The CLI's default address is `DEFAULT_CLOUD_URL` in `../src/cloud/client.ts`.

## Plans

The local tool is free and unlimited. These caps apply to the hosted dashboard only:

| | Free | Team |
| --- | --- | --- |
| People per workspace | 1 | unlimited |
| Projects syncing | 3 | unlimited |
| History shown | 7 days | 1 year |

A paid team holds as many people as the seats it bought; the owner adds seats in the Stripe
portal. Owners can remove members (which revokes their CLI logins for that team), change roles,
and leave once another owner exists. A fourth project's sync is refused with a 402 that names the cap and the upgrade link; the CLI
prints it and keeps working locally. Free history is capped in what is shown, not what is kept,
so upgrading reveals everything. Upgrading sets `teams.plan = 'team'` (the Stripe webhook's job).

## Cloud agents and metering

Agents that run in the cloud (CI, Claude Code on the web, Codex cloud) can't log in through a
browser. A team owner creates a **workspace key** in the dashboard (Cloud agents) and sets it as
`SNOUT_TOKEN` in the agent's environment; `snout sync` then works with no login. Each key reports
as its own row (`agent:<name>`), so laptops and agents are split on the dashboard.

A run is one agent session, counted once however often it syncs (the CLI sends a hash of the
session id). Free: 1 key, 100 runs a day. Team: unlimited keys, 5,000 runs a month included,
then $5 per 10,000, billed through Stripe's meter (`snout_agent_run`, price lookup key
`snout_agent_runs`, graduated tiers). Each new run on a paid team sends one meter event with an
idempotent identifier, so a retried sync never bills twice; billing errors never block a sync.

## Private beta

With `BETA=1`, admins create codes in the dashboard (Beta access codes), one per person, each
with a note. A code is 8 random characters (40 bits, about a trillion combinations), works once, expires in 30 days, and is
stored only as a hash; the list shows its last four characters and who redeemed it. Redeeming is
limited to 5 tries per 10 minutes per user. Accepting a team invite from an approved member also
lets a person in. Every address is capped at 600 requests a minute across the app; a volumetric
flood needs a CDN (Cloudflare) in front of a custom domain, which app code can't replace.

## Security notes

- Sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies; cookie-authenticated writes also
  require a same-origin `Origin` header.
- CLI tokens and invite links are stored as SHA-256 hashes; a token is shown once, to the CLI.
- Device codes expire in 10 minutes and yield one token.
- Ingest is rate-limited per token, bounded to 2,000 day-rows, and strictly validated.
  A resync replaces a day rather than adding to it.
- Pages ship a strict CSP and deny framing.

## Not built yet

Billing (Team is free during early access), removing members, per-model breakdown (the CLI
does not record the model yet), and email digests.
