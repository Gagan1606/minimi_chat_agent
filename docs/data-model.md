# Core relational data model

PostgreSQL is authoritative. Migration `0002_core_schema.sql` adds the first
release's tenancy, conversation, audit, idempotency, and embedding-outbox tables
without modifying the applied M1 migration. Application-assigned UUIDs are
opaque identifiers; IDs are not sequential. The M1 identity remains split
between `person` and `auth_identity`.

## Relationships and invariants

- A `person` has at most one `company_membership` and one
  `workspace_membership`. A workspace membership references the same company
  as its company membership and workspace through composite foreign keys.
- Each company has at most one `company_admin`; each workspace has at most one
  `workspace_admin`. The designated admin remains a membership, not an
  unscoped role supplied by the client.
- `platform_admin_assignment` persists global service roles independently of
  an individual session. Migration 0002 backfills it from M1 sessions already
  marked as Platform Admin.
- A personal `conversation` has an owner and no workspace. A workspace
  conversation has an owner and workspace. The database enforces this shape;
  the application must still verify membership for access.
- `message` rows belong to conversations and carry a generated English
  PostgreSQL full-text vector. Both conversations and messages support a
  tombstone state so later vector cleanup cannot make deleted data retrievable.
- `citation` rows belong to assistant messages. `idempotency_record` is unique
  per principal, scope, and key and stores a request hash plus a result
  reference, not a duplicate response body.
- `admin_audit_event` and `rate_limit_event` contain actor/target/scope,
  request, outcome, and timestamp metadata only. They have no fields for prompt,
  answer, or conversation content.
- `embedding_outbox` records idempotent `upsert`/`delete` operations against
  message IDs, with bounded retry metadata. It stores no text or embedding.

## Indexes

- Identity and membership primary/unique keys enforce OIDC identity and one
  tenant/workspace assignment per person.
- Partial unique indexes enforce a single designated Company Admin and
  Workspace Admin in each scope.
- Composite workspace membership foreign keys prevent cross-company
  assignments even if application checks are missed.
- Partial conversation listing indexes cover active personal and workspace
  histories ordered by `(updated_at DESC, id DESC)`.
- A GIN index covers generated message full-text data; a B-tree index covers
  transcript order by `(conversation_id, created_at, id)`.
- Citation, idempotency expiry, tenant event timelines, and pending outbox
  operations have lookup/cleanup indexes matching their access paths.

## Vector contract

Vector storage is an external derived index, never the source of truth. A vector
record ID identifies its source message. Filter metadata is limited to
`scope`, `scopeId`, `status`, and `createdAt`; query filters require `status` to
be `active`. Returned candidates must be revalidated against PostgreSQL before
content is hydrated. The model context DTO contains only `content` and
`createdAt`, never vector metadata, identity, roles, or record IDs.
