# Deletion, retention, and restore runbook

## Application deletion

- Conversation deletion is owner-scoped and tombstones the conversation and its messages in one PostgreSQL transaction.
- Message content is immediately replaced with `[deleted]`; citations are removed. All retrieval paths require active conversation/message state, so a stale vector candidate cannot restore the content.
- The same transaction queues a vector `delete` operation for every affected message. The embedding indexer retries transient failures. Do not purge the PostgreSQL tombstone or delete outbox row before vector deletion completes.
- Personal users may delete one or all personal conversations. Workspace members may delete only their own workspace conversations or all of their own conversations in that workspace.
- Expired idempotency records are removed by the maintenance worker. Completed outbox rows are retained for 30 days, then removed. Rate-limit and audit-event retention remains governed by deployment policy because no product retention period is specified.

## Backup policy and restore

- Configure the managed PostgreSQL service for encrypted daily backups retained for 30 days. The recovery objectives are RPO ≤24 hours and RTO ≤8 hours.
- Before release, the deployment owner must verify encryption, retention, and point-in-time recovery in the selected managed database service. The app reports backup status only from deployment configuration; it does not create backups itself.
- Restore into an isolated database and keep application traffic disabled. Restore to the latest recoverable point (including transaction logs when available), apply migrations, run the migration and deletion-reconciliation checks, then verify deleted conversations are not returned by list, detail, personal retrieval, or workspace retrieval.
- If the chosen backup service cannot recover deletion commits newer than its restore point, keep the restored service offline until the owner has reconciled those deletions from a current source. Do not expose a restored snapshot that may contain content users already deleted.
- Record restore start/end times and the observed recovery point. A scheduled restore exercise and provider-specific encrypted-backup configuration are release-owner tasks; no cloud provider is selected in the repository.
