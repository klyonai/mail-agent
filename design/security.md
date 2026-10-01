# Security

Mail Agent is a single-mailbox process or container with private credentials, durable state, instructions, and MCP connections. Mail content, attachments, external research, and tool results are untrusted input. Instructions and model output cannot grant permissions.

Desired state · 2026-10-01. See [the roadmap](../docs/roadmap/ROADMAP.md) for delivery and [implementation evidence](../docs/implementation.md) for current assurance.

## Authorization

- Admit a sender only when its address is allowed and the configured transport-authentication policy succeeds. The administrator must verify that trusted authentication headers cannot be forged or duplicated by senders. Setup guidance must explain this verification and preserve the administrator's explicit decision; a doctor may report that verification is missing but must never enable it automatically.
- Scope Microsoft Graph application access to the dedicated mailbox. Explain the independent Entra grants and Exchange application RBAC controls, and provide a way to verify both allowed and denied mailbox access. Setup and diagnostics must not request new directory or runtime grants. Use the existing authorization to check the mailbox and explain any insufficient-permission result.
- Keep sender admission, recipient disclosure, resource visibility, and change authority as separate decisions. Check current policy before every read, tool action, approval continuation, and send. Tool annotations and prompt instructions do not establish authority.
- Deny tools by default. Reads require authorized resource visibility and approved data destinations. Mutations require exact approval or a bounded operator-granted capability. Bind approvals to the actor, tool, canonical arguments, target revision, policy version, and expiry; recheck authority before execution. Unknown effects require review.
- Direct replies may include only authorized recipients. Recheck disclosure policy when adding recipients. Suppress automatic messages, self-mail, bounces, and loops. Never reveal hidden resource names in refusals.

Choose one explicit transport profile: trusted DMARC results (`exchange-authenticated`) or same-tenant Exchange submission (`exchange-internal`). Require equal sender/from addresses and unambiguous trusted results; the internal profile also requires configured domains and tenant, Internal authentication, Hosted origin and Originating direction. There is no fallback between profiles. Administrator verification covers connectors and header protection; legitimate observed headers do not establish general trust. Domain authentication alone does not prove a particular person's identity.

Local approval commands rely on host access control; an operator-supplied actor address is an audit attribution, not independent email authentication. Verified email approvals require a separate identity/control contract. Automatic writes require schema-enforced argument/target bounds and scoped credentials. Domain adapters enforce governed approvals and revision checks; generic capabilities cannot override them.

## Data, artifacts, and effects

- Keep raw mail, extracted text, attachments, model context, tool results, credentials, and runtime state in private storage with configured retention. Audit records should retain only the identifiers, decisions, hashes, actors, and outcomes needed for review.
- Attachments and generated artifacts are untrusted. Enforce file type signatures, count, byte and page limits, parser time/resource bounds, isolated parsing, and expiration. Restrict filesystem paths and network egress. Send extracted or generated content only to explicitly approved destinations; show the destination and disclosure scope before an approval-bound action.
- Generic MCP connections share the configured resource scope among this deployment's admitted senders. Use separate deployments or a domain adapter when visibility differs by sender. Credentials must be restricted to the scope authorized for every admitted sender.
- Persist external effects before execution. Never blindly retry uncertain writes or sends. Preserve an action fence until an operator reconciles the outcome against authoritative provider or adapter evidence.
- Restore only private snapshots with trusted provenance, matching identity and a supported schema. Reject unexpected database objects before migrations or writes, disable trusted-schema execution, and verify the recovery hold after persistence. A checksum detects corruption, not authorship; restoring must never grant new authority or erase an earlier unresolved recovery window.

MCP stdio commands are reviewed and pinned, receive only an explicit environment allowlist, and run within the deployment's OS permissions. Remote endpoints require approved transport, scoped authentication and bounded discovery/redirect behavior. Installing a recipe never runs an unreviewed server or implicitly grants permissions.

## Setup, diagnostics, and release

- A setup doctor should inspect configuration and dependency reachability with bounded calls, use read-only checks by default, and avoid sending messages or changing tenant settings. It should report stable, sanitized diagnostic codes and actionable next steps, never provider response bodies, tokens, secrets, raw mail, or attachment contents.
- Security guidance must document required permissions, trust assumptions, data destinations, retention, backup and restore, and the limits of each verification. A failed permission check should identify the affected operation without asking for broad directory or runtime grants.
- Publish a security reporting contact and supported-version policy with every public release. The release artifact must exclude credentials, local state, private configuration, live test reports, raw customer content, and environment-specific incident evidence.
- Preserve original incident evidence and related historical records unchanged in a private archive outside the public tree. Publish a separate sanitized product acceptance summary and verify public references. Archiving preserves evidence; publication does not require rewriting or exposing the original.
- Pin dependencies and the lockfile. Review security advisories and dependency updates through a documented process, and include the supported Node and container versions in release notes.
- Review all shipped container packages, including tools bundled with the base runtime. Remove unused package managers after build-time installation. Scan the exact final image for every published platform; retain advisory provenance and scoped applicability decisions. A lockfile audit or base-only comparison cannot establish final-image assurance.

The mailbox must not admit requests attributed to its own address, even if it appears in an allowlist. This prevents replies becoming new requests. Controlled acceptance uses a separate sender; tests must not bypass production identity gates.
