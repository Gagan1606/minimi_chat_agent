CREATE TABLE platform_admin_assignment (
  person_id uuid PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  assigned_by_person_id uuid REFERENCES person(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_admin_assignment (person_id, created_at)
SELECT person_id, min(created_at)
FROM session
WHERE platform_admin = true
GROUP BY person_id
ON CONFLICT (person_id) DO NOTHING;

CREATE TABLE company (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE company_membership (
  person_id uuid PRIMARY KEY REFERENCES person(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'company_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, company_id)
);

CREATE UNIQUE INDEX company_membership_one_admin_idx
  ON company_membership(company_id) WHERE role = 'company_admin';

CREATE INDEX company_membership_company_idx
  ON company_membership(company_id, person_id);

CREATE TABLE workspace (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);

CREATE INDEX workspace_company_listing_idx
  ON workspace(company_id, id);

CREATE TABLE workspace_membership (
  person_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'workspace_admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, company_id, workspace_id),
  FOREIGN KEY (person_id, company_id)
    REFERENCES company_membership(person_id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, company_id)
    REFERENCES workspace(id, company_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX workspace_membership_one_admin_idx
  ON workspace_membership(workspace_id) WHERE role = 'workspace_admin';

CREATE INDEX workspace_membership_workspace_idx
  ON workspace_membership(workspace_id, person_id);

CREATE TABLE conversation (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_person_id uuid NOT NULL REFERENCES person(id) ON DELETE RESTRICT,
  workspace_id uuid REFERENCES workspace(id) ON DELETE RESTRICT,
  title text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    (scope = 'personal' AND workspace_id IS NULL) OR
    (scope = 'workspace' AND workspace_id IS NOT NULL)
  ),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX conversation_personal_listing_idx
  ON conversation(owner_person_id, updated_at DESC, id DESC)
  WHERE scope = 'personal' AND status = 'active';

CREATE INDEX conversation_workspace_listing_idx
  ON conversation(workspace_id, updated_at DESC, id DESC)
  WHERE scope = 'workspace' AND status = 'active';

CREATE TABLE message (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english'::regconfig, coalesce(content, ''))
  ) STORED,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX message_conversation_order_idx
  ON message(conversation_id, created_at, id);

CREATE INDEX message_fulltext_idx ON message USING GIN(search_vector);

CREATE TABLE citation (
  id uuid PRIMARY KEY,
  assistant_message_id uuid NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  url text NOT NULL,
  accessed_at timestamptz NOT NULL,
  published_at timestamptz,
  UNIQUE (assistant_message_id, url)
);

CREATE INDEX citation_message_idx ON citation(assistant_message_id, id);

CREATE TABLE idempotency_record (
  principal_id uuid NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('personal', 'workspace', 'company', 'platform')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('in_progress', 'completed')),
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  result_resource_type text CHECK (result_resource_type IS NULL OR length(result_resource_type) <= 80),
  result_resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (principal_id, scope, idempotency_key),
  CHECK (
    (state = 'in_progress' AND response_status IS NULL) OR
    (state = 'completed' AND response_status IS NOT NULL)
  )
);

CREATE INDEX idempotency_expiration_idx ON idempotency_record(expires_at);

CREATE TABLE admin_audit_event (
  id uuid PRIMARY KEY,
  actor_person_id uuid REFERENCES person(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 80),
  target_id uuid,
  company_id uuid REFERENCES company(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL,
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'denied')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_company_time_idx
  ON admin_audit_event(company_id, occurred_at DESC);

CREATE INDEX admin_audit_workspace_time_idx
  ON admin_audit_event(workspace_id, occurred_at DESC);

CREATE INDEX admin_audit_platform_time_idx
  ON admin_audit_event(occurred_at DESC);

CREATE TABLE rate_limit_event (
  id uuid PRIMARY KEY,
  rule text NOT NULL CHECK (length(rule) BETWEEN 1 AND 100),
  route text NOT NULL CHECK (length(route) BETWEEN 1 AND 200),
  request_id uuid NOT NULL,
  person_id uuid REFERENCES person(id) ON DELETE SET NULL,
  company_id uuid REFERENCES company(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspace(id) ON DELETE SET NULL,
  subject_hash char(64),
  outcome text NOT NULL DEFAULT 'throttled' CHECK (outcome = 'throttled'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX rate_limit_company_time_idx
  ON rate_limit_event(company_id, occurred_at DESC);

CREATE INDEX rate_limit_workspace_time_idx
  ON rate_limit_event(workspace_id, occurred_at DESC);

CREATE INDEX rate_limit_platform_time_idx
  ON rate_limit_event(occurred_at DESC);

CREATE TABLE embedding_outbox (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('upsert', 'delete')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, operation)
);

CREATE INDEX embedding_outbox_ready_idx
  ON embedding_outbox(available_at, created_at)
  WHERE state IN ('pending', 'failed');

CREATE INDEX embedding_outbox_claim_idx
  ON embedding_outbox(claimed_at)
  WHERE state = 'processing';
