# Engineering principles

Desired engineering contract · 2026-10-01.

## Design and delivery

`design/` is the desired state. [The roadmap](../docs/roadmap/ROADMAP.md) derives ordered work and acceptance criteria from it. [Implementation evidence](../docs/implementation.md) records delivered behavior; dated evidence and `docs/roadmap/history/` preserve what was observed or decided.

Before implementation, select a roadmap item and confirm its design contract. Complete its acceptance work, record evidence and update status together. Code completion alone does not satisfy a live qualification or release gate.

When evidence exposes a roadblock, record the failed assumption, impact, dependency and next action on the affected item. If the target must change, update the relevant design first, record a dated decision with reason and consequences, then revise roadmap scope/dependencies. Preserve prior evidence. A workaround that changes supported behavior, authority, deployment or recovery guarantees requires the same process.

Keep one active roadmap and stable item IDs. Do not maintain competing delivery lists in design or release proposals. Refer unresolved product decisions to the operator; never mark missing external acceptance complete.

Plan and deliver coherent capability batches. Give parallel workers explicit file
and interface ownership, integrate once, and run the full check at that boundary.
Focused regression tests accompany behavior changes; repeated broad qualification
belongs to a changed contract or release candidate. Refactor only where required
to deliver the selected acceptance criteria or fix a demonstrated defect.

Keep one implementation batch active. Plan only its acceptance steps, interfaces
and ownership before coding; defer independent future capabilities to the roadmap.
Use available agent slots for disjoint implementation or bounded review. Integrate
shared contracts before their consumers. Do not expand a batch because a future
capability could use the same module. Record check duration before treating tests
as the throughput bottleneck. Consolidate evidence at the batch boundary and
update current progress when an acceptance step is delivered.
Resolve bounded integration review and freeze shipped files before the final full
check and packed-install qualification. Reopen that boundary only for a material
defect or changed contract.

Allocate parallel workers to the earliest release milestone before extending later
features. When that milestone awaits external inputs, finish an already active
batch and prepare the exact qualification handoff; do not continually grow future
features to fill available slots. Use one bounded integration review, focused
checks during implementation and one full check per frozen batch. Repeat package
qualification when shipped contents or installation contracts change.

Progress reports show completed acceptance steps and remaining dependencies within
open items. Keep implementation progress separate from live and release gates;
an unchanged milestone count must not hide delivered work. Any percentage is a
labeled estimate, never evidence that an acceptance criterion passed.

## Implementation

Use a small Node.js ESM codebase with explicit modules for lifecycle, mail, model, MCP, policy, artifacts, and durable execution. Keep domain behavior in recipes and adapters. Build one mailbox runtime and CLI; expose library interfaces only for identified consumers.

Reuse the Vercel AI SDK behind the inference interface and the official MCP SDK behind the connector interface. Mail Agent owns durable execution, policy and recovery. Pin dependencies; SDK adoption does not transfer approval authority or guarantee exactly-once effects. Record synthetic, live dependency and recipe quality evidence separately.

- **One authority per decision:** policy owns admission; domain adapters own business truth; the runtime owns execution state and queue processing. Keep credentials and configuration explicit and injectable.
- **Deterministic boundaries:** inject clocks, fetchers, command runners, roots, and adapters. Synthetic fixtures replace customer mail and documents.
- **One inspectable loop:** requests are bounded runs; conversations are serialized requests with selected history. Normalize provider replies and tool calls into small validated types. Runtime status is authoritative; model prose is never evidence of execution.
- **Tests before behavior changes:** cover denied access, scoped storage/MCP credentials, bounded queue processing, malformed tools/files, recipient changes, stale approvals, concurrent intake, and crashes around external actions. Run focused tests and the full check before implementation handoff.
- **Explicit compatibility:** pin dependencies and protocol versions. Validate configuration schemas and negotiate capabilities; unsupported behavior fails visibly.
- **Small functions:** cap cyclomatic complexity at 12 without new suppressions. Prefer plain Node APIs and the official MCP SDK where it reduces protocol risk.
- **Honest execution:** claim a write only after its confirmed result. Distinguish model reasoning, attempted actions, accepted sends, and uncertain outcomes.
- **Portable delivery:** customer-like Linux checks need no developer paths, live accounts, or optional native utilities. Document and package every required processor.
- **One setup contract:** guided input, noninteractive configuration, runtime validation and diagnostics share schemas and adapter interfaces. Safe defaults reduce ordinary configuration; explicit policy retains authority.
- **Release as a maintained artifact:** verify the packed CLI and versioned image, document supported capabilities and state migrations, and maintain dependency/security updates. Public artifacts contain product evidence rather than private operational narratives.

Runtime support has a reviewed patch floor, rather than accepting every release in a major line. Keep package engines, lockfile, CI and the digest-pinned container consistent with that floor. Qualify a security update before advertising it; preserve earlier qualification records without extending their claims to the newer runtime.

Shipped documentation must resolve its local links inside the installed artifact. Identify source-checkout-only commands and development records explicitly; never include private history to repair an installed link.

Release evidence includes contract tests, synthetic whole-email journeys, opt-in live Graph/MCP checks, and recipe quality evaluations. Track critical invariants and failure recovery rather than treating coverage percentage as proof. Keep customer configuration, credentials, state, and generated documents out of source control.
