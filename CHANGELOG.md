# Changelog

This file records product changes; it is not a release announcement. The package currently has internal version metadata `0.1.0` and remains private. No public version has been released.

## Unreleased · private pre-release

### Added

- Single-mailbox text processing with bounded execution, sender and recipient policy, local approvals, and durable effect fences.
- Guided and scripted private setup, offline/live diagnostics, local operational status, and container deployment support.
- Stopped backup and fresh restore, explicit held-state reconciliation, and reviewed continuity or history-gap release procedures.
- Explicit package contents, packed installation qualification, a manual versioned candidate workflow, and contribution/security/support guidance.

### Changed

- Node runtime floor is 24.21.0; the Linux base image is pinned by version and digest.
- CLI execution recognizes npm symlinks and canonical paths; setup emits commands runnable from the installed consumer directory.

### Qualification still open

- Independent recipient arrival, mailbox permission scope, protected transport-header verification, and broader live text acceptance.
- Public repository/package/image identity, license, security and maintenance contacts, supported-version policy, hosted CI execution, source/history privacy review, OS-image security review and released-artifact qualification.
- MCP tool effects and additional model endpoint qualification before any MCP beta claim.

These entries summarize current implementation evidence. See [public acceptance](docs/public-acceptance.md); they do not imply public availability or completed release acceptance. Source-checkout delivery state and detailed evidence remain in `docs/roadmap/ROADMAP.md` and `docs/implementation.md`.
