# Mail Agent roadmap

**Sanitized current source review · 2026-10-01 · unreleased.** This copy records the current selected source delivery state. Original dated evidence and operational records are retained privately and unchanged. Omission does not waive acceptance. [Implementation evidence](../implementation.md) and [public acceptance](../public-acceptance.md) separate software checks, live observations and remaining release gates.

## Current progress

**5/13 items are done; milestone A is 5/7.** All thirteen current status, acceptance and dependency rows below are preserved unchanged. The selected source version passed **696 synthetic tests plus lint** on macOS Node 24.21.0. Fresh packed installation passed with **84 files, 645,719 unpacked bytes**, **23 documents and 75 resolving local links**, including MIT. These checks do not establish hosted CI, current Linux/image qualification or publication.

All five recorded text replies were separately observed in the independent recipient Inbox. One ordinary Office 365/real-model/stdio MCP journey performed a scoped read, exact approval surviving restart, one confirmed synthetic write/audit and a threaded reply independently observed in the recipient Inbox, with zero-effect replay. Controlled failure counter completeness, all relevant tenant grants/send scope and protected-header administrator evidence remain open. Live failed/interrupted MCP effects remain distinct from earlier synthetic mail and caller-crash evidence.

MIT, `klyonai/mail-agent`, intended `ghcr.io/klyonai/mail-agent` and latest-patch `0.1.x` / qualified Node 24 best-effort support are selected. Reporting/support routes require confirmation and verification. The package is private and no public artifact has been released. Earlier Linux arm64/image evidence qualifies its recorded 694-test version; the exact image retains 0 Critical and 51 High matches across 13 CVEs. It does not qualify this current exported source.

## Delivery order and remaining gates

1. Complete MA-004 controlled-failure counter evidence and administrator grant/send/header checks with bounded test accounts.
2. Complete current selected source/history/artifact review, hosted CI, declared Linux platforms and exact image advisory review for MA-007. Confirm reporting routes and publish only after milestone A acceptance and final publication review.
3. Complete live MCP failed/interrupted effects and independent endpoint B for beta. Experimental MCP support is not beta acceptance.
4. Qualify image, attachment, PDF and records recipes against their criteria. PDF intake remains disabled until processor/isolation/recovery/quality gates pass.

Dependencies are completion gates. Synthetic tests, live journeys, recipe quality and release qualification are distinct evidence. Historical records remain immutable; changing an unmet criterion requires a recorded design decision. Current source review is not privacy certification or release readiness.

## A · Installable text-inbox alpha

Scope: one mailbox per deployment, direct text replies and operator installation. Optional MCP is experimental; no document support is advertised. Public alpha requires MA-001–MA-007.

| ID / status | Work and design source | Completion criteria | Depends on |
| --- | --- | --- | --- |
| **MA-001 · done** | Diagnostics · [experience](../../design/experience.md), [security](../../design/security.md) | Offline `doctor` is network-free; explicit live probes send no mail/mutations. Human/JSON results distinguish pass/fail/not-checked, placeholder/secret/state problems, credential/access/mailbox/connectivity/throttling/model failures and safe corrective steps. Required failures exit nonzero; existing `check` contracts remain compatible. | — |
| **MA-002 · done** | Guided setup and administrator guide · [configuration](../../design/configuration.md), [experience](../../design/experience.md) | Guided/noninteractive `init` share validation, use safe defaults, write atomically, refuse overwrite and show exact next steps. Secrets stay external; transport verification stays an administrator decision. A fresh operator completes container setup using only the quickstart and scoped tenant guide. | MA-001 |
| **MA-003 · done** | Unsupported-request experience · [features](../../design/features.md), [architecture](../../design/architecture.md) | Separate identity/recipient authorization from format support. Authorized unsupported requests get one bounded deterministic explanation without inference/tools/attachment contents; unknown, unauthenticated and automatic mail stays silent. Inline artifacts vs document inputs have explicit classification. Recipient gates, loops, deduplication and fences hold. | MA-001 |
| **MA-004 · in progress** | Live text and tenant qualification · [features](../../design/features.md), [security](../../design/security.md) | Verify separate recipient arrival, follow-ups, ambiguous requests, unavailable services and quoted injection cases. Record allowed/denied sender and mailbox access plus administrator verification of protected authentication headers. Acceptance command declares bounded synthetic effects and produces a redacted report; no broader agent grants are introduced merely for testing. | MA-002, MA-003 |
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

