# Configuration and agent bundles

Desired configuration contract · 2026-10-01. Delivery state belongs in [the roadmap](../docs/roadmap/ROADMAP.md). The schema example below anchors compatibility with existing bundles; future behavior is specified separately, not implied by this example.

## Current supported configuration

The current schema is version 1. It configures one mailbox and one private state root per process or container. Additional mailboxes run as separate deployments. The version 1 example below describes the implemented text-inbox slice; it is not a future-ready schema and does not imply support for capabilities described in the target contract.

A bundle contains `agent.yaml`, a required `AGENT.md`, optional `SOUL.md`, and explicitly listed workflow files. Instructions provide purpose and procedures; they do not grant permissions. Paths resolve relative to the configuration file and must remain inside the bundle, including symlink targets. Secrets are environment references supplied separately. The current text recipe needs no MCP connection.

The schema rejects unknown fields and validates configuration before startup. Sender, recipient, tool, and approval policies remain distinct. Changing mailbox identity, connections, state location, limits, or retention requires restart. Policy and instruction edits are revalidated before external actions; invalid candidates fail closed and preserve the previous stored bundle.

The current supported recipe uses text input and direct replies. Images, PDFs, attachments, file delivery, CC-only intake, email approvals, and other future capabilities are not enabled by adding speculative configuration fields. See the [implementation guide](../docs/implementation.md) for current behavior and [the roadmap](../docs/roadmap/ROADMAP.md) for delivery status.

```yaml
schema_version: 1
id: text-inbox
state_root: ./state
mailbox:
  provider: microsoft-graph
  tenant_id: example-tenant
  client_id: example-application
  client_secret_env: INBOX_GRAPH_CLIENT_SECRET
  address: assistant@example.org
  intake: delta-poll
  delivery: direct-reply
  sender_authentication:
    mode: exchange-authenticated
    trusted_authserv_ids: [mx.example.org]
    transport_headers_verified: false
model:
  api: chat-completions
  base_url: https://models.example.org/v1
  api_key_env: INBOX_MODEL_API_KEY
  name: "<model-id>"
  capabilities: { tools: false, images: false, pdf: false }
instructions:
  agent: AGENT.md
  workflows: []
policy:
  senders: [alice@example.org]
  recipients: [alice@example.org, bob@example.org]
  approvers: []
  reply: sender
  tools: {}
mcp: {}
limits:
  active_runs: 1
  run_seconds: 120
  model_calls: 6
  tool_calls: 10
  context_tokens: 16384
  output_tokens: 2048
  queue_messages: 100
  attachment_bytes: 20000000
retention:
  content_hours: 24
  audit_days: 30
```

Replace example identities and endpoints. Set `transport_headers_verified: true` only after a mail administrator verifies protection of the trusted authentication headers. This field records that decision; it does not create trust. The adapter currently supports the global Microsoft cloud only. See the [authentication profiles](../README.md#microsoft-365-prerequisites).

## Target setup and lifecycle contract

Setup is guided and useful before credentials are available. Guided and noninteractive initialization use the same schema, safe defaults and complete candidate validation before atomic writes. Initialization refuses to overwrite existing files. Explain each required field, secret reference, permission and security assumption, and print exact next commands. Missing required inputs produce useful diagnostics; setup never invents identities, endpoints, authorization or administrator verification.

Validate the complete bundle in a private sibling staging directory, reserve a new target directory without replacing an existing path, and publish complete files exclusively. Publish `agent.yaml` last as the completion marker; before it exists, the target is incomplete and cannot be loaded. This provides atomic file visibility and a valid final configuration, rather than promising portable atomic replacement of an entire directory. Clean up only files and directories owned by the failed initializer. A process crash may leave an incomplete target that the operator must inspect and remove before trying again.

A doctor should validate the bundle offline first, then offer bounded read-only connectivity checks when requested. It should use existing configured credentials and permissions, make no mailbox writes, and never request new directory or runtime grants. Report stable sanitized diagnostic codes and recovery guidance, not provider bodies, secrets, or private message content. Transport-header trust remains an administrator decision and must not be changed by setup or diagnosis.

Configuration reloads should validate a complete candidate before replacing the active bundle. A failed candidate leaves the last valid bundle in force and blocks actions that depend on newly edited authority until policy is valid. Changes to identity, connections, state, budgets, and retention continue to require an explicit restart. Preserve one mailbox agent per process/container and its private state boundary.

Any future schema extension for artifacts or attachments must define supported formats, size/page limits, parser isolation and resource bounds, retention, filesystem/network restrictions, and approved destinations before enabling intake. Extracted or generated content must not be delivered to an unapproved destination. Until that contract is implemented and listed in the roadmap, the current version 1 text schema remains authoritative.

## Explicit document schema

Schema 2 defines the bounded [image inbox](document-inbox.md) and [transcript delivery](attachment-delivery.md) extension. Runtime integration and acceptance are tracked separately in MA-010/MA-011; schema acceptance alone is not endpoint qualification or proof of delivery. Schema 1 remains unchanged and rejects these fields. PDF capability remains unsupported in both versions.

Add the following to an otherwise complete one-mailbox bundle, and set `schema_version: 2`:

```yaml
model:
  # Keep the existing endpoint, secret reference, model name and API settings.
  capabilities: { tools: false, images: true, pdf: false }
  image_context_tokens: 8192
documents:
  images:
    enabled: true
    max_count: 4
    max_file_bytes: 5242880
    max_total_bytes: 10485760
    max_pixels: 12000000
  output:
    format: text-attachment
    filename: transcription.txt
    max_bytes: 262144
limits:
  context_tokens: 65536
```

This fragment is not a complete configuration. Preserve the existing model fields and other sections; do not replace them with the partial mappings above. Image enablement must match `model.capabilities.images`; capability declarations do not establish provider support. A disabled image recipe requires `images: false` and body-only `output.format: text`. Select `text` explicitly for body-only transcription or `text-attachment` for the separately governed transcript output. Generated filenames are fixed; mail/model/tool output cannot select paths, formats or recipients.

Image defaults and hard ceilings are four files, 5 MiB per file and 10 MiB in aggregate; the file ceiling must fit inside the aggregate ceiling. Pixel headers default to twelve million pixels with a twenty-million hard ceiling. Reduce these limits when the qualified endpoint supports less. Only structurally validated PNG and baseline JPEG documents are admitted; inline files, progressive/animated images, mixed unsupported formats and PDFs remain unsupported. Header inspection is not complete decoding. No mandatory local OCR processor is implied.

`model.image_context_tokens` reserves context per image separately from conservative textual byte accounting. Its default is 8192, with a minimum of 256; choose a value from endpoint qualification rather than deriving tokens from base64 length. Schema 2 defaults context to 65536, while schema 1 retains 16384. The maximum configured image count times the image reserve must leave room for output and instructions. An explicit smaller context requires a smaller count or a qualified reserve; oversized requests fail before inference rather than silently dropping images.

Transcript output defaults to 256 KiB and has a 2,000,000-byte hard ceiling aligned with the MIME reply adapter. UTF-8 must be valid, content nonempty and the filename exactly `transcription.txt`. Artifacts use the existing content retention period from original run admission; restart, approvals, outages and restore do not renew expiry. Persisted context stores scoped artifact references, then verifies and hydrates bytes only immediately before inference or delivery.

Artifacts live beneath the private state root with generated run/artifact identifiers and no arbitrary file/URL authority. Writes fsync files and new parent-directory publication before durable state refers to them. Ancestry checks reject foreign-owned, writable and arbitrary symlink parents; known root-owned macOS `/tmp` and `/var` aliases are resolved and verified. The runtime still requires exclusive ownership. Retention cleans only bounded, validated expired/retired references. After a known run expires, a separate bounded scan may clean unreferenced generated artifact directories, including partial writes, while protecting all live/retired reference IDs. This uses declared run/artifact expiry rather than filesystem modification times. Extra files, links or excessive entries fail closed; unknown runs require operator review. Maintenance must make sweep delay visible rather than promise instantaneous expiry. Backup/restore must include artifact references and bytes or fence missing work before this recipe is enabled. Changing schema, document limits/output, image reserve or retention requires a restart and compatibility review of pending work.

## MCP and recipe contract

The subsequent schema-3 PDF extension is specified in
[the processor contract](pdf-processor.md). It requires an explicit qualified
processor and versioned source/page storage; it is not accepted by schemas 1/2.

MCP is optional. Explicitly enable a qualified model's tools capability and configure only reviewed tools with independent effect, automatic/approval authority and argument constraints. Automatic writes require bounded targets/arguments; approval requires eligible local operators. An ordinary connection's dedicated credentials cover only the resource scope authorized for every admitted sender. Per-sender visibility and governed revision checks require a reviewed domain adapter or separate deployments.

Connections use authenticated Streamable HTTP or pinned stdio commands, explicit arguments and an environment allowlist. A pinned version declaration does not install or verify a server: provision its reviewed bundle separately. Model/MCP calls have deadlines and response bounds. HTTPS is required; explicit local HTTP is limited to loopback. An operator-approved secure private endpoint follows the same transport policy.

Trusted actor context is an explicit `actor_context: mail-agent-v1` opt-in for a reviewed stdio domain adapter. Generic MCP connections keep their existing shared-scope contract, and Streamable HTTP cannot enable this context. The parent sends a bounded, expiring protocol object out of band from model arguments only after the ordinary runtime authorization gate. It binds the verified current mail envelope's sender and hashed message/conversation identities, mailbox and agent, exact tool and argument digest, operation ID, policy hash, and authorization mode. Approval attribution is supplied only by the local operator approval path and includes a reason hash and expiry. Context is short-lived and does not contain message bodies or credentials.

The adapter must negotiate the exact version-1 context capability on the configured stdio connection and validate the exact object shape, expiry, connection namespace, tool and argument digest before acting. Context is a claim from the trusted parent channel; it cannot independently prove the parent's authentication decision. Model-supplied actor, approval, or revision arguments never establish authority. Opted-in connections may use automatic read tools; mutations require approval and the adapter's own target, revision, idempotency, and reconciliation checks. A remote server's claim about actor enforcement or effect absence is not authoritative without a separately reviewed authenticated evidence contract.

Recipes contain instructions, capability requirements, minimum policy and synthetic requests. Installation does not execute servers or grant authority. `AGENT.md` defines purpose, accepted inputs, procedure, response format and examples; `SOUL.md` defines voice. Load those followed by explicitly ordered workflows, without dynamic discovery or self-editing.

## Endpoint qualification

Provide an opt-in source-checkout evaluator for a fixed synthetic reference recipe, separate from mailbox delivery and customer recipe qualification. It uses the configured inference SDK and model secret only; it never opens runtime state, connects to Graph/MCP or executes a tool. Exercise arithmetic, a German response, exact structured extraction, missing-input clarification and quoted-input injection. An explicit tool probe requires the declared tools capability and checks one exact proposal followed by an untrusted synthetic result. A proposed call is not an executed action.

Bound the suite deadline, requests and outputs. Reports contain per-case pass/fail/not-checked, stable diagnostic codes and endpoint/model/observed-alias hashes, without prompts, responses or secrets. A missing or unexpected returned alias is an unresolved identity failure; alias equality still does not verify weights. Record reviewed provider mapping and hosting evidence separately before qualifying an alias or claiming two independently hosted endpoints. Images/PDF remain unsupported until their own roadmap contracts are implemented.

Keep three evidence layers distinct: deterministic SDK/wire tests, real endpoint/reference-recipe evaluations, and whole-email/MCP acceptance. A passing evaluator does not qualify transport authorization, recipient arrival, business writes, arbitrary prompts or another endpoint.
