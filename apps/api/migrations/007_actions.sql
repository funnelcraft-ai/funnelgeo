-- Action queue: the fixes suggested by each diagnosis, and what the agency
-- produces for them. Nothing here is ever published anywhere automatically.

-- How the client writes, used by the draft generators.
ALTER TABLE clients ADD COLUMN voice text CHECK (length(voice) <= 4000);

CREATE TABLE actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id      uuid NOT NULL,
  client_id      uuid NOT NULL,
  -- What the action fixes, e.g. "site:bestof.example" or "content:<prompt id>".
  -- Later runs update the open action with the same key instead of adding one.
  key            text NOT NULL CHECK (length(key) <= 400),
  type           text NOT NULL CHECK (type IN ('new_content', 'content_update', 'schema', 'technical_fix',
                                               'off_site_listing', 'off_site_outreach', 'profile_review')),
  title          text NOT NULL CHECK (length(title) <= 300),
  rationale      text NOT NULL,
  -- Lost questions addressed, priority questions counting double.
  impact_score   numeric(7, 1) NOT NULL DEFAULT 0,
  effort         text NOT NULL CHECK (effort IN ('S', 'M', 'L')),
  status         text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'in_progress', 'done', 'dismissed')),
  -- 'member': dismissed by someone, not suggested again for 90 days.
  -- 'resolved': closed because a later run no longer shows the problem.
  dismiss_reason text CHECK (dismiss_reason IN ('member', 'resolved')),
  -- Facts the generators use: the site, page, competitors, crawlers involved.
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at    timestamptz,
  dismissed_at   timestamptz,
  done_at        timestamptz,
  done_url       text CHECK (length(done_url) <= 2000),
  done_note      text CHECK (length(done_note) <= 2000),
  last_run_id    uuid REFERENCES runs (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'done' OR done_at IS NOT NULL),
  CHECK ((status = 'dismissed') = (dismiss_reason IS NOT NULL)),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE,
  UNIQUE (id, agency_id)
);
-- One open action per problem.
CREATE UNIQUE INDEX actions_open_key ON actions (client_id, key) WHERE status IN ('suggested', 'approved', 'in_progress');
CREATE INDEX actions_client_idx ON actions (client_id, status, impact_score DESC);

-- The lost questions an action addresses, kept for the before and after comparison.
CREATE TABLE action_prompts (
  action_id uuid NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
  prompt_id uuid NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
  agency_id uuid NOT NULL,
  client_id uuid NOT NULL,
  PRIMARY KEY (action_id, prompt_id)
);
CREATE INDEX action_prompts_prompt_idx ON action_prompts (prompt_id);

-- Everything produced for an action. Each edit or regeneration is a new
-- version; old versions are kept.
CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   uuid NOT NULL,
  client_id   uuid NOT NULL,
  action_id   uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('brief', 'draft', 'faq_schema', 'llms_txt', 'robots_patch', 'outreach_email', 'listing', 'review_request')),
  version     integer NOT NULL CHECK (version >= 1),
  status      text NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  -- 'generated' by a model or rules, or 'edited' by a person.
  origin      text NOT NULL CHECK (origin IN ('generated', 'edited')),
  -- 'mock' marks stand-in text written without a real model.
  mode        text NOT NULL CHECK (mode IN ('live', 'mock')),
  content     text CHECK (length(content) <= 200000),
  model       text,
  credits     integer NOT NULL DEFAULT 0,
  tokens_in   integer,
  tokens_out  integer,
  error       text,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (action_id, kind, version),
  FOREIGN KEY (action_id, agency_id) REFERENCES actions (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX assets_pending_idx ON assets (created_at) WHERE status = 'pending';

-- Generated assets are paid for from the same monthly credits as runs.
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check
  CHECK (reason IN ('run_reserved', 'run_refund', 'grant', 'adjustment', 'asset_reserved', 'asset_refund'));
ALTER TABLE credit_ledger ADD COLUMN asset_id uuid REFERENCES assets (id) ON DELETE SET NULL;
-- Agency users may reserve credits for a run or an asset, and nothing else.
DROP POLICY credit_ledger_insert ON credit_ledger;
CREATE POLICY credit_ledger_insert ON credit_ledger FOR INSERT TO geo_app
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL AND delta < 0 AND reason IN ('run_reserved', 'asset_reserved'));

-- Row-level security ------------------------------------------------------------------
-- The queue is the agency's working space: agency users only. Client approval
-- of actions is a phase 2 feature.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['actions', 'action_prompts', 'assets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO geo_app', t);
    EXECUTE format($f$CREATE POLICY %I ON %I FOR ALL TO geo_app
      USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
      WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL)$f$, t || '_staff', t);
  END LOOP;
END $$;
