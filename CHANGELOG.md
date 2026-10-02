# Changelog

This file records product changes at candidate preparation on 2026-10-03; it is
not a release announcement. [GitHub releases](https://github.com/klyonai/mail-agent/releases)
record published versions and their exact-artifact qualification.

## Unreleased · internal 0.1.4 candidate

This version refreshes the shipped operator documentation to match the accepted
threat-model scope and adds an adversarial-model enforcement regression. Runtime
behavior is unchanged; the separately recorded scope decision amends MA-004.

### Supported baseline

- One mailbox per process/container, text email, bounded processing, sender and
  recipient policy, local approvals, durable effect fences and operator-managed
  recovery.
- Guided and scripted setup, offline/live diagnosis, operational status and a
  non-root Linux container.
- Optional MCP and document/records/PDF workflows remain experimental or
  unqualified; they are not part of the supported text baseline.

### Recorded qualification and limits

- The exact private v0.1.3 package and Linux amd64 image passed their recorded
  installation and operational qualification. Image operations used amd64
  emulation on an arm64 host; native operational qualification and arm64 support
  were not established.
- The v0.1.3 image scan retained 0 Critical, 7 High matches across four CVEs,
  and 27 total findings. Vulnerable code remains present, including bundled
  Node code; indirect-call uncertainty remains. This is not a clean-image claim.
- Live text acceptance recorded independent arrival for five replies and one
  injected SDK 503 case. The 503 is a controlled failure, not an actual provider
  outage. Tenant/mailbox scope and sender outcomes were recorded; the revised
  MA-004 evidence audit verifies the criterion and closes that item.
- Microsoft 365 identity, mailbox and transport administration are accepted
  deployment assumptions. The administrator records acceptance of the selected
  profile. Bespoke header-forgery assurance and a Microsoft support response
  are not release gates; runtime admission checks are unchanged.

### 0.1.4 qualification remains pending

The shipped-doc update is a substantive package-content change. The 0.1.3 tag
and artifacts remain unchanged and are not reused. The 0.1.4 package and
version-bound image still require exact qualification. Final public source and
artifact review, explicit disposition of retained image findings, reporting and
support-route verification, publication approval and installation
from the artifacts actually released remain open.

These notes summarize implementation evidence; they do not imply public
availability or completed release acceptance. See [public acceptance](docs/public-acceptance.md).
