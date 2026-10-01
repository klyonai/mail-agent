# Live acceptance sender setup

The live email suite needs a separate, human-operated sender mailbox. Its delegated token is used only to submit the bounded synthetic messages to the agent mailbox. The suite does not use the sender's mailbox read permission. Keep this account and its credentials separate from the agent's application identity.

## Prepare the delegated client

Ask the tenant administrator to register a separate single-tenant public-client application for the operator's command-line sign-in. Add only the Microsoft Graph **delegated** `Mail.Send` permission. Do not add application `Mail.Send`, `Mail.Read`, or `Mail.ReadWrite`. If tenant policy requires it, have an administrator grant consent before sign-in. The sending user must have an active Exchange mailbox and permission to send from that account.

Enable the public-client flow needed for device-code authentication in the app registration. Do not create a client secret for this public client. Device-code flow is supported for public-client applications and is suitable for command-line sign-in; Microsoft recommends using MSAL where available. See Microsoft's [device-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code), [public and confidential client app guidance](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications), and Graph [`sendMail` permissions](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0#permissions).

Use a tenant-approved client for the first interactive sign-in, with the sender's tenant as authority. Request only these scopes:

```text
https://graph.microsoft.com/Mail.Send
offline_access
```

The user completes sign-in and any required consent in Microsoft's browser flow. Microsoft's [scope guidance](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc#the-offline_access-scope) explains that `offline_access` is explicitly requested on the v2 endpoint to receive refresh tokens. This repository does not implement first-time delegated sign-in or account provisioning.

## Create the cache and environment

The runner reads these JSON fields from `--sender-token-file`:

```json
{
  "accessToken": "<redacted token value>",
  "refreshToken": "<redacted token value>",
  "expiresAt": 1790000000000
}
```

The example values are placeholders, not credentials. A tenant-approved OAuth exporter must securely map its token response into this runner-specific cache and write the file directly. An ordinary MSAL serialized cache is not this JSON format, and standard MSAL acquisition results do not necessarily expose a `refreshToken` field. Do not extract tokens from an undocumented MSAL cache or enable token logging to make the example work. If the tenant has no approved exporter that can produce this format without exposing token values, the delegated live suite is not ready to run. Do not put token values in shell arguments, shell history, logs, reports, source files, or messages. `expiresAt` may be epoch milliseconds, epoch seconds, or an ISO date. The runner checks the file is regular, owned by the invoking user, and has no group/world permission bits; keep its parent directory private too. It refreshes an expired access token through the tenant's token endpoint and atomically replaces the cache. The refresh token remains a secret.

Set the separate client's tenant and application ID in a private environment file or the process environment. Also set `LOCAL_SENDER_ALLOWED_RECIPIENTS` to include the agent mailbox, and provide the exact secret environment variable names referenced by the agent bundle:

```text
LOCAL_SENDER_TENANT_ID=<sender tenant ID>
LOCAL_SENDER_CLIENT_ID=<delegated public-client application ID>
LOCAL_SENDER_ALLOWED_RECIPIENTS=<agent mailbox address>
INBOX_GRAPH_CLIENT_SECRET=<provided by the agent deployment secret manager>
INBOX_MODEL_API_KEY=<provided by the agent deployment secret manager>
```

The last two names are examples for the standard bundle; use its actual configured names. Protect the environment file as an owner-only regular file. Never copy application or model secret values into the sender-token cache. The sender address must appear in the agent bundle's sender and reply-recipient policies. The agent mailbox must appear in the sender allowlist.

Run the command from [live email acceptance](live-tests.md) with the sender address and both private files. The runner decodes tenant, address, and delegated-scope claims as consistency hints; these are not proof of identity or permission. Microsoft Graph remains authoritative for the request. If local token claims do not match the expected tenant/address or do not include `Mail.Send`, stop and ask the tenant administrator to review the client and sign-in; do not broaden permissions to bypass the check.

## Content-free acceptance evidence

Record the manual checks separately from the runner report. Keep tenant addresses and detailed grant evidence in the organization's approved private record. A shared summary can use hashes or role labels and should contain no token, raw message, full header, mail body, or attachment.

| Check | Record |
| --- | --- |
| Test run | UTC time window, synthetic run marker, recipe/build version, and pass/fail/not-checked. |
| Independent recipient arrival | One row per synthetic case, including `model-unavailable` when used: sender role/hash, case name, arrived yes/no, and observed time. Verify in the sender inbox manually; do not grant the runner `Mail.Read`. Sent Items evidence alone is not recipient arrival. |
| Allowed mailbox scope | Administrator/reviewer role, date, test mailbox hash, tested operation, and observed allow/deny result. |
| Denied mailbox scope | Out-of-scope mailbox hash, tested operation, and observed denial. Include independent review of any unscoped Entra application grants. |
| Sender trust | Selected authentication profile, trusted authority/domain label, administrator/reviewer role, review date, and protected/forgery-resistant result. Do not copy raw authentication headers into the shared record. |
| Limitations | Any check not performed and the evidence still needed. Do not infer delivery, mailbox scope, or header trust from a green live probe. |

This evidence supports the open MA-004 tenant and recipient gates; synthetic runner results do not replace administrator verification or a separate recipient inbox check.
