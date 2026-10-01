# Microsoft 365 administrator setup

Commands below are administrator procedures, not actions performed by the agent. Qualification limits are summarized in [public acceptance](public-acceptance.md); source-checkout delivery state is maintained in `docs/roadmap/ROADMAP.md`.

## 1. Prepare the inbox and app

Choose a dedicated active Exchange Online mailbox and a separate sender for acceptance testing. Confirm mailbox state first; an Entra sign-in alone does not prove a usable Exchange mailbox. See [mailbox troubleshooting](mailbox-troubleshooting.md).

Register a dedicated **single-tenant** application in the mailbox's tenant. Record its tenant ID and application/client ID, and the **enterprise application's service-principal object ID**. The app registration object ID is a different identifier. Store the application credential in your approved secret manager and record its rotation/expiry owner. The current agent accepts a client-secret environment reference; no interactive mailbox sign-in is used. [Microsoft app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

## 2. Restrict mail authority

Use Exchange application RBAC for mailbox-scoped read/send authority. This text recipe needs `Application Mail.Read` and `Application Mail.Send`; it does not need mailbox read/write or directory/license access. Independent unscoped Entra application grants can widen access and must be reviewed separately. [Microsoft application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).

In an administrator-managed Exchange Online PowerShell session, adapt these placeholders. Use a new dedicated scope/assignment name; inspect existing objects before repeating or changing this procedure.

```powershell
$mailAgentAppId = '<application-client-id>'
$mailAgentPrincipalId = '<enterprise-application-object-id>'
$mailAgentInbox = 'assistant@example.org'
$mailAgentScope = 'mail-agent-assistant'
$mailAgentFilter = "EmailAddresses -eq 'smtp:assistant@example.org'"

# Inspect first: the filter must return only the intended mailbox.
Get-Recipient -Filter $mailAgentFilter |
    Format-Table Name, PrimarySmtpAddress, RecipientTypeDetails

# After administrator review of the filter and existing registrations:
New-ServicePrincipal -AppId $mailAgentAppId -ObjectId $mailAgentPrincipalId `
    -DisplayName 'Mail Agent assistant'
New-ManagementScope -Name $mailAgentScope -RecipientRestrictionFilter $mailAgentFilter
New-ManagementRoleAssignment -Name 'mail-agent-assistant-read' `
    -Role 'Application Mail.Read' -App $mailAgentPrincipalId -CustomResourceScope $mailAgentScope
New-ManagementRoleAssignment -Name 'mail-agent-assistant-send' `
    -Role 'Application Mail.Send' -App $mailAgentPrincipalId -CustomResourceScope $mailAgentScope

Test-ServicePrincipalAuthorization -Identity $mailAgentPrincipalId -Resource $mailAgentInbox
Test-ServicePrincipalAuthorization -Identity $mailAgentPrincipalId -Resource 'outside-scope@example.org'
```

Use a real existing out-of-scope test mailbox for the second check. The RBAC simulator excludes Entra grants; independently verify effective allowed/denied API access using metadata-only reads and approved synthetic send checks. Permission cache changes may take time. Never broaden the production agent's scope to make acceptance easier. [RBAC authorization testing](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac#testing-authorization).

`EmailAddresses` is used deliberately for recipient filtering; inspect the actual result rather than assuming the mailbox address uniquely scopes the app. [Filterable recipient properties](https://learn.microsoft.com/en-us/powershell/exchange/recipientfilter-properties?view=exchange-ps#primarysmtpaddress).

## 3. Establish sender transport trust

Choose one supported profile in [the authentication guide](../README.md#microsoft-365-prerequisites): trusted DMARC authority or reviewed same-tenant Exchange submission. Check actual header format, connector trust and protection against forged/duplicated headers, using controlled legitimate and hostile test messages. Review both allowed and denied senders.

Set `transport_headers_verified: true` only after that administrator verification. `doctor` reports this recorded decision; neither a green read probe nor entered tenant/domain values establish header trust. Sensitive approval identity remains a separate contract. Record the reviewer, profile, scope, evidence and review date privately without storing raw messages in public project docs.

## 4. Hand off configuration and acceptance

Give the operator tenant/client IDs, mailbox address, approved profile/domains/authorities, sender/recipient lists and secret variable names. Supply credential values through the secret manager. The text recipe defaults to direct replies to the sender; every intended sender must also be an allowed recipient.

Run offline [diagnosis](diagnostics.md), then explicit live probes. Graph diagnosis verifies the tested read operation, not send authority, header trust or recipient arrival. Use [controlled synthetic email acceptance](live-tests.md) after the first synchronization baseline is complete. Verify sender inbox arrival as well as provider Sent Items; keep the production agent restricted to its inbox.

Adding another inbox repeats this procedure with a dedicated deployment, state volume and explicitly scoped authorization. Preserve existing administrator-owned grants and unrelated resources; make changes through the tenant's change process.
