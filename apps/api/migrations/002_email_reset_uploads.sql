-- Password reset and session invalidation.

-- Bumped whenever a user's password changes. Sessions carry the value they
-- were issued with and stop working once it moves on.
ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;

-- Single-use, short-lived reset tokens. Only the hash is stored.
CREATE TABLE password_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_resets_user_idx ON password_resets (user_id);

-- The visitor has no session when resetting, so this table is used only by
-- the owner role. geo_app gets no privileges on it and no policies.
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
