# Whitelabel GEO delivery platform

Agencies resell AI-visibility services under their own brand. This repository
is built milestone by milestone from the PRD.

## What is built

**Milestone 2, Foundations** (complete):

- Agency signup; each agency gets `<slug>.<PLATFORM_DOMAIN>`
- Four roles: super admin, agency owner, agency member, client viewer
- Tenant isolation enforced in Postgres with row-level security
- Branding per agency: name, logo, favicon, two colours, email sender name
- Custom domain by CNAME, with verification and a certificate-check endpoint
- Team invites (single-use links, 7 days) and client-viewer logins
- Clients, with the plan's active-client limit
- Super admin: list agencies, change plan, suspend and reactivate

**Milestone 1, Cost spike**: the script is in `spike/`. It has to be run with
your own API keys; see [Cost spike](#cost-spike).

Not built yet: tracker, prospect audit, diagnosis, action queue, proof,
reports, credits. Email sending and file uploads arrive with the milestones
that need them, so for now invite links are copied by hand and logos are
given as https URLs.

## Layout

```
apps/api    Fastify + TypeScript API. SQL migrations in apps/api/migrations.
apps/web    Next.js app, themed per hostname. Proxies /api/* to the API.
spike/      Cost spike script (no dependencies).
infra/      Example reverse-proxy config for custom domains.
```

## Run it locally

Needs Node 22.9+ and Postgres 16 (the version tested) (`docker compose up -d` starts one).

```bash
cp .env.example .env          # then set SESSION_SECRET and INTERNAL_PROXY_SECRET
npm install
npm run migrate               # creates tables, policies and the geo_app login
npm run seed:admin            # optional: set SUPER_ADMIN_* in .env first
npm run dev:api               # terminal 1, port 4000
npm run dev:web               # terminal 2, port 3000
```

- Platform address: http://localhost:3000 (signup, super admin sign-in)
- An agency's workspace: http://your-agency.localhost:3000

Browsers resolve `*.localhost` to your machine, so no DNS setup is needed.

If you are not using `docker compose`, create the owner role and database
first:

```sql
CREATE ROLE geo_owner LOGIN PASSWORD 'geo_owner' CREATEROLE;
CREATE DATABASE geo_dev OWNER geo_owner;
CREATE DATABASE geo_test OWNER geo_owner;   -- for npm test
```

## Tests

```bash
npm test          # 19 integration tests against the geo_test database
npm run typecheck
npm run build
```

The tests wipe and rebuild `geo_test` on every run. They cover the
Foundations exit check: two agencies on different hostnames see only their own
clients, at the API and directly at the database.

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
   resolution, invite acceptance and super admin use the owner role
   (`ownerPool` / `withSystem`). Keep that list short.

When you add a tenant table: add `agency_id`, enable row-level security, add
policies in the same migration, and add a case to the isolation test.

## Deploying

- Run the API on a private address. It trusts the forwarded hostname only from
  callers that send `INTERNAL_PROXY_SECRET`; the web app sends it.
- Put a reverse proxy in front of the web app that preserves the `Host`
  header and issues certificates on demand. `infra/Caddyfile.example` shows
  this with Caddy, using `GET /internal/domain-check` so certificates are only
  issued for known workspaces.
- Point `*.PLATFORM_DOMAIN` and `CNAME_TARGET` at that proxy.
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
`spike/results/`. The report logic is tested against a mock; the three
provider calls have not been run against the live APIs, so expect to adjust a
field name if a provider has changed its response format.
