# Features

Desired state · 2026-10-01. The [roadmap](../docs/roadmap/ROADMAP.md) owns delivery order and status; [implementation evidence](../docs/implementation.md) records what works today.

| Capability | Desired behavior | Acceptance contract |
| --- | --- | --- |
| Setup and diagnostics | Guided and noninteractive bundle creation; offline/live diagnostics with corrective steps | A new operator completes setup and a controlled real email journey using the guide; probes distinguish connectivity, authority and delivery |
| Text inbox | Authenticated direct requests receive honest threaded text replies | Separate sender intake and recipient arrival, follow-ups, denied requests, dependency failures and restart/replay |
| Configured inference | OpenAI-compatible endpoint, explicit capability profile, ordered Markdown instructions | Text and tool behavior qualified at two independently hosted endpoints; unsupported capabilities fail visibly |
| Isolation | One mailbox per process/container, private credentials, connections and state | Concurrent ownership denied; a second deployment operates independently |
| Durable execution | Bounded runs, exact approvals, retention, outbox and uncertain-effect reconciliation | Crashes, outages, cancellation, revoked policy, expiry and restore preserve effect fences |
| Optional MCP | Reviewed read/write tools, explicit resource scope, bounded automatic writes or exact approval | Real inference and MCP read/approved-write journeys; denied tools and interrupted writes remain contained |
| Operations | Structured status, local health, safe read backoff, backup/restore and upgrades | Operators identify stale intake and pending work; outage, credential rotation and upgrade drills preserve state |
| Public distribution | GitHub source at `klyonai/mail-agent` and versioned Docker image intended for `ghcr.io/klyonai/mail-agent`, under MIT; CLI package remains optional/private unless separately approved | Clean installation from released artifacts, hosted CI, private-data review, verified private security reporting route, and published `0.1.x`/Node 24 best-effort maintenance policy |
| Image document inbox | Bounded images transcribed with provenance; text returned as an attachment | Representative documents, missing/invalid inputs, output recipients, expiry and uncertain delivery |
| PDF and records recipes | Bounded PDF processing; domain memory and governed changes through adapters | Page/parser limits and processor failures; adapter visibility, revision conflicts, approvals and deletion |

Unsupported requests from authenticated authorized senders receive a safe explanation through a separate deterministic response path. Unknown, unauthenticated and automatic mail stays silent. Unsupported attachment bodies are never sent to inference. Inline mail artifacts and actual document requests need explicit classification.

For the text recipe, classify discovered inline artifacts and non-inline documents separately but treat both as unsupported. Inline flags and MIME types alone cannot establish that a file is a harmless signature. Probe metadata only after identity and recipient authorization; metadata failures must not permit inference. Future recipes may admit verified artifacts under their own validation contract.

Synthetic checks establish software behavior; live journeys establish observed transport/tool behavior; recipe evaluations measure task quality. Record these separately and never infer general assurance from three successful examples.

Controlled dependency failures in an acceptance journey must identify the injected
boundary and distinguish it from an observed provider outage. A model-only fault
must preserve normal mailbox authorization, delivery and restart fences, verify
the deterministic failure reply, and establish that replay adds no model attempt.

Text acceptance includes a real threaded follow-up, a bounded clarification for
missing document/recipient details, and sender-policy denial. A follow-up sent
with delegated `Mail.Send` may use validated MIME reply headers and the agent's
scoped Sent Items metadata; acceptance requires observed conversation identity,
each expected reply once, and preserved history across restart. MIME submission
alone does not prove threading or delivery. A denial drill narrows only the
suite's private policy copy, verifies an ignored run with zero effects, and
preserves that terminal decision after restart and policy restoration. It does
not establish tenant grant scope or resistance to forged transport headers.

CC-only intake, reply-all, verified email approvals, public HTTP health, webhooks/backfill, scheduling and richer administration are optional future extensions requiring their own contracts. Multiple agents in one daemon, distributed workers and autonomous instruction editing are outside this target. Durable knowledge and searchable-PDF generation are processor/MCP capabilities, not mandatory core services.
