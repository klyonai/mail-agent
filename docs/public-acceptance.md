# First release acceptance

**Candidate preparation snapshot · 2026-10-03: unreleased and incomplete.** The internal 0.1.4 package and
version-bound image are pending qualification. No public source release or
container image has been published at this snapshot. The corresponding
[GitHub release](https://github.com/klyonai/mail-agent/releases) must record
subsequent exact-artifact qualification, publication and installed-release
verification. This preparation snapshot is not evidence of those later gates.

## Supported baseline

The supported target is one Microsoft 365 mailbox per process or container,
text email and a configured model endpoint. Setup, diagnostics, local approvals,
durable processing, operator status and recovery are implemented. See the
[quickstart](quickstart.md), [Microsoft 365 setup](microsoft-365-setup.md),
[operations guide](operations.md) and [support policy](support.md).

Optional MCP and document, records, image and PDF workflows remain experimental
or unqualified. They are not represented as part of the supported text baseline.

## Observed acceptance

Bounded live text journeys recorded real inference, clarification, same-thread
follow-up, denied-sender silence and replay without repeated effects. Five
expected replies were separately observed in the independent test Inbox. A
separate injected SDK 503 case verified one intercepted request, a deterministic
reply, unchanged restart/replay counters and recipient arrival. The injected
failure is not evidence of an actual provider outage.

The reviewed test deployment recorded scoped `Mail.Read` and `Mail.Send`, the
agent mailbox as the sole in-scope mailbox, no observed Entra administrator or
user consent grants, and denied reads and sends to the other test mailbox.
Correct Microsoft 365 identity, mailbox and transport administration are
deployment assumptions. The administrator accepts the selected authentication
profile and records that decision. Bespoke header-forgery testing and Microsoft
support are not product-acceptance requirements. Runtime admission checks are
unchanged. Qualification focuses on malicious content in legitimate requests. The text
acceptance audit verifies the revised sender/tenant criterion. A deterministic
adversarial-model regression separately confirms that forbidden effects and
recipient/policy overrides are blocked by the runtime, with no new live mail.

## Latest exact artifact qualification

The private v0.1.3 package and Linux amd64 image passed their recorded
installation and operational checks. The source, package and image were bound to
the same reviewed candidate. Image operations ran under amd64 emulation on an
arm64 host; native image-operation qualification and arm64 support were not
established.

The exact image scan reported 0 Critical, 7 High matches across four CVEs, and
27 total findings. Vulnerable code remains present, including code bundled into
Node; indirect-call uncertainty remains. The assessment identified no triggering
path in the default text and shipped-records workload, but does not establish a
clean image or formal unreachability.

The v0.1.3 package's shipped operator documents predate the accepted scope
update. Those immutable artifacts remain unchanged and are not reused for 0.1.4.
The 0.1.4 package and version-bound image require their own qualification. No
previous package or image result automatically qualifies changed artifact bytes.

## Remaining release gates

- Review the exact 0.1.4 source, package and image; confirm shipped documents,
  declared platform and public source/history content.
- Explicitly decide whether the retained image findings and scoped uncertainty
  are acceptable for the intended alpha or require a runtime repair.
- Obtain approval for repository visibility. Then verify GitHub private
  vulnerability reporting and Issues availability and maintainer monitoring.
  Verify GHCR publishing access and the exact release notes.
- Approve the exact candidate manifest and the distinct repository-visibility,
  GHCR-visibility, image-push and GitHub-release actions. Verify installation
  from the artifacts actually released.

The [live acceptance procedure](live-tests.md), [manual evidence table](live-sender-setup.md#content-free-acceptance-evidence),
[support policy](support.md) and [release procedure](releasing.md) describe the
bounded operator work. Public publication remains unapproved.
