# Mail Agent roadmap

Sanitized source review · 2026-10-03 · unreleased. [Design](../../design/vision.md) owns the desired state; this is the active delivery list. Original private incident evidence and historical records remain archived unchanged outside this export. Omission does not waive acceptance.

## Current progress

**6/13 items are done; milestone A is 6/7.** See [public acceptance](../public-acceptance.md) for observed qualification and [implementation](../implementation.md) for its scope. Microsoft 365 administration is an accepted deployment assumption. The [dated scope decision](history/2026-10-03-agent-threat-model-scope.md) explicitly amends only MA-004; prior inconclusive header probes remain inconclusive, and Microsoft support is no longer a release dependency.

GitHub private vulnerability reporting and Issues are selected. Public visibility, enabled reporting, monitoring, exact artifact/advisory review and publication still require the final release gates. No public release/image or npm publication is claimed.

## Delivery order

1. Finish milestone A acceptance and exact private candidate qualification, then review publication and verify the released installation.
2. Qualify failed/interrupted MCP effects and two independent model endpoints for beta.
3. Qualify images, attachment delivery, reproducible PDF processing and records workflows against their unchanged criteria.

Done requires every criterion and its evidence. Dependencies gate completion. Amend design and append a dated decision before changing a criterion; never remove an unmet criterion merely to claim completion.

## A · Installable text-inbox alpha

Scope: one mailbox per deployment, direct text replies and operator installation. Optional MCP is experimental; no document support is advertised. Public alpha requires MA-001–MA-007.

| ID / status | Work and design source | Completion criteria | Depends on |
| --- | --- | --- | --- |
| **MA-001 · done** | Diagnostics · [experience](../../design/experience.md), [security](../../design/security.md) | Offline `doctor` is network-free; explicit live probes send no mail/mutations. Human/JSON results distinguish pass/fail/not-checked, placeholder/secret/state problems, credential/access/mailbox/connectivity/throttling/model failures and safe corrective steps. Required failures exit nonzero; existing `check` contracts remain compatible. | — |
| **MA-002 · done** | Guided setup and administrator guide · [configuration](../../design/configuration.md), [experience](../../design/experience.md) | Guided/noninteractive `init` share validation, use safe defaults, write atomically, refuse overwrite and show exact next steps. Secrets stay external; transport verification stays an administrator decision. A fresh operator completes container setup using only the quickstart and scoped tenant guide. | MA-001 |
| **MA-003 · done** | Unsupported-request experience · [features](../../design/features.md), [architecture](../../design/architecture.md) | Separate identity/recipient authorization from format support. Authorized unsupported requests get one bounded deterministic explanation without inference/tools/attachment contents; unknown, unauthenticated and automatic mail stays silent. Inline artifacts vs document inputs have explicit classification. Recipient gates, loops, deduplication and fences hold. | MA-001 |
| **MA-004 · done** | Live text and tenant qualification · [features](../../design/features.md), [security](../../design/security.md) | Verify separate recipient arrival, follow-ups, ambiguous requests, unavailable services and quoted injection cases. Record allowed/denied sender and mailbox access plus administrator acceptance of the configured Microsoft 365 deployment assumptions. Acceptance command declares bounded synthetic effects and produces a redacted report; no broader agent grants are introduced merely for testing. | MA-002, MA-003 |
| **MA-005 · done** | Operational status and safe retry · [operations](../../design/operations.md) | Report baseline completion, last successful poll, backlog, approvals/uncertainty and categorized failures. Local health distinguishes liveness/readiness without a public endpoint. Eligible reads use bounded jitter/backoff and `Retry-After`; budgets/cancellation/fences hold and uncertain sends/writes are never blindly retried. Operational queries are bounded as metadata grows. | MA-001 |
| **MA-006 · done** | Recovery and upgrade contract · [operations](../../design/operations.md), [architecture](../../design/architecture.md) | Recorded outage, credential rotation, stopped backup/restore and upgrade drills with queued/approved/uncertain work. Establish state version/migrations, compatibility checks and rollback limits; provider reconciliation remains explicit after restore. Document exact operator procedures. | MA-005 |
| **MA-007 · in progress** | Public alpha artifacts · [vision](../../design/vision.md), [security](../../design/security.md), [engineering](../../design/engineering-principles.md) | Choose license/repository/package/image names and maintenance contact. Add license, security/support policy, contribution guide, changelog, explicit package contents and versioned release workflow. Hosted CI and installation from packed CLI/released image pass. Review public source/history/artifacts for private material and dependency/image issues. Archive original incident evidence and related historical records unchanged outside the public tree; create a separate sanitized acceptance summary and verify active public links. README advertises only qualified support. | MA-001–MA-006 |

## B · Qualified MCP beta

Scope: real configured MCP workflows and a published endpoint capability matrix. Beta requires milestone A and both items below.

| ID / status | Work and design source | Completion criteria | Depends on |
| --- | --- | --- | --- |
| **MA-008 · in progress** | Live MCP acceptance · [architecture](../../design/architecture.md), [security](../../design/security.md) | Real model/SDK/MCP journey performs a synthetic read, rejects a forbidden tool, waits for exact local approval, completes one synthetic write and survives restart. Failed/interrupted effects, tool-result injection, schemas and scoped resources have recorded outcomes. Use a dedicated test adapter, not business records. | MA-004, MA-006 |
| **MA-009 · in progress** | Endpoint and recipe qualification · [features](../../design/features.md), [configuration](../../design/configuration.md) | Qualify text and tool behavior at two independently hosted endpoints; resolve model alias identity, record capability/failure matrix and evaluate representative text tasks. Unsupported capabilities fail visibly. Publish beta artifacts only after both MCP and endpoint acceptance. | MA-007, MA-008 |

## C · Document inbox and domain integrations

Scope: explicit qualified document and domain recipes; preserve the one-mailbox deployment boundary.

| ID / status | Work and design source | Completion criteria | Depends on |
| --- | --- | --- | --- |
| **MA-010 · in progress** | Bounded image intake/transcription · [features](../../design/features.md), [security](../../design/security.md), [image inbox](../../design/document-inbox.md) | Explicit capability/schema support, validated signatures/count/size, private expiring run artifacts and provenance. Representative images, missing/invalid inputs and model/processor failures have evaluated outputs; unsupported requests stay explicit. | MA-009 |
| **MA-011 · in progress** | Text attachment delivery · [architecture](../../design/architecture.md), [operations](../../design/operations.md), [delivery](../../design/attachment-delivery.md) | Enabled recipe declares required grants. Persist exact file/content/recipient intent; verify direct threaded recipient arrival with a `.txt` attachment, expiry, restart and uncertain-send recovery. No arbitrary tool paths/URLs are fetched. Document-inbox recipe installs and passes a whole-email evaluation. | MA-010 |
| **MA-012 · in progress** | PDF processor recipe · [features](../../design/features.md), [security](../../design/security.md), [processor](../../design/pdf-processor.md) | Explicit page/byte/time limits, isolated parser/rendering or reviewed MCP contract, provenance and failure cases. Searchable-PDF output is advertised only for a configured qualified processor; dependencies ship in a reproducible bundle. | MA-011 |
| **MA-013 · in progress** | Records/domain adapter recipe · [architecture](../../design/architecture.md), [security](../../design/security.md), [records contract](../../design/records-adapter.md) | Reviewed actor/visibility contract, authoritative records, optional coordination memory with deletion/provenance, exact governed writes, revision conflicts and adapter-specific reconciliation. Generic MCP authority cannot bypass domain approval. | MA-008, MA-006 |
