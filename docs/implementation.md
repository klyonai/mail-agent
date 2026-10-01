# Implementation evidence · 2026-10-01

**Sanitized current source review · unreleased.** The [design](../design/vision.md) owns desired behavior and the [roadmap](roadmap/ROADMAP.md) records delivery status. Original dated evidence is retained privately and unchanged. This summary contains product acceptance facts; excluded operational records do not imply completed acceptance.

## Delivered software

One Node 24 process serves one Microsoft 365 mailbox. The text runtime implements sender/recipient authorization, bounded thread context, immutable-message deduplication, durable delta checkpoints, exact local approvals, cumulative budgets, retention and uncertain-effect fences. Guided setup, private diagnostics, health/status, stopped backup/restore and reviewed recovery controls are implemented. The container runs without root. Optional MCP, document processing, attachment delivery and the records recipe remain experimental; PDF intake is not enabled as a qualified product capability.

## Current qualification

The source version selected for this review passed **696 synthetic tests plus lint** on macOS Node 24.21.0, with zero failures, skips or cancellations, in **11.967 seconds**. Fresh packed installation passed with **84 files, 645,719 unpacked bytes**, **23 Markdown documents and 75 resolving local links**, including the required MIT license and installed CLI/setup/fixture/records behavior. These results precede this separate source export; they do not claim a fresh check of the exported candidate.

Bounded text acceptance recorded six requests and five correctly addressed replies across arithmetic, quoted input, clarification, threaded follow-up, denied-sender silence and restart/replay. All five replies were separately observed in the independent recipient Inbox. A controlled service-failure reply and replay fence were observed; the original complete interception counter remains missing. ID-only application reads allowed the agent Inbox and denied the other test Inbox. These observations do not prove all tenant grants, send scope or protected sender-authentication headers.

One ordinary Office 365/real-model/stdio MCP journey passed in **25.231 seconds**, with **3 model calls, 2 tool calls, 1 write and 1 send**. It performed one injection-bearing read, exact local approval surviving restart, one confirmed synthetic write/audit and a threaded reply independently observed in the recipient Inbox. Restart/replay produced no new effects. A separate SDK preflight added one upstream model call. The forbidden-tool rejection was a deterministic policy probe; the real model was not offered that tool. Earlier controlled failures and genuine caller-process interruption used synthetic mail and do not replace live failed/interrupted-effect qualification.

An earlier recorded source version passed **694 synthetic tests plus lint** on Linux arm64 and fresh packed installation. Its private production image passed preview/recovery; its exact scan retained **0 Critical and 51 High matches across 13 CVEs**. This is earlier-version evidence, not current Linux/image qualification or a clean or published image.

## Release policy and remaining gates

MIT, [klyonai/mail-agent](https://github.com/klyonai/mail-agent), intended `ghcr.io/klyonai/mail-agent` and latest-patch `0.1.x` support on qualified Node 24 are selected. Maintenance and security fixes are best effort with no guaranteed response time. The package remains private; no public npm publication is requested. A monitored private security route and general support route still need confirmation and verification; see [support](support.md) and [security](../SECURITY.md).

MA-004 retains complete controlled-failure counter and administrator tenant/header gates. MA-007 retains current source/history/artifact review, hosted CI, final Linux platforms/image advisory disposition and publication gates. MA-008 retains live failure/interruption and MA-004 dependencies. Independent endpoint B and document/PDF/records recipe qualification remain open. See [public acceptance](public-acceptance.md) and the full [roadmap](roadmap/ROADMAP.md). This selected source review is not privacy certification or public release readiness.
