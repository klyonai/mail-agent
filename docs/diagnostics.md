# Diagnose an agent bundle

`doctor` checks readiness without starting the mailbox daemon or opening its SQLite store. It does not acquire the runtime ownership lock, process mail, change permissions or mark transport headers verified.

```sh
node src/cli.mjs doctor --config ./agent/agent.yaml
node src/cli.mjs doctor --config ./agent/agent.yaml --json
```

Offline is the default. It checks configuration/instructions, example placeholders, required environment variable presence, sender/recipient consistency, administrator transport verification and the state location. It constructs no dependency clients. Secret checks display variable names only. State inspection does not create, chmod or repair the state directory.

## Explicit live probes

```sh
node src/cli.mjs doctor --config ./agent/agent.yaml --live
node src/cli.mjs doctor --config ./agent/agent.yaml --live --json
```

Live mode contacts the configured Microsoft Graph and model endpoints. If MCP is configured, it also connects to its reviewed servers (including starting configured stdio processes) and discovers tools. The model receives synthetic compatibility prompts; a tools-capable model is asked to generate a harmless synthetic call, which is never executed. Mail Agent sends no email and invokes no MCP tool; `externalMutations: false` describes those requested effects. Server startup/session effects depend on the reviewed MCP implementation. Probes use bounded requests and existing credentials; directory/license permissions are unnecessary. Obvious placeholder values, including remote MCP URLs, prevent live connections.

Each model step permits up to 512 output tokens, bounded by the configured `limits.output_tokens`, so reasoning models have room to produce a final response. Text mode makes one request; tools mode makes at most two. An empty or invalid response fails the check; review output budget as well as endpoint compatibility.

Each check reports **pass**, **fail** or **not-checked**, a stable safe code and a corrective step. A failed dependency does not hide independent checks. A skipped probe is not a successful probe. The command exits `1` when required checks fail and `0` when all checks required for the selected mode pass. Offline success leaves live dependencies unverified.

## Common failures

| Diagnostic | Next action |
| --- | --- |
| Invalid configuration/instructions | Correct the bundle, supported fields and instruction paths; rerun offline diagnosis. |
| Placeholder values | Replace example tenant/application/model identities, endpoints and policy addresses. |
| Missing environment variables | Supply the named variables through the deployment environment or secret manager; never paste their values into reports. |
| State access/privacy | Use a private local volume owned by the runtime user; inspect ownership, modes and parent paths. |
| Missing transport verification | Ask the mail administrator to accept the selected authentication profile and deployment assumptions, then deliberately record that decision. A successful Graph probe cannot supply the acceptance. |
| Credential failure | Check application/tenant identity, credential value and expiry with the administrator. |
| Access denied | Check the affected mailbox operation and scoped authorization. Do not add broad directory grants as a shortcut. |
| Mailbox unavailable | Check address, active recipient/mailbox state and licensing/provisioning. See [mailbox troubleshooting](mailbox-troubleshooting.md); the status alone cannot establish the cause. |
| DNS/connection/TLS/timeout | Check the endpoint, network/tunnel, certificate trust and dependency health; preserve TLS validation. |
| Throttled | Respect the provider's throttling and retry guidance; diagnosis does not automatically retry writes. |
| Unsupported model/tools | Check endpoint/model identity, capability profile and tool discovery/schema compatibility. |

Reports never include provider error bodies, tokens, model prompts/results, raw mail or attachment contents. Unexpected failures use a generic safe message; diagnosis does not claim a cause it cannot establish.

## What a passing probe means

Graph readiness establishes that the configured app can perform the tested mailbox read. It does not establish send authority, allowed/denied scope across other mailboxes or recipient delivery. Correct Microsoft 365 administration remains an accepted deployment prerequisite; the probe does not supply administrator acceptance of those assumptions. Model compatibility does not establish task quality. MCP discovery does not establish per-sender resource visibility or safe writes.

`check` retains its existing offline/live behavior. `preview` remains a deterministic fixture. Use the [controlled live email suite](live-tests.md) for actual intake, inference and reply evidence. Stop other consumers of the dedicated test inbox before running that suite, and explicitly review its bounded synthetic email effects.
