# Security policy

Mail Agent is licensed under MIT. The maintenance policy supports the latest published patch release in the `0.1.x` line on Node.js 24; security and maintenance fixes are best effort, with no response-time or service-level guarantee. [GitHub releases](https://github.com/klyonai/mail-agent/releases) identify published versions and their qualification. The first release/image requires a verified and monitored private security reporting route and the gates in [public acceptance](docs/public-acceptance.md).

## Reporting a suspected vulnerability

Use [GitHub private vulnerability reporting](https://github.com/klyonai/mail-agent/security/advisories/new) when the repository's reporting feature is available. If it is unavailable, contact the deployment operator through the private route agreed for that deployment. Do not put vulnerability details in public issues. GitHub reporting requires a public repository; see [GitHub requirements](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). At candidate preparation, public visibility, reporting enablement and maintainer monitoring are still unverified; they must be verified before release. Do not send private details through an unconfirmed route.

Do not put exploit details or private deployment data in public issues. A useful initial report contains:

- The version or commit, Node/container version and affected component.
- Expected behavior, observed impact and a reproduction using synthetic data.
- Sanitized diagnostic codes and approximate timing, where relevant.

Never publish credentials, tokens, raw mail, attachments, private addresses, tenant identifiers, configuration containing secrets, tool arguments/results, databases or snapshots. A private reporting channel is not permission to share all deployment data: follow the organization's incident rules and send only the evidence needed through an approved channel.

## Deployment incidents

The deployment operator owns immediate containment and access to private evidence. Stop the affected process or container when continuing would risk further effects or disclosure, and preserve evidence privately using the [operations](docs/operations.md) and [recovery](docs/recovery.md) procedures. Coordinate suspected credential compromise with the relevant tenant or service administrator.

Do not delete state, reset the mailbox cursor or clear uncertain-effect fences to make an incident disappear. Mail delivery and business effects require authoritative provider or adapter reconciliation; a restart or restored snapshot does not establish that an effect did not happen.

## Updates and publication

Only the latest published patch release in `0.1.x` is supported, on Node.js 24. Security and maintenance fixes are best effort; there is no response-time or service-level guarantee. Any end-of-support notice will be published in the release notes. [Public acceptance](docs/public-acceptance.md) records the candidate preparation snapshot; the corresponding GitHub release records subsequent publication and verification. Detailed roadmap status is source-checkout-only in `docs/roadmap/ROADMAP.md`.

Stage and review source while private. GitHub reporting is selected. Obtain final approval for public source visibility, then enable and verify private vulnerability reporting and its monitoring before the first release/image. Selection does not establish availability or monitoring. Release review must cover dependency/runtime advisories and exclude private source, history and artifacts. Original private evidence must be archived unchanged outside the public tree; public acceptance summaries must be separately sanitized.

See [support policy](docs/support.md) for pending publication decisions. Deployment trust assumptions and boundaries are source-checkout-only in `design/security.md`.
