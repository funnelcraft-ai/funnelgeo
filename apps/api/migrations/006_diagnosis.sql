-- Diagnosis: why a client loses the questions it loses.
--
-- Source types are worked out when they are read (from built-in rules plus the
-- corrections below), not stored on each citation, so a correction applies to
-- every past run at once.

-- An agency's correction of a site's type, used for all its clients.
CREATE TABLE source_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  domain      text NOT NULL CHECK (domain ~ '^[a-z0-9.-]{1,253}$'),
  source_type text NOT NULL CHECK (source_type IN ('list_review', 'forum', 'directory', 'news', 'other')),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, domain)
);

-- A cited page, opened to check whether it names the client and its
-- competitors. Kept per client and reused for 14 days.
CREATE TABLE source_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  url             text NOT NULL,
  status          text NOT NULL CHECK (status IN ('done', 'failed')),
  mode            text NOT NULL CHECK (mode IN ('live', 'mock')),
  title           text,
  lists_client    boolean,
  -- Competitors named on the page, by id.
  lists_competitors uuid[] NOT NULL DEFAULT '{}',
  error           text,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, url),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);

-- One per completed run of a tracked client: the follow-up work after the run
-- (page checks, website check, summary email), each done once.
CREATE TABLE diagnoses (
  run_id      uuid PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  agency_id   uuid NOT NULL,
  client_id   uuid NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  pages_checked integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  emailed_at  timestamptz,
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX diagnoses_pending_idx ON diagnoses (created_at) WHERE status = 'pending';

-- Who gets the summary email after each run.
ALTER TABLE agencies ADD COLUMN run_emails text NOT NULL DEFAULT 'owners' CHECK (run_emails IN ('owners', 'staff', 'off'));
GRANT UPDATE (run_emails) ON agencies TO geo_app;

-- Row-level security ------------------------------------------------------------------
-- Diagnosis is the agency's working view: agency users only, never client viewers.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['source_overrides', 'source_pages', 'diagnoses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO geo_app', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL TO geo_app
      USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
      WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL)$f$, t || '_staff', t);
  END LOOP;
END $$;
