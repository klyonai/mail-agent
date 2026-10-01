# Security policy

Mail Agent is unreleased pre-release software intended for [klyonai/mail-agent](https://github.com/klyonai/mail-agent). It is licensed under MIT. The maintenance policy supports the latest patch release in the `0.1.x` line on Node.js 24; security and maintenance fixes are best effort, with no response-time or service-level guarantee. Public publication remains blocked until a monitored private security reporting route is selected and the remaining gates in [public acceptance](docs/public-acceptance.md) are met.

## Reporting a suspected vulnerability

For an existing private deployment, contact its operator through the private route already agreed for that deployment. No maintainer security contact or monitored private reporting route is currently designated. Do not put vulnerability details in public issues. GitHub private vulnerability reporting may be used only after maintainers enable and verify it for the repository; it is not currently claimed to be available. Do not send vulnerability details until a private route has been confirmed.

Do not put exploit details or private deployment data in public issues. A useful initial report contains:

- The version or commit, Node/container version and affected component.
- Expected behavior, observed impact and a reproduction using synthetic data.
- Sanitized diagnostic codes and approximate timing, where relevant.

Never publish credentials, tokens, raw mail, attachments, private addresses, tenant identifiers, configuration containing secrets, tool arguments/results, databases or snapshots. A private reporting channel is not permission to share all deployment data: follow the organization's incident rules and send only the evidence needed through an approved channel.

## Deployment incidents

The deployment operator owns immediate containment and access to private evidence. Stop the affected process or container when continuing would risk further effects or disclosure, and preserve evidence privately using the [operations](docs/operations.md) and [recovery](docs/recovery.md) procedures. Coordinate suspected credential compromise with the relevant tenant or service administrator.

Do not delete state, reset the mailbox cursor or clear uncertain-effect fences to make an incident disappear. Mail delivery and business effects require authoritative provider or adapter reconciliation; a restart or restored snapshot does not establish that an effect did not happen.

## Updates and publication

There are no published supported releases yet. Once releases are published, only the latest patch release in `0.1.x` is supported, on Node.js 24. Security and maintenance fixes are best effort; there is no response-time or service-level guarantee. Any end-of-support notice will be published in the release notes. [Public acceptance](docs/public-acceptance.md) summarizes the remaining release gates. Detailed roadmap status is source-checkout-only in `docs/roadmap/ROADMAP.md`.

Before publication, maintainers must select and verify a monitored private security reporting route. Release review must cover dependency/runtime advisories and exclude private source, history and artifacts. Original private evidence must be archived unchanged outside the public tree; public acceptance summaries must be separately sanitized.

See [support policy](docs/support.md) for pending publication decisions. Deployment trust assumptions and boundaries are source-checkout-only in `design/security.md`.
