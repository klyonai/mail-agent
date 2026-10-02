# Experience

Desired customer and operator experience for one isolated mailbox agent. These are target contracts; command behavior marked **Target** may not be implemented yet. For delivered behavior and evidence, see [implementation](../docs/implementation.md) and the [delivery roadmap](../docs/roadmap/ROADMAP.md).

## Setup and readiness

The primary deployment path is a non-root Linux container. The CLI is supported for local development, controlled operation, and environments that manage the process directly. Each deployment owns one mailbox, its bundle, credentials, MCP connections, and private durable state. Additional mailboxes use independent deployments.

`init` creates a text-inbox bundle without overwriting existing files. Explicit `--interactive` guided setup collects mailbox and model connection details, sender and recipient policy, and secret variable names; validates the bundle before writing; and prints the exact next steps. A noninteractive form accepts the same values for scripted and container deployments. Generated examples must be visibly inert. Setup explains Microsoft authorization and the selected transport profile's deployment assumptions. An administrator accepts those assumptions explicitly; setup never infers that acceptance from entered values. Routine deployment requires no Microsoft support ticket or bespoke header-forgery qualification.

`doctor` is the readiness command. Offline mode checks configuration, instruction files, placeholders, policy consistency, secret-variable presence by name, and state-root permissions without contacting services. Live mode explicitly lists and probes the configured Graph, model, and MCP dependencies. Each result is `pass`, `fail`, or `not checked`, with a safe remediation. It never prints secret values or provider response bodies. Live checks send no email and perform no external mutations. A successful probe does not prove sender authentication, tenant permission scope, model quality, or delivered email; those need controlled acceptance checks.

`doctor --config FILE` exposes structured offline results; `--live` adds explicit dependency probes and `--json` supports automation. The compatible `check --config FILE` and `check --live --config FILE` commands retain their narrower validation/probe contracts. `preview` runs deterministic synthetic mail/model/MCP adapters without live credentials, contacts, or email delivery. It demonstrates software behavior, not model quality.

## Mail and operator journeys

The initial mailbox journey accepts authenticated, allowlisted direct requests and replies in the same thread to the sender, subject to recipient policy. Existing messages are not processed when the first synchronization baseline is established. Operators can observe baseline progress and know when new-message intake is active. An authenticated authorized request for an unsupported capability receives one bounded deterministic explanation without inference or tools, subject to recipient policy. Unauthorized, unauthenticated and automatic mail receives no reply and reaches neither inference nor tools; safe operational metadata may record the rejection.

Attachments, CC-only intake, reply-all, email approvals, and file delivery require separate permission and acceptance contracts before they are advertised. The current text recipe does not process attachments.

Operators inspect readiness, dependency state, runs, and pending approvals locally. An approval identifies the exact proposed action, eligible actor, reason, expiry, and result. Recovery of an uncertain send or tool write requires evidence from the relevant provider or adapter; operators must not guess or trigger an automatic retry. Current `status`, `approvals`, `approve`, and `resolve` are local CLI controls. **Target:** structured status and health views make the same state understandable without exposing private content.

Policy and instruction edits take effect only after validation. Current authority is rechecked before subsequent actions; connection, mailbox, storage, budget, and retention changes require restart. Setup and operations documentation must explain these boundaries in the commands and files customers use.
