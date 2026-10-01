# First release acceptance

**Status: unreleased and incomplete.** This summary describes the current first-release evidence and the remaining release gates. In a source checkout, `docs/roadmap/ROADMAP.md` is the active delivery record and `docs/implementation.md` distinguishes delivered software from external qualification. Those development records are excluded from the installed package.

## Supported baseline

The first-release baseline is one mailbox, text email and a configured model endpoint. Setup, offline/live diagnostics, local approvals, durable processing, recovery, and operator health/status are implemented. Optional policy-controlled MCP remains experimental. Use the [quickstart](quickstart.md), [live sender setup](live-sender-setup.md), and [operations guide](operations.md) for current procedures.

Recorded integrated software checks on macOS with Node 24.21.0 include synthetic text scenarios. Exact check counts and candidate versions are recorded in the source-checkout implementation evidence. These checks do not establish live mailbox or model qualification. Bounded live text journeys verify real inference, clarification, a same-thread follow-up, sender-policy denial and no-effect replay. All five expected replies are observed separately in the independent test Inbox. The controlled service-failure explanation and no-retry replay are verified, but its original interception counter was not retained. These observations do not establish complete tenant scope or protected sender-authentication evidence. The opt-in live suite and evidence limits are described in [live tests](live-tests.md).

## Experimental work

One ordinary Office 365/real-model/stdio MCP journey verifies a scoped read, exact local approval across restart, one synthetic write/audit and a threaded reply observed in the recipient Inbox. A deterministic probe rejects a forbidden tool; the real model is not offered that tool. Live failed/interrupted effects and tenant dependencies remain open. MCP, image/document processing and delivery, PDF processing, and the folder-backed records adapter remain experimental and are not first-release qualification. PDF intake is not enabled as a qualified capability. No claim is made about real document quality or recipient delivery of attachments.

## Remaining release gates

- Complete controlled model-failure counter evidence, beyond the observed failure reply and replay fences.
- Obtain administrator evidence for all relevant application read/send grants and protected sender trust. Current ID-only reads allow the agent Inbox and deny the other test Inbox; neither those results nor successful delivery establish complete tenant scope.
- Freeze and review the current public source/history and exact release artifacts. Complete hosted CI, declared Linux platforms, residual image-advisory review and installation from published artifacts.
- MIT, `klyonai/mail-agent`, intended `ghcr.io/klyonai/mail-agent` and latest-patch `0.1.x` / Node 24 best-effort maintenance are selected. Confirm and verify a monitored private security route and support route, and complete the publishing procedure.

The [live acceptance guide](live-tests.md) and [manual evidence table](live-sender-setup.md#content-free-acceptance-evidence) define the bounded checks and content-free evidence to record. The package remains private until the release gates are complete.
