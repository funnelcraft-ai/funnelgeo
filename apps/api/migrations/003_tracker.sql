-- Milestone 3: Tracker
-- Competitors, prompts, answer engines, runs, results, mentions, citations
-- and the credit ledger. Every tenant table carries agency_id and client_id
-- so the same two settings (app.agency_id, app.client_id) scope all of them.

-- Plans ---------------------------------------------------------------------
-- Provisional allowances: enough for every client on the plan to run its full
-- prompt set weekly on three engines at one credit per call. Revisit, with
-- engines.credit_cost, once the cost spike has real numbers.
UPDATE plans SET monthly_credits = CASE key
  WHEN 'starter' THEN 5000
  WHEN 'growth'  THEN 24000
  WHEN 'scale'   THEN 130000
  ELSE monthly_credits END;

-- Clients: weekly schedule ----------------------------------------------------
ALTER TABLE clients
  ADD COLUMN schedule text NOT NULL DEFAULT 'off' CHECK (schedule IN ('off', 'weekly')),
  ADD COLUMN next_run_at timestamptz,
  ADD CHECK ((schedule = 'weekly') = (next_run_at IS NOT NULL));

CREATE INDEX clients_due_idx ON clients (next_run_at) WHERE schedule = 'weekly';

-- Engines (global, not per tenant) --------------------------------------------
CREATE TABLE engines (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  credit_cost integer NOT NULL DEFAULT 1 CHECK (credit_cost >= 0),
  active      boolean NOT NULL DEFAULT true,
  sort        integer NOT NULL DEFAULT 0
);

INSERT INTO engines (key, label, credit_cost, sort) VALUES
  ('chatgpt',    'ChatGPT',    1, 1),
  ('perplexity', 'Perplexity', 1, 2),
  ('gemini',     'Gemini',     1, 3);

GRANT SELECT ON engines TO geo_app;

-- Competitors -----------------------------------------------------------------
CREATE TABLE competitors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL,
  client_id  uuid NOT NULL,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  domain     text,
  aliases    text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX competitors_client_idx ON competitors (client_id);
CREATE UNIQUE INDEX competitors_client_name_key ON competitors (client_id, lower(name));

-- Prompts ---------------------------------------------------------------------
-- A prompt's text never changes once it has run, and prompts are archived
-- rather than deleted, so past results always refer to the question asked.
CREATE TABLE prompts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  client_id   uuid NOT NULL,
  text        text NOT NULL CHECK (length(text) BETWEEN 3 AND 500),
  intent      text NOT NULL DEFAULT 'category' CHECK (intent IN ('category', 'comparison', 'problem', 'brand')),
  persona     text,
  priority    boolean NOT NULL DEFAULT false,
  language    text NOT NULL DEFAULT 'en',
  country     text,
  active      boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX prompts_client_idx ON prompts (client_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX prompts_client_text_key ON prompts (client_id, lower(text)) WHERE archived_at IS NULL;

-- Runs ------------------------------------------------------------------------
CREATE TABLE runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL,
  client_id        uuid NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'audit')),
  status           text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'skipped')),
  -- 'mock' marks a run answered by the development stand-in, never by real engines.
  engine_mode      text NOT NULL CHECK (engine_mode IN ('live', 'mock')),
  engine_keys      text[] NOT NULL DEFAULT '{}',
  samples          integer NOT NULL DEFAULT 0,
  prompt_count     integer NOT NULL DEFAULT 0,
  total_calls      integer NOT NULL DEFAULT 0,
  ok_calls         integer NOT NULL DEFAULT 0,
  failed_calls     integer NOT NULL DEFAULT 0,
  credits_reserved integer NOT NULL DEFAULT 0,
  credits_refunded integer NOT NULL DEFAULT 0,
  note             text,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX runs_client_idx ON runs (client_id, created_at DESC);
-- At most one run in flight per client.
CREATE UNIQUE INDEX runs_one_in_flight ON runs (client_id) WHERE status IN ('queued', 'running');

-- Results: one row per prompt, engine and sample --------------------------------
CREATE TABLE prompt_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL,
  client_id     uuid NOT NULL,
  run_id        uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  prompt_id     uuid NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
  engine_key    text NOT NULL REFERENCES engines (key),
  sample_no     integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  answer_text   text,
  -- Source URLs exactly as the engine returned them. Mentions and citations
  -- below are derived from answer_text and this, and can be rebuilt any time.
  raw_citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  error         text,
  tokens_in     integer,
  tokens_out    integer,
  provider_cost numeric(12, 6),
  latency_ms    integer,
  completed_at  timestamptz,
  parsed_at     timestamptz,
  UNIQUE (run_id, prompt_id, engine_key, sample_no),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX prompt_results_run_idx ON prompt_results (run_id, status);
CREATE INDEX prompt_results_prompt_idx ON prompt_results (prompt_id);

-- A brand named in an answer. competitor_id NULL means the client itself.
CREATE TABLE result_mentions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL,
  client_id        uuid NOT NULL,
  prompt_result_id uuid NOT NULL REFERENCES prompt_results (id) ON DELETE CASCADE,
  competitor_id    uuid REFERENCES competitors (id) ON DELETE CASCADE,
  -- Order of first appearance among the tracked brands: 1 is named first.
  position         integer NOT NULL CHECK (position >= 1),
  UNIQUE NULLS NOT DISTINCT (prompt_result_id, competitor_id)
);
CREATE INDEX result_mentions_result_idx ON result_mentions (prompt_result_id);

-- A source the engine cited for an answer.
CREATE TABLE citations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id        uuid NOT NULL,
  client_id        uuid NOT NULL,
  prompt_result_id uuid NOT NULL REFERENCES prompt_results (id) ON DELETE CASCADE,
  position         integer NOT NULL,
  url              text NOT NULL,
  domain           text NOT NULL,
  is_client        boolean NOT NULL DEFAULT false
);
CREATE INDEX citations_result_idx ON citations (prompt_result_id);
CREATE INDEX citations_client_domain_idx ON citations (client_id, domain);

-- Credit ledger: append-only; the balance is always a sum --------------------------
CREATE TABLE credit_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id  uuid NOT NULL REFERENCES agencies (id) ON DELETE CASCADE,
  delta      integer NOT NULL CHECK (delta <> 0),
  reason     text NOT NULL CHECK (reason IN ('run_reserved', 'run_refund', 'grant', 'adjustment')),
  run_id     uuid REFERENCES runs (id) ON DELETE SET NULL,
  note       text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_agency_idx ON credit_ledger (agency_id, created_at DESC);

-- Credits left this calendar month (UTC): the plan's allowance plus this
-- month's ledger entries (usage is negative, refunds and grants positive).
CREATE FUNCTION credits_remaining(p_agency uuid) RETURNS integer
  LANGUAGE sql STABLE
  AS $$
    SELECT (SELECT p.monthly_credits FROM agencies a JOIN plans p ON p.id = a.plan_id WHERE a.id = p_agency)
         + coalesce((SELECT sum(delta) FROM credit_ledger
                      WHERE agency_id = p_agency AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0)::integer
  $$;

-- Row-level security ------------------------------------------------------------
-- Same shape as the foundation tables: agency users see their agency's rows,
-- a client viewer sees only their client's rows and can write nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['competitors', 'prompts', 'runs', 'prompt_results', 'result_mentions', 'citations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO geo_app', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR SELECT TO geo_app
      USING (agency_id = app_agency_id() AND (app_client_id() IS NULL OR client_id = app_client_id()))$f$, t || '_select', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR INSERT TO geo_app
      WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL)$f$, t || '_insert', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR UPDATE TO geo_app
      USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
      WITH CHECK (agency_id = app_agency_id())$f$, t || '_update', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR DELETE TO geo_app
      USING (agency_id = app_agency_id() AND app_client_id() IS NULL)$f$, t || '_delete', t);
  END LOOP;
END $$;

-- The ledger: a tenant may read its own entries and record usage, nothing
-- else. Refunds and grants are written by the platform (owner role), so a
-- tenant request can never add credits to itself, and nobody can edit history.
ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON credit_ledger TO geo_app;
CREATE POLICY credit_ledger_select ON credit_ledger FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL);
CREATE POLICY credit_ledger_insert ON credit_ledger FOR INSERT TO geo_app
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL AND delta < 0 AND reason = 'run_reserved');

