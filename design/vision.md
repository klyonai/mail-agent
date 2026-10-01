# Mail Agent

Desired state · 2026-10-01. Delivery status belongs in the [roadmap](../docs/roadmap/ROADMAP.md); observed behavior belongs in [implementation evidence](../docs/implementation.md).

Mail Agent gives an organization a useful AI colleague with an email address. People send requests, include it in conversations, and receive answers or completed documents through their existing mail client.

One deployment connects one Microsoft 365 mailbox, one OpenAI-compatible model endpoint, and optional MCP servers. A small bundle defines the agent's job. Additional inboxes use separate deployments, each with its own configuration, credentials, connections, and state.

The product is a self-hosted Node.js service intended for public source distribution at [klyonai/mail-agent](https://github.com/klyonai/mail-agent) and a versioned Docker image at `ghcr.io/klyonai/mail-agent`. The Docker image is the primary deployment artifact. The project uses the MIT license. The Node CLI is available from a source checkout; an npm package may remain an optional private installation artifact, and public npm publication is not part of the selected distribution plan. The intended support policy covers the latest patch release in `0.1.x` on a qualified Node.js 24 runtime, with best-effort security and maintenance fixes and no response-time or service-level guarantee. A monitored private security reporting route and general support contact remain to be selected and verified before publication. Configuration and reviewed recipes cover most deployments; custom business integrations belong in MCP adapters. Configuration services are an optional commercial offering.

An operator can configure an inbox, diagnose its dependencies, prove a real email journey and maintain it using the supplied guide. Guided setup provides safe defaults; tenant permissions and transport trust remain explicit administrator decisions. Adding another inbox repeats the same independent deployment procedure.

Three reference deployments define success:

- **Text inbox:** receive an authorized request, answer or use a configured tool, and return a direct threaded reply.
- **Document inbox:** receive an image, transcribe it, and return a text attachment. PDF input follows with a bounded processor; searchable PDF output requires a configured document processor.
- **Records assistant:** answer authorized questions, retain coordination facts, and propose governed changes through domain MCPs.

The deployment unit is one mailbox agent in one process or container. A workflow canvas, unrestricted computer control, and autonomous modification of instructions are outside the initial scope.

Public releases declare their supported recipes, tested model capabilities, installation requirements and recovery limits. Text support forms the first release; MCP workflows require real tool acceptance before a beta advertises them. Document processing is the next product milestone. Release artifacts, security reporting and maintenance procedures are part of the product.

Read [architecture](architecture.md), [configuration](configuration.md), [experience](experience.md), [features](features.md), [operations](operations.md), [security](security.md), and [engineering principles](engineering-principles.md) for the target contracts.

The [review history](reviews/2026-10-01.md) records earlier recommendations and the subsequent decision to use one isolated email stack.
