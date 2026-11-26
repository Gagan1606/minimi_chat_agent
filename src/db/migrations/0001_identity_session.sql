CREATE TABLE person (
  id uuid PRIMARY KEY,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_identity (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  display_name text,
  amr text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE INDEX auth_identity_person_id_idx ON auth_identity(person_id);

CREATE TABLE session (
  token_hash char(64) PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  csrf_token_hash char(64) NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false,
  mfa_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX session_person_id_idx ON session(person_id);
CREATE INDEX session_expiration_idx ON session(idle_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE oidc_transaction (
  state_hash char(64) PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  browser_binding_hash char(64) NOT NULL,
  return_to text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX oidc_transaction_expiration_idx ON oidc_transaction(expires_at);

CREATE TABLE auth_rate_limit_bucket (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count > 0),
  expires_at timestamptz NOT NULL
);

CREATE INDEX auth_rate_limit_expiration_idx ON auth_rate_limit_bucket(expires_at);
