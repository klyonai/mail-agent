# Local operations

One daemon owns one mailbox and a private state volume. These commands observe that deployment; `health` has no public endpoint and never opens the database or acquires ownership.

```sh
node src/cli.mjs health --config ./agent/agent.yaml
node src/cli.mjs status --config ./agent/agent.yaml --limit 20
node src/cli.mjs status --config ./agent/agent.yaml --state uncertain --limit 20
node src/cli.mjs approvals --config ./agent/agent.yaml --limit 20
```

For Compose, use `docker compose exec mail-agent node /app/src/cli.mjs health --config /bundle/agent.yaml`. Substitute the other commands and flags as needed. A stopped daemon reports non-ready health; a stopped status/approval command may open the state as its sole operator owner.

The production image installs application dependencies during construction and removes global npm/npx/Corepack afterward. Provision reviewed stdio MCP executables and their dependencies during image construction, or mount their complete reviewed bundle read-only. The default image supplies Node and Mail Agent; it does not install MCP servers on demand.

## Reading status

| Field | Meaning |
| --- | --- |
| `sync.baseline` | `not-started`, `in-progress`, `complete` or `invalid`. Existing messages are skipped throughout the first baseline. |
| `sync.lastAttemptAt` / `lastSuccessAt` | UTC Unix milliseconds for the latest intake attempt and successfully committed page. A failed page cannot advance the success timestamp or checkpoint. |
| `sync.retryNotBefore` | Earliest next Graph-dependent operation after a provider wait; persists across restart. `null` means no recorded wait. |
| `sync.lastFailure` | Latest unresolved configuration/mailbox failure: safe category, occurrence time and resolution time. |
| `counts` | All retained runs counted by state, independent of the current page/filter. |
| `backlog` / `approvals` / `uncertainty` | Work ready/in progress, pending exact approvals, and unresolved send/tool outcomes. |
| `failures` | Latest failure per configuration, mailbox, model, MCP and send boundary. Resolved entries retain the original occurrence and `resolvedAt`. |
| `recovery` | `null` for ordinary state, or a durable restore hold with snapshot/time metadata. A hold requires explicit reconciliation before execution. |

Times are epoch milliseconds; absent observations are `null`. Failure categories contain no provider body, credentials, mail or attachment contents. The legacy `dependencyError` field remains a general intake error; use the new fields for detail. Status pages contain run metadata rather than message/reply/tool contents. Approval pages intentionally show the exact proposed arguments to the local operator; treat their output as private.

Pages default to 100 items and permit `--limit 1..100`. Feed the returned `nextCursor` into `--after CURSOR` with the same command and filter. A full final page may return a cursor whose next page is empty. Immutable admission sequence/run identity keeps updates from moving a run across the cursor; filters still observe current state rather than a frozen snapshot. No-flag `approvals` retains its array format, capped at 100; supplying pagination flags returns `{items,nextCursor}`. Pending approvals also count toward admission capacity.

## Reading health

Health exits zero only when `live` and `ready` are both true. Liveness means the current daemon can answer through its owner-only Unix socket. Readiness requires a complete baseline, a recent committed intake page, no active intake/configuration failure and no future provider wait. A poll becomes stale after the larger of 60 seconds or three configured poll intervals.

Non-ready reasons distinguish `not-running`, `control-unavailable`, `shutting-down`, `recovery-required`, `invalid-cursor`, `provider-backoff`, `intake-failed`, `baseline-pending` and `intake-stale`. Approvals/uncertainty are separate attention counts; they do not themselves make intake unhealthy. Health answers outside the execution queue while a provider operation is pending. It is not a per-request success or recipient-delivery guarantee.

Do not restart repeatedly to clear `provider-backoff`: the deadline survives restart. Inspect failure categories and run `doctor --live` explicitly when troubleshooting. A cursor failure never resets the baseline automatically. Pending approvals require review of exact intent; uncertain effects require authoritative provider/adapter evidence before reconciliation.

## Retry and retention contract

First-party records use the [stopped operator procedure](records-inbox.md):
`records-intent` exports a content-free binding, the dedicated adapter inspects its
authoritative root, and `reconcile-records` applies an attributed decision without
calling a connector. Confirmed non-writes need fresh approval; unknown outcomes
retain their fence. Agent backups do not include the separate business root.

Eligible Graph GETs and client-credentials acquisition use at most three logical attempts within one configured mailbox timeout and the caller's remaining budget. Selected transient HTTP/network failures use jittered exponential backoff; `Retry-After` is a minimum wait. Credentials, denied access, TLS failures, malformed/oversized responses and invalid cursors are not retried. Inference, MCP calls and reply sends are not replayed by this policy.

A provider wait beyond that budget defers Graph-dependent work and is recorded durably before a wait can be interrupted by shutdown. Local/model/MCP work requiring no Graph access may drain; metadata checks, envelope refreshes, polling and replies wait until the provider deadline. Throttled metadata remains queued rather than generating an unsupported-document reply. Normal authorization, execution budgets and uncertainty fences still apply. Do not treat a provider's accepted send as verified delivery.

Retention processes capped batches and yields between them before intake resumes. Exact expiry checks also prevent an expired job from resuming. Content-free replay identities and effect fences remain indefinitely. Monitor the private volume: capped queries control per-query work, not retained metadata size.

State schema 5 is independent of configuration schema 1 (text) or 2 (experimental documents). Opening an unversioned/v1/v2 store performs an atomic one-time projection backfill; v3/v4 upgrade without altering retained records, and v5 adds durable artifact references and retirement. This includes offline status/approval commands that become the sole state owner; preserve a consistent stopped backup before using a new binary. Newer state versions are rejected before ownership changes. Automatic downgrade is unsupported; do not run an older binary against migrated state. See [backup, restore and upgrade procedures](recovery.md). Stopped inspection, reviewed reconciliation batches and both audited release modes are supported under that bounded operator procedure.

Artifact cleanup retires references in SQLite before deleting private files.
Known expired runs are swept immediately after retention commits; interrupted
cleanup is retried through the durable retirement queue and a bounded,
cursor-based known-run sweep. The sweep visits ten run records per maintenance
tick, so crash-orphan cleanup latency depends on retained history and polling.
Unknown run directories and unsafe/extra files require operator review and are
retained. An unresolved `failures.artifacts` entry reports cleanup attention
without private contents or paths. Keep filesystem and backup retention aligned
with the content policy; byte expiry blocks use immediately even when deletion
awaits a later safe sweep.
