# Mail Agent

A configurable Microsoft 365 inbox agent. Each process serves one mailbox with its own instructions, credentials, MCP connections, and private durable state. Additional inboxes use separate deployments.

The current implementation uses the Vercel AI SDK behind a small model interface. Configure an OpenAI-compatible Chat Completions endpoint; no Vercel hosting or account is required. SDK telemetry is disabled. Mail Agent controls permissions, tool execution, approvals, persisted jobs, and replies.

This source describes the prepared alpha implementation. Its baseline, synthetic checks, bounded live text evidence, limitations and candidate preparation gates are summarized in [public acceptance](docs/public-acceptance.md). [GitHub release notes](https://github.com/klyonai/mail-agent/releases) identify published versions and subsequent exact-artifact qualification. Replies observed in Sent Items do not establish independent recipient arrival. Offline previews use fixtures and do not contact Microsoft 365.

## Configure a text inbox

Use Node.js 24.21.0 or a later 24.x release on Linux or a compatible local development environment:

```sh
npm ci --ignore-scripts
node src/cli.mjs init --directory ./agent --recipe text-inbox --interactive
```

Guided setup collects non-secret connection settings, authentication profile and mail policy, then validates and publishes a private bundle without overwriting an existing path. Scripted flags use the same validation; omit both `--interactive` and connection flags to copy an inert [starter recipe](examples/text-inbox). Edit `agent/AGENT.md` to define its purpose. See the [container quickstart](docs/quickstart.md) and [scoped administrator guide](docs/microsoft-365-setup.md) for exact setup steps.

Configure the mailbox tenant/application IDs and address, model endpoint/name, allowed senders and recipients, and sender authentication policy. `AGENT.md` defines purpose and procedures; optional `SOUL.md` defines voice. Explicitly listed workflow files are loaded in order. Instructions cannot grant permissions.

Secrets are environment references, such as `INBOX_GRAPH_CLIENT_SECRET` and `INBOX_MODEL_API_KEY`; supply their values through your approved secret manager or deployment environment. Keep credentials and runtime state outside source control. Do not enable a recipe using its example tenant, endpoint, addresses, or model name.

```sh
node src/cli.mjs check --config ./agent/agent.yaml
node src/cli.mjs doctor --config ./agent/agent.yaml
node src/cli.mjs preview ./examples/request.json --config ./agent/agent.yaml
```

`check` validates the bundle offline. `doctor` reports individual readiness checks and corrective steps, with `--json` for automation; offline mode constructs no service clients. Example placeholders and missing deployment secrets are reported as failures. See [diagnostics](docs/diagnostics.md). `preview` uses synthetic mail and inference and requires no live secrets. Match the fixture sender/recipient to the configured policy when adapting the example.

## Microsoft 365 prerequisites

Ask the tenant administrator to configure application authorization for mail read and send access, restricted to the dedicated mailbox. Text intake requires full message read authority; basic metadata access does not supply the clean body and authentication headers. Direct text replies use send authority. Broader mailbox write access is unnecessary for this slice.

Exchange application RBAC and Entra application grants apply independently. Existing unscoped grants can widen mailbox access; verify both allowed and denied mailbox access. See [Microsoft application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac). The initial adapter supports the global Microsoft cloud only: `graph.microsoft.com` and `login.microsoftonline.com`.

Sender allowlists are combined with transport authentication. The supported configuration is:

```yaml
sender_authentication:
  mode: exchange-authenticated
  trusted_authserv_ids: [mx.example.org]
  transport_headers_verified: true
```

The existing `transport_headers_verified` flag is required by the runtime. Set it deliberately after the mail administrator accepts the selected profile and its Microsoft 365 deployment assumptions. It records an operator decision, not software proof of header protection. Setup never enables it automatically. Routine qualification does not require bespoke header-forgery testing or a Microsoft support ticket; see [the deployment assumptions](docs/microsoft-365-setup.md#3-select-and-accept-the-sender-authentication-profile).

The adapter requires exactly one trusted `Authentication-Results` header containing `dmarc=pass` with `header.from` equal to the sender's domain. The selected `from` and `sender` must agree. Headers containing comments, ambiguous results, missing authority, or mismatched domains fail authentication. Internal `AuthAs` headers alone do not establish identity. Check the actual tenant header format before deployment.

This is domain authentication assurance, not proof that a particular person sent the message. Sensitive approvals require stronger verified identity where that assurance is insufficient. The current approval interface is a local operator command protected by access to the deployment and state.

For reviewed same-tenant hosted mail, configure the separate internal profile instead:

```yaml
sender_authentication:
  mode: exchange-internal
  sender_domains: [example.org]
  transport_headers_verified: true
```

This requires the configured GUID tenant ID, equal sender/from addresses, and unambiguous Exchange evidence for Internal authentication, same-tenant origin, Hosted source and Originating direction. An optional authentication source must be beneath `prod.outlook.com`. Missing, duplicate or conflicting evidence denies admission. This profile does not fall back to DMARC. Correct Microsoft 365 identity, mailbox and transport administration is an accepted deployment assumption. The adapter enforces the configured evidence checks; it does not independently certify the tenant's security.

After configuring real secrets and accepting the selected transport policy:

```sh
node src/cli.mjs check --config ./agent/agent.yaml --live
node src/cli.mjs doctor --config ./agent/agent.yaml --live
node src/cli.mjs start --config ./agent/agent.yaml
```

The live check contacts dependencies; it does not send mail. Verify authorized and unauthorized sender cases and actual threaded replies in a controlled mailbox before operational use.

## Processing and recovery

Polling needs no public inbound endpoint. First startup establishes a delta baseline and leaves existing messages unprocessed. New mail is processed after the complete baseline. Do not expect startup to handle messages already present, including messages arriving while the initial baseline is being established. Each delta page and its accepted work are committed together.

The process owns a private state directory with a SQLite store, checkpoints, jobs, approval records, action fences, and outbox. Keep one active runtime per mailbox and state root. Preserve this state across restarts. Changing or deleting it creates a fresh baseline and loses pending work and reconciliation evidence.

The state volume must support local SQLite file locking. A separate held SQLite lock prevents concurrent owners and releases automatically after a crash; PID metadata alone grants no ownership. Use a local persistent volume, rather than sharing the state directory over a network filesystem.

Policy and instruction edits are validated before subsequent actions. Each run keeps its original instructions, while current sender, recipient, and tool policy is rechecked. Changing connections, state location, limits, or retention requires a restart. An invalid edit prevents further tool execution and delivery; affected runs may fail and require a new request after correction.

Only admitted authenticated senders reach inference or tools. The default text recipe admits direct To requests and sends a text reply to the sender; CC-only requests and reply-all are unsupported. Replies are checked against recipient policy, automatic messages and loops are suppressed, and differing Reply-To addresses cannot redirect a direct reply. In this default recipe, authenticated authorized direct requests with attachments, including inline images, receive a deterministic explanation without inference or tools. Unknown or failed attachment metadata blocks inference; messages from the agent’s own mailbox stay silent to prevent reply loops.

An explicit schema-2 [experimental document recipe](docs/document-inbox.md)
connects bounded PNG/baseline-JPEG intake, private expiring artifacts, image
inference and optional `transcription.txt` replies. Default setup remains
text-only. Model quality, actual attachment arrival and integrated Linux
qualification remain open; declaring image capability does not qualify an
endpoint. PDF is unsupported.

An accepted Graph send means Microsoft accepted the request, not that the recipient received it. A crash, cancellation, or network failure during a send can leave an uncertain outcome. The persisted send fence prevents automatic resend. Inspect mailbox/provider evidence before recording the actual result; never resolve uncertainty by guessing.

Local operator commands reach a running daemon through its private Unix socket and state volume. Approvals are available through these CLI controls; inbound email approvals are deferred. The same commands work with the daemon stopped, and approved work resumes on its next start:

```sh
node src/cli.mjs status --config ./agent/agent.yaml
node src/cli.mjs health --config ./agent/agent.yaml
node src/cli.mjs approvals --config ./agent/agent.yaml
node src/cli.mjs approve --config ./agent/agent.yaml --id ACTION_ID \
  --actor operator@example.org --reason "Reviewed the exact proposed action"
node src/cli.mjs resolve --config ./agent/agent.yaml --run RUN_ID \
  --outcome sent --actor operator@example.org --reason "Confirmed the reply in provider records"
```

Use `--outcome not-sent` only with evidence that the send did not occur. Approval records bind the exact action; restart rechecks current policy before resuming. `--actor` identifies the local operator in audit records; access to these commands is controlled by the host, not by authenticating that email address.

`status` reports baseline progress, poll times, state counts, backlog and categorized failures; `health` observes the running daemon through its private socket and exits nonzero when it is not ready. Status/approval pages support `--limit` and `--after`; status also supports `--state`. Safe Graph reads use at most three deadline-bounded attempts, honor provider waits across restart and preserve uncertainty fences. See [local operations](docs/operations.md) for field meanings and retry limits.

Uncertain MCP writes are fenced and never retried automatically. `resolve` handles
sends. The first-party records recipe supplies `records-intent` and
`reconcile-records` for its [stopped operator procedure](docs/records-inbox.md).
Other business adapters need their own reviewed reconciliation contract.

Use the stopped `backup` command and restore into a fresh root with `restore`; see [the recovery guide](docs/recovery.md). Restore validates the snapshot and persists a recovery hold that blocks execution. `recovery-inspect` reports bounded metadata and record fingerprints while stopped. `recovery-preview` and `recovery-apply` atomically record reviewed reconciliation decisions while held. `recovery-release-preview` and `recovery-release-apply` review and commit either continuity or explicit history-gap acceptance after whole-window reconciliation. Protect secrets separately, retain trusted backup provenance and keep state owner-only. Unresolved effects remain fenced after release.

Content is purged at startup and during processing after `content_hours`; expired queued work and approvals cannot resume. Audit metadata expires after `audit_days`. Content-free message identities and action fences remain indefinitely to prevent replay. SQLite secure deletion and WAL truncation clear expired content from the live store; filesystem snapshots and backups need their own retention. Metadata grows over time, so monitor the volume.

## Optional MCP tools

The [experimental records recipe](docs/records-inbox.md) adds a dedicated
first-party folder-backed server with sender-scoped reads, exact local approvals,
revision/hash conflicts and explicit operator reconciliation. Its stdio connection
opts into negotiated actor context. Generic connections and HTTP receive no actor
metadata. The private package includes this adapter; deployment qualification
and earlier milestone gates remain open.

The text recipe needs no MCP. Enable the model's tools capability only for an endpoint whose tool behavior has been verified. Connections support authenticated Streamable HTTP or dedicated stdio child processes.

Configure reviewed tools explicitly under `policy.tools`, with effect, automatic/approval authorization, and any argument constraints. Tool annotations never grant authority. A remote connection uses credentials restricted to the resource scope authorized for every admitted sender. Different visibility needs require a domain adapter or separate deployments.

Local servers use `node` or an explicit executable path, arguments, a declared pinned version, and an environment allowlist. Provision and verify that exact server version yourself; the version declaration is not an installer or integrity check. Child processes receive only explicitly configured environment variables and remain inside the deployment's OS/container permissions. Ship dependencies in a reviewed image or bundle; recipe installation never runs an unreviewed server.

## Container deployment

The Dockerfile builds a candidate minimal runtime from digest-pinned Node and Distroless Debian 13 stages. It copies the exact Node.js 24.21.0 binary and production dependencies installed from the lockfile with scripts disabled, and runs as uid/gid 1000. The runtime contains no shell or package manager; use the Node CLI for operations and provision complete reviewed MCP bundles during construction. Compose uses Node filesystem APIs in a dedicated, network-isolated initialization service to establish ownership and mode 0700 on the named state volume. The running agent has a read-only root filesystem and read-only instruction bundle. Exact-image operations and advisory qualification remain release gates; earlier image evidence does not qualify this candidate.

Create and configure `./agent` first and grant container uid/gid 1000 read access as described in the [quickstart](docs/quickstart.md). For Compose set `state_root: /state` in `agent/agent.yaml`, keep the example secret variable names, and supply their real values through the deployment environment. Both secret variables are required; Compose refuses empty values.

```sh
docker compose build
docker compose run --rm --no-deps mail-agent check --config /bundle/agent.yaml
docker compose up -d
```

For online operator commands, use the running container and its private state volume:

```sh
docker compose exec mail-agent node /app/src/cli.mjs approvals --config /bundle/agent.yaml
```

Replace `approvals` with the relevant `approve` or `resolve` command above. If the daemon is stopped, use `docker compose run --rm --no-deps mail-agent approvals --config /bundle/agent.yaml`, then start it again. Do not run a second daemon against that volume. Never remove the volume while work is pending. Provision local MCP executables in the image or explicitly mount their reviewed bundle read-only; the default image does not install customer MCP servers.

## Development and design

Source-checkout-only planning files: `design/vision.md` describes desired state; `docs/roadmap/ROADMAP.md` tracks milestones and acceptance; `docs/implementation.md` records detailed implementation evidence. Roadblocks feed back into design updates and dated roadmap decisions before affected work continues.

The package remains private. [Contribution guidance](CONTRIBUTING.md), [security policy](SECURITY.md), [support decisions](docs/support.md) and [candidate qualification](docs/releasing.md) describe preparation and the remaining publication gates.

```sh
npm run check
```

Checks use synthetic fixtures and injected dependencies, including SDK/stdio-MCP/Graph-protocol, first-party records and image-to-transcript-MIME journeys across restart. Current evidence and limits are summarized in [public acceptance](docs/public-acceptance.md). The [opt-in live suite](docs/live-tests.md) sends bounded synthetic requests through a configured test mailbox and can evaluate actual model responses; no credentials or test account are bundled. Documents and records remain experimental. PDFs, email approvals, scheduling, webhooks and richer administration are unsupported. Source-checkout-only desired capabilities are described in `design/features.md`; delivery order is tracked in `docs/roadmap/ROADMAP.md`.

The separate [live MCP suite](docs/live-mcp-tests.md) qualifies a UUID-scoped synthetic read and exact local approval/write across restart, including controlled uncertainty cases. Its real email/MCP acceptance remains open; optional MCP is experimental.

The [model reference evaluator](docs/endpoint-qualification.md) exercises fixed text cases and optional tool proposals through the inference SDK without mail or tool execution. It reports alias mismatches and sanitized failures. A passing reference suite does not qualify another endpoint, model weights, customer recipes or email delivery.
