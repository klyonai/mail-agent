# Folder-backed records adapter

Desired contract for the MA-013 records recipe. Delivery status and evidence belong in the [roadmap](../docs/roadmap/ROADMAP.md) and [implementation record](../docs/implementation.md). This design does not imply that records tools are currently shipped or supported.

## Ownership and source of truth

Run one dedicated first-party `records` stdio MCP server for one Mail Agent deployment. Its configured root is a private, operator-selected folder. Human-readable, versioned files in that folder are authoritative; any search index or cache is disposable and rebuildable. The server never follows model-provided paths or URLs, and never accesses files outside its configured root.

Records have an opaque stable ID, canonical type, bounded validated fields, monotonically increasing revision, and creation/update provenance. A revision change publishes a complete new file atomically and retains enough prior revision metadata for conflict reporting and reconciliation. File names are derived only from validated opaque IDs. Folder privacy, regular-file type, link count, symlink exclusion, size and count limits are checked at the boundary.

## Trusted actor and authorization

Actor context is an opt-in dedicated-stdio extension. Configuration explicitly selects `actor_context: mail-agent-v1`; during MCP initialization, the server advertises `experimental: { "mail-agent/actor-context": { "version": 1 } }`. Only a negotiated server receives `tools/call` `_meta["mail-agent/actor-context"]`; generic stdio and all HTTP servers receive no actor context. The exact bounded context has `version`, `agentId`, `mailbox`, authenticated `actor`, `provenance` (`source: verified-mail-envelope`, message and conversation ID hashes, and auth profile), namespaced `tool`, canonical `argsHash`, stable `operationId`, `policyHash`, issue/expiry times, and authorization (`automatic` or `approval`). Approval context contains only the exact grant ID, operator attribution, `origin: local-operator`, reason hash, and expiry. It is created from the persisted runtime grant, never model arguments. The operator identity is audit attribution protected by host access controls, not independent email authentication.

The runtime enforces sender admission and the adapter independently enforces record visibility and mutation authority. A generic MCP `automatic` policy cannot enable mutation tools for this adapter. Domain policy defaults to read-only; write tools remain hidden or reject unless the runtime supplies a valid exact-approval receipt. A model cannot approve a proposal, change its actor, broaden its visibility, or substitute a target revision.

## Minimal tool contract

The first recipe exposes only these bounded operations:

| Tool | Effect | Contract |
| --- | --- | --- |
| `search` | Read | Search records visible to the authenticated sender; bounded result count and excerpt bytes; return opaque IDs and current revisions. |
| `get` | Read | Read one visible record by opaque ID and optional exact revision; return bounded fields, revision, provenance, and canonical record hash. |
| `propose_update` | Read-only proposal | Validate an allowed patch against the current revision and return `expectedRecordHash` plus a canonical proposal digest. It creates no state or external effect. |
| `apply_approved_update` | Write | Accept `recordId`, `expectedRevision`, `expectedRecordHash`, `patch`, and `proposalDigest`; recompute the digest and require trusted exact-approval context. Recheck requester authority, approver, policy, expiry, revision, and exact record hash; publish one revision atomically. |
| `propose_delete` | Read-only proposal | Return current revision, record hash, and canonical digest for a visible record. It creates no state or external effect. |
| `apply_approved_delete` | Write | Accept `recordId`, `expectedRevision`, `expectedRecordHash`, and `proposalDigest`; require trusted exact-approval context and recheck authority, revision, and hash. Publish a tombstone. |
| `operation_status` | Read | Inspect an operation through verified requester context without returning record content. |

The proposal is a deterministic description, not a persisted grant or capability. Its digest binds record ID, exact expected revision and hash, and patch. Editing any of these requires a new exact local approval. The runtime approval binds complete apply-tool arguments. A revision or hash mismatch is a conflict with safe current metadata; it never auto-merges or reapplies.

## Uncertain effects and deletion

Each approved commit has a stable operation ID and a durable per-record pending fence written before publication. An immutable intent is published first so a process stopped before the fence or file write can be distinguished from an unknown effect. The record is atomically replaced, then an immutable content-free receipt binds operation ID, tool, arguments hash, target, expected revision/hash, and committed revision/hash. A pending fence blocks unrelated writes to its record. The exact operation can return its committed receipt after restart; a retry may publish only when the record still matches the bound expected revision and hash under a fresh exact approval. Ambiguity remains fenced. `operation_status` returns safe evidence without clearing a fence. A local `inspectOperation({intent, actor, reason})` API may produce a content-free receipt with `committed`, `not-applied`, `unresolved`, or `unknown` status. `not-applied` requires the authoritative record to match the exact expected revision and hash. Inspection never authorizes another write or clears a fence.

Deletion is explicit and approval-bound. Tombstones preserve the record ID, revision, actor/proposal references, and content-free audit provenance. Content removal follows a documented retention policy; backup/restore must preserve tombstones and unresolved operation fences. Search indexes and caches can be rebuilt without restoring deleted content.

A later exact-approved mutation may settle an older pending fence only when the
stored intent, pending binding and current record marker prove that older commit.
Publish its immutable receipt and audit before removing the fence; settlement
does not repeat the business effect. Then check the new mutation's own revision,
hash and authority. Mismatched or unresolved evidence continues to block writes.
Read-only inspection leaves the fence unchanged.

Agent snapshots exclude the authoritative records root. Operators stop both
owners and preserve a consistent pair of snapshots, including tombstones, intents
and pending fences. Restored agent state remains held for explicit whole-window
recovery. Releasing that hold must preserve unresolved business-action fences;
folder restoration alone never authorizes replay.

## Local operator reconciliation

The `reconcile-records` operator command accepts an inspected receipt and an
explicit attestation reason. Host access controls and current runtime approver
policy authorize this decision; a supplied receipt is not cryptographic proof.
Inspect the stopped authoritative adapter and keep it quiescent through the
decision. Generic tool errors and unauthenticated responses cannot resolve a
write. The command invokes no connector or business write.

Before dispatch the runtime retains content-free domain intent: identity,
operation/tool/argument digest, target/base revision/hash, proposal, policy and
hashed requester/approver/reason attribution. Strict receipt binding and one
transaction update action, run and audit. An exact replay is acknowledged only
while its recorded resulting action fingerprint still matches. Conflicting
receipts are rejected. Confirmed commits resume only with retained content,
original policy/authority and valid cumulative budgets; otherwise the run ends.
Confirmed non-writes require an unchanged base record and fresh exact approval
before retry. Unknown outcomes, mismatches and legacy actions without intent
remain fenced. Resolving one action never clears other uncertain actions. Expired
content is never reconstructed.

An outstanding execution reservation blocks reconciliation. First complete the
existing restart/recovery procedure; this command cannot infer unknown budgets or
declare that an in-flight effect has stopped.

## Provenance and bounded results

Read results identify the record ID, revision, file-derived source reference, and a stable content hash. Excerpts and result counts are bounded before entering model context. Record content is untrusted data and cannot alter system instructions or authorization. Adapter errors expose fixed safe codes for missing records, denied visibility, invalid fields, revision conflicts, and unresolved writes; they omit paths, file contents, and arbitrary filesystem diagnostics.

## Acceptance

Synthetic tests prove sender-scoped reads, denied cross-sender access, rejection of model-supplied identity/approval fields, exact local approval, generic automatic-write denial, immutable proposal binding, revision conflict, atomic publication, restart idempotency, uncertain-write fencing and reconciliation, tombstone behavior, bounded outputs, and rebuildable index behavior. A composed runtime/MCP journey proves the model cannot invoke mutations before local approval. The fixture uses synthetic records and no customer data.

MA-013 depends on the MA-008 MCP loop and MA-006 recovery contract. The trusted actor/approval metadata channel is an integration prerequisite: if the runtime cannot authenticate and bind it to each invocation, the adapter must remain read-only. See the [MA-013 roadmap item](../docs/roadmap/ROADMAP.md#c--document-inbox-and-domain-integrations).
