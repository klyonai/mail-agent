# Container quickstart

This guide prepares one text-only Mail Agent deployment for one Microsoft 365 mailbox. It uses a non-root container and a private persistent state volume. This source-checkout workflow requires Node.js 24.21.0 or a later 24.x release, Docker and Compose v2. Complete the [Microsoft 365 administrator setup](microsoft-365-setup.md) with your tenant administrator before starting the mailbox agent.

## 1. Prepare the tenant and mailbox

Ask a tenant administrator to register a dedicated single-tenant application and restrict `Application Mail.Read` and `Application Mail.Send` to the dedicated mailbox with Exchange application RBAC. Review independent Entra grants as described in the [administrator guide](microsoft-365-setup.md). Do not add directory or license permissions to the agent.

The mail administrator must review the actual transport and choose one sender-authentication profile. For `exchange-authenticated`, verify that the trusted authority's authentication results cannot be forged or duplicated by senders. For `exchange-internal`, verify the same-tenant Exchange evidence and protection of its headers. Neither a successful Graph probe nor entered domains establishes this trust. Mail Agent setup leaves transport verification unset until an administrator has made that decision.

Gather the mailbox address, tenant ID, application/client ID, model HTTPS endpoint and model name, allowed sender and reply-recipient addresses, and the selected profile's trusted authentication-service ID or sender domain. Keep the application secret and model API key in your deployment secret manager; setup stores environment-variable names, never secret values.

## 2. Create the agent bundle

Install dependencies when creating a bundle from a source checkout:

```sh
npm ci --ignore-scripts
```

The initializer supports an explicit guided form and a noninteractive form with the same validation. With no connection/policy flags, it creates an inert starter scaffold instead. All forms refuse an existing target, including an empty directory or symbolic link.

For Compose, select `/state` at the state-root prompt:

```sh
node src/cli.mjs init --interactive --directory ./agent --recipe text-inbox
```

The noninteractive form gathers all non-secret settings. For trusted DMARC authentication:

```sh
node src/cli.mjs init --directory ./agent --recipe text-inbox \
  --mailbox assistant@example.org --tenant TENANT_ID --client APPLICATION_ID \
  --model-url https://models.example.org/v1 --model MODEL_ID \
  --senders operator@example.org --recipients operator@example.org \
  --auth-profile dmarc --authserv-ids mx.example.org --state-root /state
```

For reviewed same-tenant Exchange authentication, use `--auth-profile internal --from-domains example.org` instead of the DMARC profile and `--authserv-ids`. The generated bundle must leave `transport_headers_verified` false until the mail administrator completes the review above. Add intended recipients explicitly; direct replies are sent only to the admitted sender and that sender must also be allowed as a recipient.

Initialization needs a local filesystem that supports hard links. The initializer validates a private staged bundle and publishes complete files exclusively, with `agent.yaml` last. A crash can leave an incomplete target; inspect it before removing it and retrying. Keep `./agent` for the Compose bind mount: the current Compose file requires that exact directory and will not create it. Do not put secret values in `agent.yaml`, `AGENT.md`, or another file in the bundle.

## 3. Supply credentials outside the image and bundle

Configure these environment variables through your approved secret provider or a protected host-side environment file:

```text
INBOX_GRAPH_CLIENT_SECRET
INBOX_MODEL_API_KEY
```

Compose requires both variables during configuration and passes them to the container. A host environment file, if used, must be outside `./agent`, owner-readable only, and excluded from source control. Pass it with `--env-file /absolute/path/to/mail-agent.env`; never build secrets into the image or mount the secret file into `/bundle`.

## 4. Check the bundle and container access

The bundle mount is read-only. The process runs as uid/gid `1000:1000`; on Linux, make `./agent` and its files readable and traversable by that container identity while keeping writes limited to the operator. Use host ACLs or a dedicated group as appropriate for the Docker engine. On Docker Desktop or rootless engines, confirm how container IDs map to host files. Do not make the bundle world-writable. For a standard Linux Docker host, a group-readable bundle with container group 1000 is one option:

```sh
sudo chgrp -R 1000 ./agent
chmod 0750 ./agent
chmod 0640 ./agent/agent.yaml ./agent/AGENT.md
```

Keep the operator as owner and restrict membership in that group. Give any added instruction files the same read access. Every parent directory visible along a nested container path also needs traversal access for the runtime identity. Confirm access using the offline container check below; rootless/Desktop mappings may require a different host ACL.

Validate the bundle offline before building; this requires no credentials or state directory:

```sh
node src/cli.mjs check --config ./agent/agent.yaml
```

Run `doctor` inside the container in the next step so it inspects the actual `/state` mount and deployment identity. It checks named secret availability, policy, administrator verification and state permissions without contacting services or repairing state. Missing deployment credentials or unverified transport should be reported as not ready. See [diagnostics](diagnostics.md) for codes and remediation.

## 5. Build, probe, and start Compose

All `docker compose` commands below need the credential environment available because the current Compose file requires both values, including for offline commands. Compose first runs `state-init`: a network-isolated one-shot container with only the `CHOWN` and `FOWNER` capabilities sets the named state volume to uid/gid `1000:1000` and mode `0700`. The agent then runs as `1000:1000`, with a read-only root filesystem, read-only `/bundle`, and private persistent `/state`.

```sh
docker compose --env-file /absolute/path/to/mail-agent.env build
docker compose --env-file /absolute/path/to/mail-agent.env run --rm mail-agent doctor --config /bundle/agent.yaml
```

The `run` command starts its required `state-init` dependency, so it initializes local volume ownership before diagnosis. The offline doctor does not contact external services. To check bundle readability and schema independently of readiness prerequisites, run the same command with `check` instead of `doctor`. Once the administrator has verified sender-header trust, explicitly set `transport_headers_verified: true` in the bundle and rerun offline diagnosis.

Run live diagnosis only when ready to contact the configured services:

```sh
docker compose --env-file /absolute/path/to/mail-agent.env run --rm mail-agent doctor --config /bundle/agent.yaml --live
```

Live doctor contacts Microsoft Graph and the model; it also connects to configured MCP servers and discovers tools, if any. It sends no email and invokes no MCP tool. It uses existing configured credentials and grants. A passing Graph read does not prove send authority, mailbox scope, transport-header trust, or delivery to a recipient. A passing model probe does not establish response quality. Live diagnosis can start a configured stdio MCP process and create a server session; review that server before enabling it.

Start the service only with a controlled acceptance mailbox:

```sh
docker compose --env-file /absolute/path/to/mail-agent.env up -d
```

The first runtime startup establishes a Graph delta baseline; it does not process existing messages. After the baseline completes, new admitted messages can invoke the model and cause real threaded email replies. Keep production mail out of initial acceptance. Use the [controlled live email procedure](live-tests.md) with bounded synthetic messages and a dedicated test mailbox. That procedure sends real synthetic emails and produces real replies; it does not delete them. Verify recipient inbox arrival separately from Graph's Sent Items acceptance.

## 6. Operate and preserve state

The named `agent-state` volume holds checkpoints, queued work, approvals, audit data and uncertain-effect fences across restarts. Keep one active runtime per mailbox and state volume. Do not remove the volume while work is pending; do not share it over a network filesystem. Back it up consistently while stopped, protect the backup separately, and reconcile pending effects before restoring and starting.

Inspect approvals through the running container:

```sh
docker compose --env-file /absolute/path/to/mail-agent.env exec mail-agent \
  node /app/src/cli.mjs approvals --config /bundle/agent.yaml
```

Use `approve` and `resolve` only after reviewing the exact action and its evidence. `--actor` is recorded attribution; host access controls who can run the command. A provider-accepted send is not proof of recipient arrival. Never resolve an uncertain send as `not-sent` without evidence that it did not occur.

## What requires a human administrator

An independent operator can install the bundle, run offline checks, inspect the container, and conduct the synthetic acceptance procedure after tenant access is provided. A tenant/mail administrator must establish and document Exchange header protection and scoped application authorization, and must verify both allowed and denied mailbox access. Those trust and authorization decisions cannot be established by a colleague running setup or by a green doctor result.
