-- Monthly client reports. A report's figures are worked out when it is drafted
-- and can be refreshed while it is a draft; approving freezes them, so the
-- client receives exactly what an agency user approved.

CREATE TABLE reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     uuid NOT NULL,
  client_id     uuid NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL CHECK (period_end >= period_start),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sent')),
  -- The figures, as of the last refresh.
  data          jsonb NOT NULL,
  data_at       timestamptz NOT NULL DEFAULT now(),
  -- Written by the model, then edited by the agency.
  summary_text  text CHECK (length(summary_text) <= 6000),
  -- 'pending' while the model writes it; 'failed' with a reason if it couldn't.
  summary_state text NOT NULL DEFAULT 'none' CHECK (summary_state IN ('none', 'pending', 'done', 'failed')),
  summary_error text,
  summary_mode  text CHECK (summary_mode IN ('live', 'mock')),
  plan_text     text CHECK (length(plan_text) <= 6000),
  -- The live link: works only once the report is approved, and only on the agency's own address.
  share_token   text NOT NULL UNIQUE CHECK (length(share_token) >= 32),
  pdf           bytea,
  approved_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at   timestamptz,
  -- Sending: queued, then done or failed with a reason.
  send_state    text NOT NULL DEFAULT 'none' CHECK (send_state IN ('none', 'pending', 'done', 'failed')),
  send_error    text,
  recipients    text[] NOT NULL DEFAULT '{}',
  sent_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  sent_at       timestamptz,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One report per client and month.
  UNIQUE (client_id, period_start, period_end),
  CHECK (status = 'draft' OR approved_at IS NOT NULL),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL),
  FOREIGN KEY (client_id, agency_id) REFERENCES clients (id, agency_id) ON DELETE CASCADE
);
CREATE INDEX reports_client_idx ON reports (client_id, period_start DESC);

-- Where a client's reports go, besides the client's dashboard users.
ALTER TABLE clients ADD COLUMN report_emails text[] NOT NULL DEFAULT '{}' CHECK (cardinality(report_emails) <= 10);

-- The report summary is paid for like any other generated text.
ALTER TABLE credit_ledger ADD COLUMN report_id uuid REFERENCES reports (id) ON DELETE SET NULL;
ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_reason_check;
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_reason_check
  CHECK (reason IN ('run_reserved', 'run_refund', 'grant', 'adjustment', 'asset_reserved', 'asset_refund', 'summary_reserved', 'summary_refund'));
DROP POLICY credit_ledger_insert ON credit_ledger;
CREATE POLICY credit_ledger_insert ON credit_ledger FOR INSERT TO geo_app
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL AND delta < 0 AND reason IN ('run_reserved', 'asset_reserved', 'summary_reserved'));

-- Agency users see and work on every report; a client's viewers see only
-- that client's sent reports, and can't change them.
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON reports TO geo_app;
CREATE POLICY reports_staff ON reports FOR ALL TO geo_app
  USING (agency_id = app_agency_id() AND app_client_id() IS NULL)
  WITH CHECK (agency_id = app_agency_id() AND app_client_id() IS NULL);
CREATE POLICY reports_viewer ON reports FOR SELECT TO geo_app
  USING (agency_id = app_agency_id() AND client_id = app_client_id() AND status = 'sent');
