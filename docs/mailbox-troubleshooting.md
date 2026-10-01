# Sender mailbox diagnosis

Successful Microsoft sign-in does not establish that the account has an active Exchange Online mailbox. `MailboxNotEnabledForRESTAPI` needs recipient/licensing/provisioning investigation; the error alone does not identify the cause.

## Administrator checks

1. In Microsoft 365 Admin → Users → Active users, select the exact sender used by the delegated token. Check its licenses and whether the Exchange Online service is enabled.
2. In Exchange Admin Center → Recipients → Mailboxes, confirm an active mailbox for that identity. If the intended account differs from the cached sender, configure and sign in that account explicitly.
3. For a recently licensed user, run Microsoft's recipient provisioning diagnostic and check service health. Provisioning usually completes within 30 minutes but can take 24 hours. [Microsoft's provisioning guidance](https://learn.microsoft.com/en-us/troubleshoot/exchange/user-and-shared-mailboxes/delays-provision-mailbox-sync-changes).

An administrator with an existing Exchange Online PowerShell session can distinguish recipient and mailbox states using read-only commands:

```powershell
Get-EXORecipient -Identity <sender-address>
Get-EXOMailbox -Identity <sender-address>
Get-Mailbox -Identity <sender-address> -SoftDeletedMailbox
Get-Mailbox -Identity <sender-address> -InactiveMailboxOnly
```

Do not infer the cause from an empty license list alone: eligible shared mailboxes can be unlicensed, and shared mailboxes use a licensed user's delegated access rather than direct sign-in. [Mailbox lookup](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-mailbox), [shared mailbox guidance](https://learn.microsoft.com/en-us/microsoft-365/admin/email/about-shared-mailboxes).

## Read-only API checks

The application's `GET /users/{sender}/mailFolders/inbox?$select=id` checks the active mailbox without fetching mail content. It needs existing mailbox read authority and the correct mailbox scope. A delegated `Mail.Send` token does not grant read access. [Folder permissions](https://learn.microsoft.com/en-us/graph/api/mailfolder-get?view=graph-rest-1.0).

Directory/license queries require separate directory authority. If they return `403`, use the administrator checks above; adding broad directory permission to the mail agent is unnecessary for normal operation. Retry the independent sender live suite once the intended sender has an operational mailbox.
