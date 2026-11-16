-- Milestone 2: Foundations
-- Tenancy (plans, agencies, users, invites) and clients, with row-level security.
--
-- Two database roles are used:
--   * the owner role runs migrations and the few cross-tenant system operations;
--   * geo_app serves every tenant request and is subject to the policies below.
-- Each tenant request runs in a transaction that sets app.agency_id (and
-- app.client_id for client viewers). With neither set, geo_app sees no rows.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geo_app') THEN
    CREATE ROLE geo_app NOLOGIN;
  END IF;
END $$;

CREATE FUNCTION app_agency_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.agency_id', true), '')::uuid $$;

CREATE FUNCTION app_client_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.client_id', true), '')::uuid $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Plans ---------------------------------------------------------------------

CREATE TABLE plans (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                text NOT NULL UNIQUE,
  name               text NOT NULL,
  monthly_credits    integer NOT NULL CHECK (monthly_credits >= 0),
  client_limit       integer NOT NULL CHECK (client_limit > 0),
  samples_per_prompt integer NOT NULL CHECK (samples_per_prompt BETWEEN 1 AND 10),
  prompts_per_client integer NOT NULL CHECK (prompts_per_client > 0),
  audits_per_month   integer NOT NULL CHECK (audits_per_month >= 0),
  price_cents        integer,          -- open decision: set after the cost spike
  currency           text,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Limits follow the PRD's proposed plan shape. Credits and prices are
-- placeholders until the cost spike has been run.
INSERT INTO plans (key, name, monthly_credits, client_limit, samples_per_prompt, prompts_per_client, audits_per_month) VALUES
  ('starter', 'Starter', 0,  5, 3, 25,  10),
  ('growth',  'Growth',  0, 15, 3, 40,  30),
  ('scale',   'Scale',   0, 40, 5, 50, 100);

-- Agencies ------------------------------------------------------------------

CREATE TABLE agencies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  custom_domain     text UNIQUE CHECK (custom_domain = lower(custom_domain)),
  domain_status     text NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending', 'verified', 'failed')),
  domain_checked_at timestamptz,
  branding          jsonb NOT NULL DEFAULT '{}'::jsonb,
  plan_id           uuid NOT NULL REFERENCES plans (id),
  billing_currency  text NOT NULL DEFAULT 'USD',
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((custom_domain IS NULL) = (domain_status = 'none'))
);

CREATE TRIGGER agencies_touch BEFORE UPDATE ON agencies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Clients -------------------------------------------------------------------

CREATE TABLE clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  domain        text,
  brand_aliases text[] NOT NULL DEFAULT '{}',
  vertical      text,
  language      text NOT NULL DEFAULT 'en',
  country       text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('prospect', 'active', 'paused')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, agency_id)
);

CREATE INDEX clients_agency_idx ON clients (agency_id, created_at DESC);

CREATE TRIGGER clients_touch BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Users ---------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid REFERENCES agencies (id) ON DELETE CASCADE,
  client_id     uuid,
  email         text NOT NULL CHECK (email = lower(email)),
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('super_admin', 'agency_owner', 'agency_member', 'client_viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  -- Super admins belong to the platform, everyone else to exactly one agency.
  CHECK ((role = 'super_admin') = (agency_id IS NULL)),
  -- Client viewers are tied to exactly one client; nobody else is.
  CHECK ((role = 'client_viewer') = (client_id IS NOT NULL)),
  -- A viewer's client must belong to the viewer's own agency.
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);

-- The same email may exist in two agencies, but only once per agency
-- (and once among super admins).
CREATE UNIQUE INDEX users_agency_email_key
  ON users (coalesce(agency_id, '00000000-0000-0000-0000-000000000000'::uuid), email);

-- Invites -------------------------------------------------------------------

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  email       text NOT NULL CHECK (email = lower(email)),
  role        text NOT NULL CHECK (role IN ('agency_member', 'client_viewer')),
  client_id   uuid,
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'client_viewer') = (client_id IS NOT NULL)),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);

CREATE INDEX invites_agency_idx ON invites (agency_id, created_at DESC);

-- Privileges for the app role -------------------------------------------------

GRANT USAGE ON SCHEMA public TO geo_app;
GRANT SELECT ON plans TO geo_app;
GRANT SELECT ON agencies TO geo_app;
-- Plan, status and slug are changed only by the platform, never by a tenant.
GRANT UPDATE (name, branding, custom_domain, domain_status, domain_checked_at) ON agencies TO geo_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON clients, users, invites TO geo_app;

-- Row-level security ----------------------------------------------------------

ALTER TABLE agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites  ENABLE ROW LEVEL SECURITY;

-- Agencies: a tenant reads its own row; only non-viewers may change it.
CREATE POLICY agencies_select ON agencies FOR SELECT TO geo_app
  USING (id = app_agency_id());
CREATE POLICY agencies_update ON agencies FOR UPDATE TO geo_app
  USING (id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (id = app_agency_id());

-- Clients: agency users see all of the agency's clients; a client viewer sees
-- only their own client and can change nothing.
CREATE POLICY clients_select ON clients FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND (app_client_id() IS NULL OR id = app_client_id()));
CREATE POLICY clients_insert ON clients FOR INSERT TO geo_app
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL);
CREATE POLICY clients_update ON clients FOR UPDATE TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (agency_id = app_agency_id());
CREATE POLICY clients_delete ON clients FOR DELETE TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL);

-- Users: same shape. A viewer can read only users tied to their own client.
CREATE POLICY users_select ON users FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND (app_client_id() IS NULL OR client_id = app_client_id()));
CREATE POLICY users_insert ON users FOR INSERT TO geo_app
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL);
CREATE POLICY users_update ON users FOR UPDATE TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (agency_id = app_agency_id());
CREATE POLICY users_delete ON users FOR DELETE TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL);

-- Invites: agency users only.
CREATE POLICY invites_all ON invites FOR ALL TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL);
