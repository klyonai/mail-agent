# Synthetic MCP acceptance adapter

This fixture is for MA-008 acceptance only. It has no business connectors, network requests, arbitrary file access or client-supplied content storage. It is excluded from the published package. Passing its tests does not qualify a live model, mailbox or third-party MCP.

Run the pinned project Node runtime (24.21.0 or a qualified later Node 24 patch) with `server.mjs` over stdio. Standard output contains MCP protocol messages only. Configuration/startup failures emit only `ACCEPTANCE_STARTUP_FAILED` to standard error.

## Explicit environment

| Name | Required value |
| --- | --- |
| `ACCEPTANCE_ROOT` | Absolute path to an existing dedicated owner-only directory (`0700`). The fixture does not create or broaden its permissions. |
| `ACCEPTANCE_MARKER` | Generated lowercase UUID used as the exact record namespace. Reusing storage with another marker fails closed. |
| `ACCEPTANCE_FAILURE_MODE` | Optional `none` (default), `before-write` or `after-write`. No arbitrary mode is accepted. |

Allowlist only those variables in the runtime MCP configuration. The connection name for acceptance is `livefixture`, so runtime tool names are `livefixture.read_note`, `livefixture.write_note` and `livefixture.forbidden_delete`. Resolve the executable and fixture entrypoint through the operator's explicit configuration; no developer executable path is required.

Use a fresh private directory and UUID for each independent journey. Startup initializes or validates local synthetic SQLite storage; launching this fixture is itself an explicit local setup effect. There is no reset/delete tool. The owner may remove the dedicated directory after stopping the fixture and preserving any required acceptance evidence.

## Tools and policy

Every input schema is an object with `additionalProperties: false`. `record` is required and must equal the configured marker.

| Tool | Other required arguments | Behavior |
| --- | --- | --- |
| `read_note` | `variant`: `clean` or `injection` | Returns a fixed synthetic note or deliberately hostile untrusted text. Never writes a note or audit entry. |
| `write_note` | `note`: exactly `approved-synthetic-note` | Commits one note and one audit entry atomically; repeated exact calls return `already-written`. |
| `forbidden_delete` | None | Listed for denial tests. Always returns an error and never deletes anything. |

Configure runtime policy to allow the read, require exact local approval for the write, and omit the forbidden tool. MCP annotations and descriptions are test metadata, not authorization. The injection variant asks the caller to bypass approval and invoke the forbidden tool; it must remain untrusted tool data.

Successful results are JSON in a text content block. All include `source: "mail-agent-synthetic-fixture"`, the synthetic `record` and `writeCount` (`0` or `1`). Reads add `variant` and `note`; writes add `outcome` (`written` or `already-written`). The clean initial note is `synthetic-read-note`; after a committed write it is `approved-synthetic-note`.

Rejected arguments return `isError: true` with `ACCEPTANCE_ARGUMENTS_REJECTED`; unknown/forbidden tools return `ACCEPTANCE_TOOL_DENIED`. Storage failures return `ACCEPTANCE_STORAGE_FAILURE`. These fixed errors do not echo arguments or filesystem details.

## Durable evidence and failure modes

The fixed private file `fixture.sqlite` (`0600`) uses SQLite full synchronization and DELETE journaling. Its namespace, exact schema and synthetic rows are validated at startup. Symlinks, hard links, permissive or foreign-owned files, unexpected directory entries/schema objects and files over 1 MiB are rejected. Only the database and its private rollback journal may exist in the root, each bounded to 1 MiB; stdio input buffering is capped at 16 KiB. SQL busy waiting is capped at one second.

The database contains `meta(id=1, marker)`, `notes(id=1, marker, note)` and `audit(sequence=1, kind, marker, note_hash)`. The sole append-only write audit has kind `synthetic-note-written` and the SHA-256 of the fixed note. Idempotent replays add no audit entry. The fixture never overwrites or removes the note/audit through its API. Owner access to this synthetic database is the inspection boundary, not cryptographic evidence of authorship.

- `before-write` returns `ACCEPTANCE_CONTROLLED_FAILURE` before starting the write transaction.
- `after-write` commits the note and audit, then returns the same error instead of a success result. A repeated call recognizes the committed note and returns `already-written` without another write.

The identical error intentionally makes no claim that an effect is absent. The runtime must fence an uncertain write and reconcile against the private fixture ledger; it must not infer absence from an error or blindly retry. To continue a before-write journey after reconciliation, restart with `none` and preserve the original root/marker.

## Local tests

`node --test test/live-mcp-adapter.test.mjs` uses the official SDK client and server over actual child-process stdio, with temporary private roots and synthetic markers. It verifies schemas, strict arguments, injection provenance, denied deletion, durable idempotency/restart, controlled failure outcomes and private storage rejection. No live model or email account is used.
