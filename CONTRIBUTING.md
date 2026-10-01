# Contributing

This is pre-release software intended for [klyonai/mail-agent](https://github.com/klyonai/mail-agent), under the MIT license. Public contribution and support channels have not been established. The project is not yet accepting public contributions; this guide records the workflow for authorized contributors and future use.

## Scope and review

For source-checkout work, read `design/vision.md`, `docs/roadmap/ROADMAP.md`, and `docs/implementation.md` first. The roadmap is the delivery plan; dated records under `docs/roadmap/history/` preserve evidence and decisions and must not be rewritten. Packaged acceptance status is summarized in [public acceptance](docs/public-acceptance.md).

For a change, identify the roadmap item it advances. Keep the patch narrow, add or update deterministic synthetic tests first, and document user-visible or operational behavior. Update the roadmap and implementation evidence when acceptance status or observed behavior changes. A design change requires updating the relevant design contract and adding a dated decision before revising the roadmap.

Keep boundaries explicit: mailbox intake, authorization, inference, MCP, durable state, and operator controls have separate responsibilities. Fail closed for identity and permissions. External effects need the existing governed path and durable uncertainty handling. Do not allow email, documents, model output, or tool output to change authority.

## Development checks

Use Node.js 24.21.0 or a later 24.x release, as declared by `package.json`. From a clean checkout, install the lockfile dependencies and run the default checks:

```sh
npm ci --ignore-scripts
npm run check
```

The default check runs ESLint and synthetic tests. Tests must inject clocks, network adapters, command runners, and filesystem roots where they affect results. Do not make a default test depend on live services, developer-specific binaries, or filesystem timestamps. Keep ESLint complexity at or below 12 without adding exceptions.

For packaging changes, also run `npm run test:package`; it installs the actual tarball into a temporary consumer and needs public npm registry access. See [candidate qualification](docs/releasing.md) for its scope and the separate publication gates.

The opt-in live suite can contact a configured test mailbox and model endpoint. It is not part of the default check. Run it only with explicit authorization, a dedicated test account, bounded synthetic messages, and reviewed effects; document its prerequisites and redacted outcome. Never put credentials, raw mail, recipient data, local state, or unredacted live reports in a patch.

## Security and privacy

Do not publish secrets, tokens, private message or attachment content, state databases, environment-specific configuration, or incident evidence. Use synthetic fixtures. Review generated artifacts as well as source files before sharing them.

A public security contact has not been selected. The repository is private and does not currently provide a public vulnerability-reporting channel. A public release must publish a monitored security contact and response policy before publication; do not add an invented address or identity here.

## Current boundaries

The supported implementation is a single text inbox deployment with local approvals and optional, explicitly configured MCP. Image/PDF processing, generated file delivery, email approvals, webhooks, public health endpoints, and generic business-write recovery are not supported. See [public acceptance](docs/public-acceptance.md) for current qualification limits; the detailed roadmap is source-checkout-only in `docs/roadmap/ROADMAP.md`.
