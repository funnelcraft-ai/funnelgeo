-- Milestone 4: Prospect audits and the lead widget
--
-- A prospect is a client row with status 'prospect'. Its prompts, competitors
-- and runs are ordinary tracker rows, so converting it to a client keeps all
-- of them. Prospects do not count toward the plan's client limit.

-- Clients: what the business does and where -------------------------------------
ALTER TABLE clients
  ADD COLUMN category text CHECK (length(category) <= 120),
  ADD COLUMN location text CHECK (length(location) <= 120);

-- Agencies: the website widget is off until the agency turns it on --------------
ALTER TABLE agencies ADD COLUMN widget_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE (widget_enabled) ON agencies TO geo_app;

-- Site audits: the AI-readiness check of one website ------------------------------
CREATE TABLE site_audits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL,
  client_id     uuid NOT NULL,
  domain        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  -- 'mock' marks a check made against a generated stand-in site, never the real one.
  mode          text NOT NULL CHECK (mode IN ('live', 'mock')),
  pages_checked integer NOT NULL DEFAULT 0,
  findings      jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX site_audits_client_idx ON site_audits (client_id, created_at DESC);

-- Audits: one tracking run plus one site check, with a public share link ----------
CREATE TABLE audits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL,
  client_id     uuid NOT NULL,
  run_id        uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  site_audit_id uuid REFERENCES site_audits (id) ON DELETE SET NULL,
  source        text NOT NULL CHECK (source IN ('manual', 'widget')),
  -- Read-only link to the report. Long and random; replaced to revoke.
  share_token   text NOT NULL UNIQUE CHECK (length(share_token) >= 32),
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  -- Set once the report emails have gone out, so they are never sent twice.
  notified_at   timestamptz,
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX audits_agency_idx ON audits (agency_id, created_at DESC);
CREATE INDEX audits_run_idx ON audits (run_id);
CREATE INDEX audits_site_idx ON audits (site_audit_id);

-- Leads from the website widget -----------------------------------------------------
CREATE TABLE leads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  client_id     uuid,
  audit_id      uuid REFERENCES audits (id) ON DELETE SET NULL,
  name          text CHECK (length(name) <= 120),
  email         text NOT NULL CHECK (email = lower(email) AND length(email) <= 254),
  business_name text NOT NULL CHECK (length(business_name) BETWEEN 1 AND 160),
  domain        text NOT NULL,
  category      text NOT NULL CHECK (length(category) <= 120),
  location      text CHECK (length(location) <= 120),
  status        text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'audit_started', 'not_run')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- If the prospect is deleted the lead stays, unlinked.
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE SET NULL (client_id)
);
CREATE INDEX leads_agency_idx ON leads (agency_id, created_at DESC);
CREATE INDEX leads_dedupe_idx ON leads (agency_id, email, domain, created_at DESC);

-- Row-level security ------------------------------------------------------------------
-- Site audits follow the tracker tables: a client viewer may read their own.
ALTER TABLE site_audits ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON site_audits TO geo_app;
CREATE POLICY site_audits_select ON site_audits FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND (app_client_id() IS NULL OR client_id = app_client_id()));
CREATE POLICY site_audits_write ON site_audits FOR ALL TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL);

-- Audits and leads are the agency's sales pipeline: agency users only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audits', 'leads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO geo_app', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL TO geo_app
      USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
      WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL)$f$, t || '_staff', t);
  END LOOP;
END $$;

-- Prompts and competitors added together keep the order they were given in:
-- each row gets its own timestamp instead of the transaction's.
ALTER TABLE prompts ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE competitors ALTER COLUMN created_at SET DEFAULT clock_timestamp();
