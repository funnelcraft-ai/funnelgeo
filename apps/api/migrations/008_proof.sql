-- Proof: visits from AI assistants to clients' websites, recorded by a small
-- tracking snippet. No cookies and no IP addresses are stored: a visit is
-- the engine it came from, the page it landed on, a random per-tab session
-- id (hashed) and the time.

-- The public key in each client's snippet. Not a secret: it is visible in the
-- client's page source. It only identifies which client a visit belongs to.
ALTER TABLE clients ADD COLUMN site_key text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') UNIQUE;
-- When the snippet last reported in from the client's site, to confirm the install.
ALTER TABLE clients ADD COLUMN snippet_seen_at timestamptz;

CREATE TABLE ai_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id       uuid NOT NULL,
  client_id       uuid NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  source_engine   text NOT NULL CHECK (source_engine ~ '^[a-z0-9_]{2,30}$'),
  -- How it was recognised: the referring site, or a utm_source tag.
  via             text NOT NULL CHECK (via IN ('referrer', 'utm')),
  -- Address of the landing page without its query string (utm_source kept).
  landing_url     text NOT NULL CHECK (length(landing_url) <= 2000),
  landing_path    text NOT NULL CHECK (length(landing_path) <= 1000),
  session_hash    text NOT NULL CHECK (length(session_hash) = 64),
  -- Sent from the "Send a test visit" link: shown, but left out of totals.
  is_test         boolean NOT NULL DEFAULT false,
  converted       boolean NOT NULL DEFAULT false,
  conversion_name text CHECK (length(conversion_name) <= 80),
  converted_at    timestamptz,
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX ai_visits_client_time_idx ON ai_visits (client_id, occurred_at DESC);
CREATE INDEX ai_visits_session_idx ON ai_visits (session_hash, occurred_at DESC);

-- Readable by the agency's users and by viewers of that client. Written only by
-- the collector, which uses the platform's own role: no tenant may insert.
ALTER TABLE ai_visits ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON ai_visits TO geo_app;
CREATE POLICY ai_visits_read ON ai_visits FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND (app_client_id() IS NULL OR client_id = app_client_id()));
