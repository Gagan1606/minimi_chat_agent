# API v1 contracts

The Zod definitions in `src/contracts/v1/index.ts` are the canonical runtime
request and response validators. `src/contracts/v1/openapi.ts` describes route
operations and references those schemas. Regenerate `openapi.json` after any
contract change with `npm run api:generate`. Contract tests compare the generated
OpenAPI document with the TypeScript source.

## API conventions

- Product routes use `/api/v1`; health probes remain `/health/live` and
  `/health/ready`.
- Requests and responses use complete JSON bodies. Chat and resource-creating
  writes require an `Idempotency-Key`; cookie-authenticated writes require
  `X-CSRF-Token`.
- History uses an opaque HMAC-signed cursor ordered by `(created_at, id)`.
  The signature and a keyed scope fingerprint bind each cursor to the active
  caller scope. The raw scope identifier is not placed in the token.
- `scope` selects personal or workspace behavior, but it does not identify or
  grant access to a person, company, or workspace. Tenant membership and role
  come from trusted session and database membership records.
- Schemas are strict: unknown properties are rejected. In particular, client
  bodies cannot assign roles or tenant IDs.
- Invalid JSON uses `INVALID_REQUEST`/400; valid JSON that fails its schema uses
  `VALIDATION_FAILED`/422. Both use the same error envelope.

## Error envelope

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "requestId": "00000000-0000-4000-8000-000000000000",
    "retryable": false,
    "fieldErrors": [
      { "path": "message", "code": "too_big", "message": "Too long" }
    ]
  }
}
```

`fieldErrors` is omitted when no field-level detail applies. Error messages are
safe for clients and never contain provider errors, stack traces, or secrets.

## Authorization matrix

| Operation                                  | Member                       | Workspace Admin              | Company Admin                         | Platform Admin                        |
| ------------------------------------------ | ---------------------------- | ---------------------------- | ------------------------------------- | ------------------------------------- |
| Personal chat                              | Own account                  | Own account                  | Own account                           | Own account                           |
| Workspace chat                             | Current workspace membership | Current workspace membership | Only if separately a workspace member | Only if separately a workspace member |
| Manage workspace members/settings          | No                           | Assigned workspace           | Workspaces in assigned company        | Any company/workspace                 |
| Assign Workspace Admin                     | No                           | No                           | Workspaces in assigned company        | Any workspace                         |
| Manage company members/workspaces          | No                           | No                           | Assigned company                      | Any company                           |
| Assign Company Admin/create company        | No                           | No                           | No                                    | Any company                           |
| Read detailed rate-limit/security events   | No                           | No                           | No                                    | Yes                                   |
| Read conversation content from admin scope | No                           | No                           | No                                    | No                                    |

Platform administration does not grant conversation-content access. A customer
administrator must have the relevant membership before using a workspace.

## Versioned route inventory

The OpenAPI file lists contract-only routes for:

- Chat, conversation list/detail, and one/all history deletion.
- Company creation and Company Admin assignment.
- Workspace creation, company/workspace member assignment/removal, and
  Workspace Admin assignment.
- Platform-only rate-limit event listing.
- Existing liveness/readiness probes.

M2 defines these shapes and policies; later milestones implement their handlers.
