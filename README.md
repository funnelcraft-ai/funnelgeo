# FunnelGeo

A whitelabel GEO delivery platform by Funnelcraft. Agencies resell
AI-visibility services under their own brand. Built milestone by milestone
from the PRD.

## What is built

**Milestone 2, Foundations** (complete):

- Agency signup; each agency gets `<slug>.<PLATFORM_DOMAIN>`
- Four roles: super admin, agency owner, agency member, client viewer
- Tenant isolation enforced in Postgres with row-level security
- Branding per agency: name, uploaded logo and tab icon, two colours, email
  sender name
- Custom domain by CNAME, with verification and a certificate-check endpoint
- Team invites sent by email (single-use links, 7 days) and client-viewer logins
- Password reset by email; a reset signs the user out everywhere else
- Clients, with the plan's active-client limit
- Super admin: list agencies, change plan, suspend and reactivate

**Milestone 3, Tracker** (complete, tested against stand-in engines):

- Prompts per client (bulk add, priority, type, pause, plan limit) and up to
  five competitors, each with other names and a website
- Runs: every active prompt, on every available engine, the plan's number of
  times; started by hand or on a weekly schedule
- Engine adapters for ChatGPT, Perplexity and Gemini, a queue per engine with
  its own rate limit, retries with backoff, and a worker process
- Each answer is stored in full with its sources; mentions, position and
  citations are derived from it and can be rebuilt ("Re-read answers")
- Visibility screens: counts with sample sizes by engine, share of voice,
  prompt by prompt with the stored answers, most cited sources, run by run
- Credits: the cost of a run is reserved before it starts and failed calls are
  refunded; the ledger is append-only

Not in this milestone, though the PRD lists them under the tracker:

- **Sentiment and indirect references.** Mentions are matched by name, other
  names and website only. Both of these need a language-model pass.
- **Google AI Overviews**, and sending a prompt's country to the engines.
- **Screens for credit settings.** Engine costs, plan allowances and grants are
  set through the super admin API (see `src/routes/admin.ts`).

The weekly schedule is off until someone turns it on for a client, so a new
client never spends credits unasked. The PRD said weekly by default.

**Milestone 4, Prospect audit and lead widget** (complete, tested against
stand-in engines and stand-in websites):

- New audit: business, website, what it does and where; ten suggested buyer
  questions to edit, and competitors suggested by an answer engine
- Each audit asks every question once on each engine and checks the website
  for AI readiness (nine checks, below); it uses one of the plan's monthly
  audits plus credits
- Report: how often the business is named, by engine and against competitors;
  questions where only competitors are named; third-party sites the engines
  cite where the business is missing; the first five fixes, in a fixed order
- Share link on the agency's own address, read-only and replaceable; PDF via
  the browser's print dialog ("Save as PDF"), with a print layout
- Prospects stay out of the client list and the client limit until converted;
  converting keeps the questions, competitors and results
- Website form: one line of code on the agency's site. Each request becomes a
  lead and an audit; the visitor gets the report by email and the agency's
  owners get a lead email. Off by default; rate limited; a hidden field
  catches bots; repeats within a day are ignored; when audits or credits run
  out the lead is still saved and both sides are told
- A report button (text and link) on every shared report, set in Settings

The nine site checks: the site loads; HTTPS; robots.txt lets AI crawlers in
(blocking OAI-SearchBot, PerplexityBot, Claude-SearchBot or Google-Extended
fails, blocking training-only crawlers is a warning); readable without
JavaScript; schema.org structured data; question-and-answer content; page
title and description; sitemap; llms.txt (lowest weight). Up to 10 pages are
read per site.

Not in this milestone: a server-generated PDF file (the browser makes it),
sentiment, and sending the website form's emails from the agency's own domain.

**Platform API keys** (super admin): one screen for the engine keys and
models and the email server, with a Test button for each. See
[API keys screen](#api-keys-screen).

**Milestone 1, Cost spike**: the script is in `spike/`. It has to be run with
your own API keys; see [Cost spike](#cost-spike).

Not built yet: diagnosis for clients, action queue, proof, reports.

## Layout

```
apps/api    Fastify + TypeScript API. SQL migrations in apps/api/migrations.
apps/web    Next.js app, themed per hostname. Proxies /api/* to the API.
spike/      Cost spike script (no dependencies).
infra/      Example reverse-proxy config for custom domains.
```

## Run it locally

Needs Node 22.9+, Postgres 16 and Redis 7 (the versions tested;
`docker compose up -d` starts both).

```bash
cp .env.example .env          # then set SESSION_SECRET and INTERNAL_PROXY_SECRET
npm install
npm run migrate               # creates tables, policies and the geo_app login
npm run seed:admin            # optional: set SUPER_ADMIN_* in .env first
npm run dev:api               # terminal 1, port 4000
npm run dev:web               # terminal 2, port 3000
npm run dev:worker            # terminal 3: makes engine calls, runs schedules
```

- Platform address: http://localhost:3000 (signup, super admin sign-in)
- An agency's workspace: http://your-agency.localhost:3000

Browsers resolve `*.localhost` to your machine, so no DNS setup is needed.
With `SMTP_URL` empty, invite and reset emails are printed in the API
terminal instead of being sent.

If you are not using `docker compose`, create the owner role and databases
first:

```sql
CREATE ROLE geo_owner LOGIN PASSWORD 'geo_owner' CREATEROLE;
CREATE DATABASE geo_dev OWNER geo_owner;
CREATE DATABASE geo_test OWNER geo_owner;   -- for npm test
```

## Tests

```bash
npm test          # 71 integration tests; needs Postgres (geo_test) and Redis
npm run typecheck
npm run build
```

The tests wipe and rebuild `geo_test` on every run. They cover tenant
isolation at the API and directly at the database, roles, whitelabel, plan
limits, suspension, emails, password reset, uploads, the tracker (a 25-prompt
run end to end, parsing, retries, refunds, schedules, credits) and audits (the
site check, address safety, reports, share links, conversion, the website
form and its emails, limits).

## How tenant isolation works

1. **Hostname decides the tenant.** The API maps the hostname to the platform,
   one agency, or nothing (`src/tenant.ts`). A custom domain maps to an agency
   only after its CNAME is verified.
2. **Sessions are bound to a hostname.** The cookie is host-only and the token
   carries the agency id; a session from one workspace is rejected on any
   other, and super admin sessions work only on the platform address.
3. **The database enforces it again.** Tenant requests use the `geo_app` role
   inside a transaction that sets `app.agency_id` (`withTenant` in
   `src/db.ts`). Row-level security policies filter every table on it, so a
   query that forgets a `WHERE agency_id = ...` still cannot cross tenants.
   Client viewers also set `app.client_id`, which narrows them to one client.
4. **Cross-tenant work is explicit.** Signup, login lookup, hostname
   resolution, invite acceptance, password reset and super admin use the owner
   role (`ownerPool` / `withSystem`). Keep that list short.

When you add a tenant table: add `agency_id`, enable row-level security, add
policies in the same migration, and add a case to the isolation test.

## API keys screen

The super admin enters engine keys and models, the SMTP connection and the
send-from address at **/admin/settings** on the platform's own address (nav:
"API keys"). Each engine and the email server has a Test button that makes one
real call (a short question, or an email to the super admin's own address).

- Secrets are encrypted in the application with AES-256-GCM before they reach
  the database, using `SETTINGS_ENCRYPTION_KEY` (32 bytes, base64:
  `openssl rand -base64 32`). The setting's name is bound into each value, so a
  value can't be moved to another setting's row. Without that key the screen
  says so and refuses to save secrets.
- Keep the encryption key out of database backups and keep a copy safe. If it
  is lost or changed, saved secrets show as "can't be read" and must be
  entered again.
- A key is never sent back to the browser, only its last four characters.
- Only the owner database role can touch `platform_settings`; the tenant role
  (`geo_app`) has no privileges on it.
- A saved value wins over the environment variable of the same name; removing
  it falls back to the environment. The API and every worker re-read settings
  every 15 seconds, so changes need no restart.

## Answer engines

Set `ENGINE_MODE=live` and, for each engine you want, its API key and model,
on the API keys screen or as `OPENAI_*`, `PERPLEXITY_*`, `GEMINI_*` in the
environment. An engine with either missing is simply not used. The three request formats were checked against the
providers' documentation on 16 Nov 2026 but have not been run against the live
services; run `spike/cost-spike.mjs` with your keys first, since it uses the
same formats.

`ENGINE_MODE=mock` answers every call with generated stand-in text so the
whole product can be tried without keys. Runs made this way are labelled
"demo data" everywhere, and the API refuses to start in this mode when
`NODE_ENV=production`. Brand names are never sent to a live engine: it sees
the prompt and nothing else.

## Credits

One credit per engine call by default (`engines.credit_cost`). A plan's
`monthly_credits` is the allowance for a calendar month (UTC); the balance is
that allowance plus the month's ledger entries. The current allowances are
provisional: enough for every client on the plan to run weekly. Set real
values after the cost spike:

```
PATCH /v1/admin/engines/:key      { "creditCost": 2 }
PATCH /v1/admin/plans/:key        { "monthlyCredits": 8000 }
POST  /v1/admin/agencies/:id/credits { "amount": 1000, "note": "..." }
```

## Website checks and safety

The site check fetches whatever website a member of the public types into the
website form, so `src/audits/fetch.ts` refuses anything that is not on the
public internet: every connection, including each redirect, is checked after
DNS resolution, so a name pointing at 127.0.0.1, 10.x, 169.254.169.254 (cloud
metadata) and similar is refused. Only ports 80 and 443, at most 3 redirects,
10 seconds and 1.5 MB per page. The user agent is a neutral
`AI-Readiness-Check/1.0`, so prospects' logs do not name the platform.

`SITE_FETCH=mock` checks a made-up website instead, for development without
internet access; reports made that way are labelled demo data, and the API
refuses to start with it in production.

Every page refuses to be shown inside another site's frame, except the
website form under `/embed/`. Shared reports send no referrer (their links go
to other sites) and ask search engines not to index them.

## Whitelabel rules

- The platform name and the Funnelcraft logo appear only on the platform's own
  address (landing, signup, super admin).
- On an agency's address everything is the agency's: tab title and icon, logo,
  colours, and the sender name, logo and button colour of every email. The
  embed code for the website form names only the agency's address.
- The design system (`apps/web/app/globals.css`) takes two colours from the
  agency, `--primary` and `--accent`; every other colour is neutral.

## Email

Any SMTP provider works; set the SMTP connection and send-from address on the
API keys screen, or `SMTP_URL` and `MAIL_FROM` in the environment. All emails are sent
from the one `MAIL_FROM` address with the agency's name as the display name,
so set up SPF and DKIM for that address's domain with your provider. Sending
from each agency's own domain is not built yet.

## Uploads

Logos and tab icons are stored on disk in `UPLOAD_DIR` (PNG, JPEG or WebP, up
to 1 MB; the type is checked from the file's bytes, and SVG is refused because
it can carry scripts). Keep that directory on persistent disk and back it up.
If the API ever runs on more than one machine, move this to shared object
storage first; `src/routes/files.ts` is the only file that touches the disk.

## Deploying

- Run three processes: the API (`npm start -w @geo/api`), at least one worker
  (`npm run start:worker -w @geo/api`) and the web app, plus Postgres and Redis.
- Run the API on a private address. It trusts the forwarded hostname only from
  callers that send `INTERNAL_PROXY_SECRET`; the web app sends it.
- Put a reverse proxy in front of the web app that preserves the `Host`
  header and issues certificates on demand. `infra/Caddyfile.example` shows
  this with Caddy, using `GET /internal/domain-check` so certificates are only
  issued for known workspaces. **That file has not been run**; test it on the
  server before pointing real domains at it.
- Point `*.PLATFORM_DOMAIN` and `CNAME_TARGET` at that proxy.
- Set `SETTINGS_ENCRYPTION_KEY` on the API and the workers (the same value on
  every process), before entering any keys on the API keys screen.
- Set `NODE_ENV=production` (secure cookies), `PUBLIC_SCHEME=https` and an
  empty `PUBLIC_PORT`.
- In production the owner role should not be a superuser, and `geo_app` must
  never be one (superusers bypass row-level security).
- Shared hosting cannot run this; use a VPS or a container platform.

## Cost spike

Measures what one engine call costs before plan prices are set.

```bash
cp spike/.env.example spike/.env            # add keys, models and prices
cp spike/prompts.example.json spike/prompts.json
node --env-file=spike/.env spike/cost-spike.mjs --prompts 25 --samples 3
```

It prints success rate, latency, tokens, share of answers with citations and
cost per client per month for each engine, and writes per-call rows to
`spike/results/`. The request and response formats were checked against each
provider's documentation on 16 Nov 2026 and the report logic is tested against
a mock, but the script has not been run against the live APIs.
