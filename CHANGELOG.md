# Changelog

This file records product changes; it is not a release announcement. The package has internal version metadata `0.1.3` for a fresh private candidate. No public version has been released; the private `v0.1.0`, failed `v0.1.1`, and notice-incomplete `v0.1.2` artifacts remain unchanged.

## Unreleased · internal 0.1.3 candidate

### Added

- Single-mailbox text processing with bounded execution, sender and recipient policy, local approvals, and durable effect fences.
- Guided and scripted private setup, offline/live diagnostics, local operational status, and container deployment support.
- Stopped backup and fresh restore, explicit held-state reconciliation, and reviewed continuity or history-gap release procedures.
- Explicit package contents, packed installation qualification, a manual versioned candidate workflow, and contribution/security/support guidance.
- Bounded offline verification and an operator runbook for promoting the exact qualified artifacts without rebuilding or repacking.

### Observed acceptance

- Text clarification, same-thread follow-up, denied-sender silence, replay without repeated effects and five replies observed in the independent test Inbox. A separate injected SDK 503 case verifies its failure reply, counters, replay and recipient arrival.
- Existing test-tenant application read/send scope and effective denial outside the agent mailbox; this does not establish protected-header trust.
- Private source/history preservation, hosted Ubuntu lint/724 tests, packed installation and image preview for the recorded source. The subsequent Node-notice repair passes hosted Ubuntu lint/725 tests at source `1aa43c6`, with zero failures, skips, or cancellations. MIT, repository/image identities and latest-patch `0.1.x` / Node 24 best-effort maintenance are selected.
- An ordinary real-model/email/MCP journey with one exact approved synthetic write and recipient arrival. MCP and document/records recipes remain experimental.

### Changed

- Node runtime floor is 24.21.0; the Linux base image is pinned by version and digest.
- The runtime stage contains the reviewed Node binary, application and required native libraries/trust data; shell, npm and build tools stay in the build stage. State is copied as a child of a prepared runtime-root directory; local Compose initialization and repeated mounts verify owner-only mode 0700, and hosted workflows now gate on actual image ownership/type/mode.
- The pinned Node upstream license notice is copied separately from the project MIT notice; hosted workflows verify its expected size and SHA-256 before preview or artifact creation.
- CLI execution recognizes npm symlinks and canonical paths; setup emits commands runnable from the installed consumer directory.
- Fixture read/JSON failures use fixed errors without echoing private filenames or malformed content.
- Exact minimal-image inventory retains fourteen OS packages. Its scan reports zero Critical, seven High across four CVEs and zero npm matches. Signed Node source and exact native review identify no triggering gzip-file API path in the default text/shipped-records workload; affected code remains compiled, indirect-call uncertainty remains, and added native adapters need requalification.

### Qualification still open

- Administrator protected transport-header verification; the received Graph-MIME probe and rejected Internet SMTP probe remain inconclusive.
- New `0.1.3` version-bound package/image qualification remains pending; the earlier `v0.1.2` image omitted the Node notice and remains unchanged. Final source/artifact and scoped advisory review, declared platforms, verified reporting/support routes and monitoring, publication approval and released-artifact installation remain open. Earlier source/image evidence does not qualify new artifact bytes.
- MCP beta dependency gates, independent model endpoint qualification, actual document quality/attachment arrival and isolated PDF processing before broader capability claims.

These entries summarize current implementation evidence. See [public acceptance](docs/public-acceptance.md); they do not imply public availability or completed release acceptance. Source-checkout delivery state and detailed evidence remain in `docs/roadmap/ROADMAP.md` and `docs/implementation.md`.
