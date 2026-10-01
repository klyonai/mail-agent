# Bounded PDF processor

Desired MA-012 contract. [The roadmap](../docs/roadmap/ROADMAP.md) owns delivery;
this design does not enable PDF input in existing bundles.

## Recipe and authority

Accept exactly one non-inline PDF from an admitted direct sender. Reject mixed,
linked, incomplete, encrypted and unsupported inputs. Obtain a complete bounded
manifest before any content read; preserve recipient and authorization checks.
A qualified image model receives only validated PNG pages. Return existing text
or exact `.txt` output; searchable PDF needs separate processor qualification.

Schema 3 explicitly selects a qualified processor identity and limits. Schemas 1/2
still reject PDF; `model.capabilities.pdf` stays false because the model receives
images. Processing cannot grant tools, broader recipients or native PDF support.

## Bounds and provenance

Initial ceilings: one PDF of 5 MiB, 1–4 pages, candidate fixed 300 DPI, 5 MiB per PNG
and 10 MiB aggregate, twelve million pixels/page by default with a twenty-million
hard ceiling. Operators may lower limits. Process all pages or fail; never crop,
truncate or silently lower resolution. Header checks prove only format/byte bounds.

The trusted parent creates an opaque job ID. Version-1 request/response bind job,
source SHA-256, processor bundle digest, original expiry and strict limits. A
complete response declares page count/encryption and exactly pages 1 through N
as canonical base64 PNG. Validate encoded/decoded lengths, aggregate bytes,
signatures, dimensions and hashes before returning anything. Output is untrusted;
preserve source digest, page number and processor digest as provenance.

Use a separately bounded processor channel, not model-selected tools or a raised
global MCP result cap. Accept no paths/URLs. Keep the internal interface replaceable
by a reviewed local/service adapter. Missing production adapters fail closed;
there is no ordinary host subprocess fallback.

## Isolation and lifecycle

First candidate: pinned Poppler, isolated `pdfinfo` then sequential `pdftoppm`.
Both parsing/rendering use an immutable secret-free runtime root and private
per-job files; exclude mail state, credentials, host files and network egress.
Bundle required libraries, fixed fonts, notices/source obligations and checksums.

Candidate Linux profile: Bubblewrap plus worker-only cgroup, 512 MiB memory, zero
swap, one CPU, 16 tasks, 64 MiB scratch and ≤60 seconds within the run deadline.
These numbers require measurement. Give the mail container no Docker socket or
privileged/unconfined settings. If host isolation is unavailable, qualify an
independently deployed processor with equivalent controls.

Bound stdin/stdout/stderr. Validate one response only after successful termination
and resource release. Cancellation, expiry, overflow and deadline kill/reap the
owned worker tree and await quiescent resources. A separate process or adapter
promise does not prove isolation. Never log parser output/private bytes; use fixed
safe errors.

## Durable integration

Retain exact source PDF and derived pages privately under original run expiry.
Add `pdf-input` purpose and strict PDF handle; derived image handles bind source
digest, page number and processor digest rather than synthetic attachment IDs.
Publish source bytes before references, then all page references atomically.
Restart reuses exact bytes/pages and cumulative budgets, without substitution,
silent rerender or renewed retention.

The storage contract uses format-2 handles with explicit `pdf-input` or `pdf-page`
kind. Source handles bind the original message/attachment identifiers. PNG page
handles bind the source PDF artifact ID/digest, page number and processor digest;
all handles retain the same run ID and original expiry. Byte publication uses the
existing private filesystem boundary with trusted handle/provenance validators.
Legacy image/text validators and state/snapshot readers retain their existing
contracts. A staging API publishes no database references: the later schema-6
integration commits the complete source/page set atomically. Partial staging
returns no usable page set and cleans only owned files; crash leftovers remain
private and require bounded orphan recovery. Standalone storage does not enable
PDF intake or claim schema-6/snapshot-3 support.

State schema 6/snapshot format 3 cover source/page parity, hashes, provenance,
retention and orphan cleanup. Preserve schema-5/format-2 and earlier contracts;
older binaries reject new state. Missing/corrupt/expired assets block inference
and delivery while preserving approvals, deduplication and uncertain effects.
Restore stays held for whole-window reconciliation.

## Qualification

Deterministic tests prove protocol bounds/identity, complete pages, invalid images,
encrypted/error responses, deadlines/cancellation, cleanup and sanitized errors.
They establish orchestration, not sandbox security. Separately qualify actual
Linux filesystem/network isolation, aggregate resource exhaustion, process kills,
malformed PDFs and representative rendering with the pinned bundle. Then qualify
Graph intake, model quality/injection, arrival, restart/retention and backup/restore.
No PDF support claim precedes those gates.
