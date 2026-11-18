-- Plans, real costs and allowances.
--
-- Credits are what agencies see and spend. Real cost is what the platform
-- pays the AI providers: every engine call, writing call, suggestion and
-- crawled page is recorded here with its tokens, and priced from the model
-- prices the super admin keeps up to date. Agencies never see real costs.

CREATE TABLE usage_events (
  id                bigserial PRIMARY KEY,
  -- Null for the platform's own calls, such as Test buttons on the API keys screen.
  agency_id         uuid REFERENCES agencies (id) ON DELETE CASCADE,
  client_id         uuid,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('engine_call', 'writer_call', 'suggestion_call', 'page_fetch', 'test_call')),
  -- openai, perplexity, gemini, anthropic, crawl, or mock (stand-in answers, free).
  provider          text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,30}$'),
  model             text NOT NULL DEFAULT '*' CHECK (length(model) <= 120),
  tokens_in         integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out        integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  requests          integer NOT NULL DEFAULT 1 CHECK (requests >= 0),
  -- When the provider reports the call's cost itself, that wins over the price table.
  provider_cost_usd numeric(14, 6),
  -- What the call was for: a prompt result, asset, report or site audit.
  ref_id            uuid
);
CREATE INDEX usage_events_time_idx ON usage_events (occurred_at);
CREATE INDEX usage_events_agency_idx ON usage_events (agency_id, occurred_at);

-- Prices per provider and model, in USD, as published by the provider.
-- model '*' is the provider's fallback for models without their own row.
CREATE TABLE model_prices (
  provider        text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,30}$'),
  model           text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  input_per_mtok  numeric(12, 6) NOT NULL DEFAULT 0 CHECK (input_per_mtok >= 0),
  output_per_mtok numeric(12, 6) NOT NULL DEFAULT 0 CHECK (output_per_mtok >= 0),
  -- Per call: web search or grounding fees, request fees.
  per_request     numeric(12, 6) NOT NULL DEFAULT 0 CHECK (per_request >= 0),
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);
-- Fetching a web page costs the platform nothing per page; stand-in answers are free.
INSERT INTO model_prices (provider, model) VALUES ('crawl', '*'), ('mock', '*');

-- What each provider actually billed for a month, entered from the invoice.
CREATE TABLE provider_invoices (
  provider   text NOT NULL CHECK (provider ~ '^[a-z0-9_]{2,30}$'),
  month      date NOT NULL CHECK (extract(day FROM month) = 1),
  amount_usd numeric(12, 2) NOT NULL CHECK (amount_usd >= 0),
  note       text CHECK (length(note) <= 300),
  entered_by uuid REFERENCES users (id) ON DELETE SET NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, month)
);

-- Each event's cost in USD: the provider's own figure, else tokens and calls
-- times the model's price (or the provider's fallback). Null when no price
-- is set, so totals can say they are incomplete instead of being quietly low.
CREATE VIEW usage_costs AS
SELECT u.*,
       CASE
         WHEN u.provider_cost_usd IS NOT NULL THEN u.provider_cost_usd
         WHEN p.provider IS NULL THEN NULL
         ELSE u.tokens_in / 1e6 * p.input_per_mtok + u.tokens_out / 1e6 * p.output_per_mtok + u.requests * p.per_request
       END AS cost_usd
  FROM usage_events u
  LEFT JOIN LATERAL (
    SELECT * FROM model_prices mp
     WHERE mp.provider = u.provider AND mp.model IN (u.model, '*')
     ORDER BY (mp.model = u.model) DESC LIMIT 1
  ) p ON true;

-- Only the platform's own role reads or writes these. Agencies see credits, never costs.
REVOKE ALL ON usage_events, model_prices, provider_invoices, usage_costs FROM PUBLIC;

-- Top-up: an owner may let the agency go past its monthly allowance, up to a cap.
ALTER TABLE agencies ADD COLUMN topup_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE agencies ADD COLUMN topup_limit integer NOT NULL DEFAULT 0 CHECK (topup_limit BETWEEN 0 AND 10000000);
-- The month ('YYYY-MM') each usage alert was last sent, so each goes once a month.
ALTER TABLE agencies ADD COLUMN alert_80_month text;
ALTER TABLE agencies ADD COLUMN alert_100_month text;
GRANT UPDATE (topup_enabled, topup_limit) ON agencies TO geo_app;

-- Plans: prices are optional until set, in INR or USD.
ALTER TABLE plans ADD CONSTRAINT plans_currency_check CHECK (currency IS NULL OR currency IN ('INR', 'USD'));

-- What can still be spent this month: what's left of the allowance, plus the
-- top-up cap when top-up is on. Every check before spending credits uses this.
CREATE FUNCTION credits_spendable(p_agency uuid) RETURNS integer
  LANGUAGE sql STABLE
  AS $$
    SELECT credits_remaining(p_agency)
         + (SELECT CASE WHEN topup_enabled THEN topup_limit ELSE 0 END FROM agencies WHERE id = p_agency)
  $$;
