-- Platform settings: API keys and similar, entered by the super admin.
--
-- Secrets are encrypted by the application (AES-256-GCM, with a key held only
-- in the server environment) before they reach the database, so a database
-- dump or backup alone does not reveal them. Non-secret settings, such as
-- model names, are stored as plain text.
--
-- Only the platform's owner role reads or writes this table. The tenant role
-- (geo_app) gets no privileges at all, so no agency request can reach it.

CREATE TABLE platform_settings (
  key        text PRIMARY KEY CHECK (key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value      text,
  -- iv (12 bytes) + authentication tag (16 bytes) + ciphertext
  secret     bytea,
  -- Last four characters of a secret, so the admin can recognise which key is saved.
  hint       text CHECK (length(hint) <= 4),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((value IS NULL) <> (secret IS NULL))
);

REVOKE ALL ON platform_settings FROM PUBLIC;
