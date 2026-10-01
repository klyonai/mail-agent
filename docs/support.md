# Support policy

Mail Agent has no published release yet. Once released, the support policy covers only the latest patch release in the `0.1.x` line running on Node.js 24. Security and maintenance fixes are best effort; there is no response-time or service-level guarantee, and development commits are unsupported. This policy does not promise compatibility with every OpenAI-compatible endpoint.

## Scope

The initial alpha targets one Office 365 mailbox per process/container, direct text replies and operator-managed installation on the qualified Node 24 runtime and Linux image. Optional MCP remains experimental until its live qualification is complete. Each deployment must verify its tenant permissions, protected transport-authentication headers, model capabilities and configured adapter scope.

Document processing, attachment delivery, CC-only intake, email approvals and shared daemons are outside the initial alpha. [Public acceptance](public-acceptance.md) summarizes qualification and remaining scope; [the README](../README.md) describes current behavior. The detailed roadmap is source-checkout-only in `docs/roadmap/ROADMAP.md`.

## Getting help

For a private deployment, use its agreed operator or maintainer channel. Tenant access and mailbox configuration need the tenant administrator; model and MCP availability may need the configured service owner. No general support contact has been selected. The intended repository is [klyonai/mail-agent](https://github.com/klyonai/mail-agent); using its public Issues for general support remains pending user confirmation and repository setup. Issues are not a private security reporting route. Any separate support agreement applies only to the deployment and terms it explicitly covers.

A routine report should include the build version, runtime/image version, command or affected boundary, sanitized diagnostic codes and a synthetic reproduction. Start with [diagnostics](diagnostics.md) and [operations](operations.md). Do not attach raw mail, credentials, private configuration, tool data, databases or snapshots to a public report. Suspected vulnerabilities and deployment incidents follow the [security policy](../SECURITY.md).

## Decisions required before publication

| Decision | Current status |
| --- | --- |
| License | MIT |
| GitHub repository | `klyonai/mail-agent` |
| Intended Docker image destination | `ghcr.io/klyonai/mail-agent`; registry/repository availability and publishing setup remain unverified |
| Private security reporting route | Pending selection and verification; GitHub private vulnerability reporting is not yet verified as enabled |
| General support route | Public GitHub Issues pending user confirmation and repository setup; no separate support contact selected |
| Supported release line and runtime | Latest patch in `0.1.x`; Node.js 24 |
| Maintenance and security updates | Best effort; no response-time or service-level guarantee; end-of-support notice in release notes |

The published release policy must name the exact supported patch and qualified container runtime, state how fixes are delivered, and link the applicable state migration and rollback limits. Older binaries must not be used against newer state merely as a rollback strategy; follow [recovery guidance](recovery.md).

Public alpha publication requires the agreed policy and all remaining [release gates](public-acceptance.md), including hosted CI, packaged installation, tenant qualification and public artifact/privacy review. Until then, development evidence is not a claim of public release readiness.
