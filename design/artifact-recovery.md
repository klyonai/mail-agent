# Artifact storage and recovery

This document defines target behavior for durable image inputs and generated attachments. It extends [image intake and attachment delivery](attachment-delivery.md) and the [backup and recovery contract](operations.md#backup-recovery-and-change-management). Delivery status and evidence remain in the [roadmap](../docs/roadmap/ROADMAP.md) and [implementation record](../docs/implementation.md). The current configuration example remains text-only; this target does not enable image or PDF processing.

## Versioned snapshot contract

The next artifact-aware state format is schema version 5 and the next snapshot format is version 2. Keep the current schema and snapshot format readable under their existing contract; never reinterpret an older snapshot as though it contains an asset manifest. A version-2 snapshot consists of the consistent database, a strict manifest, and every referenced artifact byte. Configuration, instruction files, and credentials are retained separately.

The manifest has an exact versioned schema. Each entry binds an opaque artifact ID to its owning run and purpose, SHA-256 digest, byte length, detected media type, validation result, source provenance, creation time, and expiry. Provenance identifies the source message and attachment through stable provider identifiers or privacy-preserving hashes. It does not contain mail bodies, extracted text, prompts, or credentials. Reject unknown fields, duplicate IDs, noncanonical media types, path components, symbolic links, hard links, and non-regular files.

Artifacts live under a private state-owned directory. The application chooses opaque names; no provider, message, model, or tool value can select a path. Directories are owner-only and files are owner-read/write only. Validate count, per-file size, aggregate bytes, and processing work before accepting bytes. Check actual length and file signature instead of trusting MIME labels. Publish bytes atomically before committing database references. A crash may leave an unreferenced private file, which bounded cleanup can remove after checking durable references; a committed reference must never point to an unpublished file.

Snapshot creation holds the exclusive state owner and captures the database and artifact manifest as one consistent point. The manifest inventories exactly the referenced, non-expired bytes included in the snapshot, with total count and byte limits. Hash each included file while producing the snapshot and verify it again before declaring the snapshot complete. A digest detects accidental change; it does not authenticate who produced the snapshot. Preserve trusted provenance and restrict access to the database, manifest, artifacts, and separately retained configuration.

## Restore and execution fences

Restore into a fresh private state root. Before publishing it, validate the exact manifest schema, supported snapshot and database versions, mailbox identity, privacy permissions, path rules, counts, size limits, and every artifact hash and length. Check that each required database reference has exactly one matching manifest entry and every entry belongs to the expected run. Reject missing, extra, duplicate, corrupt, expired-but-still-referenced, or unexpected artifact files. Stage validated files and database privately, then publish the recovery hold and restored state with crash-safe reservations. Startup must remain blocked if publication stops between any steps.

The restored state includes verified artifact handles for every resumable run. Before any model request, MCP action, or Graph write, resolve the opaque handle through the manifest and verify ownership, purpose, expiry, type, byte length, and digest. A missing or corrupt artifact fails closed before the external effect. It must not trigger a body-only reply, substitute content, or be treated as evidence that a send did not happen. Preserve the run, approval, cumulative budget, checkpoint, and action/send fences for operator review.

An unresolved send or action remains uncertain even if an artifact is missing. Local byte loss cannot establish whether a remote effect occurred. Reconciliation may release a run only with the existing authoritative absence evidence and approval rules; it cannot invent parser output, tool results, or permission. Expired content may be removed after its reference is durably retired, while content-free deduplication identities and effect fences remain retained.

Migration to schema 5 is atomic and preserves queued work, exact approvals, budgets, message identities, artifact references, and unresolved effect fences. A failed migration leaves the prior state usable or held for forward recovery. Downgrade to a binary that cannot read the new schema is blocked. Never silently drop artifact references or reinterpret old state to make a restore appear complete.

## Acceptance evidence

The subsequent [PDF recipe](pdf-processor.md) adds state schema 6 and snapshot
format 3 for exact source PDFs and derived page provenance. Source/page parity,
retention, crash cleanup and recovery must be integrated before PDF intake is
enabled. Preserve schema-5/format-2 behavior under its existing contract.

Synthetic tests must cover format-1 compatibility and format-2 validation, exact manifest-to-database parity, permissions and link rejection, hash/length mismatch, traversal and duplicate IDs, aggregate limits, crashes during snapshot and restore publication, and cleanup of unreferenced files. Prove that a missing or corrupt artifact prevents model/MCP/Graph calls while preserving queued work and fences, including after restart. Prove that uncertain sends stay uncertain and that artifact expiry never removes replay protection. A successful software restore does not establish external history continuity; follow the separate operator reconciliation and release procedure in [operations](operations.md#backup-recovery-and-change-management).
