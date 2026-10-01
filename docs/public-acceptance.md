# First release acceptance

**Status: unreleased and incomplete.** This summary distinguishes delivered software, observed acceptance and remaining release gates. Source-only delivery records are `docs/roadmap/ROADMAP.md` and `docs/implementation.md`; they are excluded from the installed package.

## Supported baseline and observed acceptance

The first-release baseline is one mailbox, text email and a configured model endpoint. Setup, diagnostics, local approvals, durable processing, recovery and operator health/status are implemented. Optional MCP remains experimental. See the [quickstart](quickstart.md), [live sender setup](live-sender-setup.md) and [operations guide](operations.md).

Bounded live text journeys verify real inference, clarification, same-thread follow-up, denied-sender silence and no-effect replay. All five expected text replies were separately observed in the independent test Inbox. A fresh one-case controlled SDK 503 journey verifies one interception, zero upstream inference requests, one deterministic reply, unchanged restart/replay counters and independent recipient arrival. This is an injected failure, not an actual provider outage; the original missing counter remains unreconstructed.

The reviewed test-tenant application has scoped `Mail.Read` and `Mail.Send` roles with the sole agent mailbox in scope. No Entra administrator/user consent grants were observed for that application; effective reads and sends to the other test mailbox returned 403. Protected sender-header assurance remains open: a received Graph-MIME forgery normalized as unauthenticated, but its wrapper lacked the required control. One Internet SMTP forgery was submitted once and rejected with 450; it supplies no received-header proof. These results do not establish general header trust for a deployment.

## Private candidate qualification

The private `klyonai/mail-agent` repository exists. Hosted CI at source commit `6f166e3` passes **697 synthetic tests plus lint**. Manual candidate run `36911854152`, tagged `v0.1.0`, generated private package/image artifacts. Installation from the exact downloaded tarball passes executable/setup/offline/fixture/records checks, including MIT and **84 files, 23 documents and 75 local links**. Exact image identity/source-byte binding, offline non-root preview and schema-5 recovery pass. Local Linux amd64 image execution used emulation on an arm64 engine; native hosted Ubuntu source checks are separate evidence.

The exact amd64 image scan reports **0 Critical, 51 High matches across 13 CVEs, 155 total findings and zero npm findings**. It is not clean; residual advisory disposition remains open. No GitHub release or registry image has been published.

## Current minimal-runtime preparation

The newer private source at `294ef94` passes hosted Ubuntu lint/723 tests, installed package checks (84 files, 23 documents/76 links), image build, offline preview and MIT notice. Its separate local amd64 prototype passes private-volume initialization/repeated mounts, records/recovery/shutdown and synthetic loopback TLS; execution is emulated on arm64. This does not replace or extend the earlier versioned-artifact evidence.

The exact prototype scan retains **0 Critical, 7 High across four CVEs**, 27 total findings/zero npm matches. Complete native/source review also finds affected gzip-file functions bundled into Node; no invocation path was identified in the default text/shipped-records workload. Vulnerable code remains present. Scoped review retains indirect-call uncertainty, does not claim a clean image, and requires requalification of native extensions or changed runtime configuration. A new version-bound candidate and final review remain necessary.

Private `v0.1.1` at `2e5a9d4` passes hosted lint/723 tests, original archive/package/source verification and fresh installed package checks (84 files, 23 documents/76 links). Its exact image scan retains seven High findings and all native bytes match the prototype. Image qualification fails: `/state` is mode 0755 rather than required 0700, confirmed in the saved layer. Independent synthetic recovery/shutdown/TLS passes do not override this failure. The source now prepares state as a child directory and adds actual hosted permission checks; a rebuilt image must pass before further candidate qualification. Earlier tags/artifacts remain unchanged.

The repair at private source `249b14d` passes actual local image/Compose/two-volume-mount checks and hosted Ubuntu lint/724 tests, fresh packed installation (84 files, 23 documents/76 links), actual image permission assertions, preview and MIT notice. All state checks observe 1000:1000/0700. Internal `0.1.2` prepares a distinct private candidate containing this repair; its downloaded artifact qualification remains separate and pending.

Private `v0.1.2` at `2f99f83` passes original archive/package/image/source binding, fresh installation, actual 1000:1000/0700 state/Compose/repeated-volume checks, synthetic records/recovery/shutdown/TLS and matched native/OS/loader inventory. Its exact scan retains seven High findings; local image operations use emulation. Content review identifies missing Node upstream license text, separate from the project MIT notice. The repair at private source `1aa43c6` passes hosted Ubuntu lint/725 tests and actual notice/projectMIT/state checks, plus a separate locally emulated image check. Internal0.1.3 prepares a fresh candidate; its exact downloaded artifacts remain unqualified. Final release gates remain open.

## Experimental work

One ordinary Office 365/real-model/stdio MCP journey verifies a scoped read, exact local approval across restart, one synthetic write/audit and a threaded reply independently observed in the recipient Inbox. A deterministic policy probe rejects a forbidden tool; the real model is not offered that tool. Live failed/interrupted effects and dependency gates remain open. MCP, image/document processing, attachment delivery, PDF processing and the records recipe remain experimental. PDF intake is not enabled as a qualified capability; actual document quality and attachment arrival are unqualified.

## Remaining release gates

- Complete administrator protected-header verification and the remaining tenant acceptance against the deployment's actual trust boundary.
- Review the final public source/history and exact artifacts, declared Linux platforms and residual image advisories; qualify the artifacts actually published.
- MIT, `klyonai/mail-agent`, intended `ghcr.io/klyonai/mail-agent` and latest-patch `0.1.x` / Node 24 best-effort maintenance are selected. Confirm reporting/support routes and verify monitoring. [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) requires a public repository; if selected, obtain final source-visibility approval, then enable and verify reporting before the first release/image. A confirmed alternative private contact may satisfy this gate before visibility changes.

The [live acceptance guide](live-tests.md), [manual evidence table](live-sender-setup.md#content-free-acceptance-evidence), [support policy](support.md) and [release procedure](releasing.md) define the remaining bounded work. The package remains private until release gates are complete.
