# Backup and restore

The experimental [records recipe](records-inbox.md) has a separate authoritative
business root. Preserve its receipts and pending fences in stopped backups;
Mail Agent snapshots do not include that root. Its explicit local reconciliation
does not replace the restore hold or release procedure below.

Mail Agent state contains the intake cursor, queued work, approvals, delivery records and effect fences. Keep one active owner per mailbox and state root. Back up consistent state while the daemon is stopped, before an upgrade or before planned maintenance. A backup preserves local state; it does not include the configuration bundle, instruction files or deployment secrets.

## Create and protect a backup

Choose a new, absent snapshot directory beneath a private parent owned by the operator. The command refuses an existing destination and requires the daemon to be stopped. It writes a private SQLite snapshot and manifest, then publishes the manifest as the completion marker:

```sh
node src/cli.mjs backup --config ./agent/agent.yaml --directory /private/backups/mail-agent-2026-10-01
```

Keep the backup on a protected filesystem and set a retention policy appropriate for mailbox and audit data. The snapshot can retain private operational content and must receive the same access controls as the state volume. The manifest SHA-256 detects accidental corruption; it is not a signature or proof of who created the snapshot. Store and transfer backups through a trusted channel.

For Compose, mount a separate protected host backup directory at a private path in the one-shot command, and use that path for `--directory`. Keep the persistent state volume mounted at `/state`; do not place backups in the read-only `/bundle` or inside the live state directory. A restore target must be a new path on the state volume, such as `/state/restored`.

## Restore into a fresh state root

Use the same mailbox configuration and identity that produced the backup. Preserve the configuration and instruction versions separately, along with the secret-manager references and the credentials needed to perform read-only checks. Restore refuses an existing target. The parent must be private and owned by the runtime identity; in the standard Linux Compose deployment that is uid/gid `1000:1000`. The restored root is created owner-only, and its database is owner-readable and writable. Mount the backup separately and read-only when practical.

```sh
node src/cli.mjs restore --config ./agent/agent.yaml \
  --snapshot /private/backups/mail-agent-2026-10-01 \
  --actor operator@example.org \
  --reason "Restore after state-volume loss"
```

For Compose, first ensure the named state volume is initialized for uid/gid `1000:1000`, then mount it at `/state` and the selected snapshot directory at a separate read-only path. Set `state_root: /state/restored` in the matching configuration before running restore. The snapshot is checked for private ownership and permissions, expected mailbox identity, supported format and state version, and matching content checksum. State schema 5 is the current restore target; older snapshots are migrated by the restore worker while preserving their durable records.

Current backups use format 2: a consistent database, an exact live-artifact
inventory and its private image/transcript bytes and manifests. Text-only
backups have an empty inventory. Format-1 snapshots from schema 4 or earlier
remain readable under their original database-only contract. Missing, modified,
linked, extra or expired still-referenced artifacts prevent backup/restore;
there is no content substitution. Retired artifacts and unreferenced source
orphans are omitted. Protect source orphans separately when investigating an
incident. Restore stages all inventoried assets before publishing the held
state; interrupted publication cannot initialize an empty runtime.

Format 2 currently limits the inventory to 100 live artifacts. The existing
maintenance byte/deadline bounds also apply to database and asset work; exceeding
them fails visibly. Review capacity before using this experimental recipe at a
larger volume. Expired still-live references must be retired through normal
retention before a complete snapshot can be taken.

Restore records the operator attribution and reason in the local audit history. It also writes a durable recovery hold before publishing the restored database. The hold survives restart and fails closed if its record is malformed.

The worker rejects unexpected or modified schema objects before migration and verifies the persisted hold afterwards. Restoring another backup of held state preserves the earliest unresolved snapshot boundary. A durable publication reservation blocks startup after an incomplete restore; preserve any interrupted target and its markers for inspection rather than deleting markers to initialize an empty state root.

## Recovery hold and reconciliation

While held, Mail Agent blocks daemon start, live checks, message processing, approvals and uncertainty resolution that could cause execution or change effect history. `status` and `approvals` remain available for inspection. `doctor --live` performs configured read-only Graph, model and MCP checks; it sends no email and invokes no MCP tool. A passing probe verifies connectivity only. It does not establish mailbox scope, transport trust, sender permissions, pending-send outcome or tool-write outcome.

Held inspection skips ordinary restart recovery, preserving unexpired in-flight reservations and action state. Configured content retention still applies: expired mail, replies, arguments and approval content are removed, expired pending work fails, and message identities and effect fences remain. Image/transcript references are retired transactionally before private bytes are collected; a durable cleanup queue survives interruption. Missing or changed saved artifacts prevent inference, MCP effects and attachment delivery. An uncertain send remains uncertain even after its bytes expire. Use protected snapshot/provider evidence to reconcile expired work; expiry does not establish an external outcome.

For a stopped held deployment, inspect recovery records with:

```sh
node src/cli.mjs recovery-inspect --config ./agent/agent.yaml --kind runs --limit 20
node src/cli.mjs recovery-inspect --config ./agent/agent.yaml --kind actions --limit 20
```

Feed each returned `nextCursor` into `--after` with the same kind. Inspection returns snapshot/binding/checkpoint digests and exact row fingerprints; it prints neither raw content nor the provider cursor and does not apply runtime recovery or retention. Normal `status`/`approvals` startup still applies retention. Keep the old deployment stopped throughout reconciliation; restored state cannot determine effects from another running copy.

### Preview and apply reconciliation decisions

Keep both the old and restored deployments stopped. Prepare a private UTF-8 JSON plan, at most 1 MiB and 100 operations, in an operator-owned regular file with mode `0600` and no links. Inspection supplies `mailboxIdentity`, `configHash`, `binding`, `recovery.snapshotId` and each target's exact `fingerprint`. Copy those values into the plan; changing configuration, the hold, checkpoint or target record invalidates the corresponding review.

The plan has exactly these fields:

```json
{
  "format": 1,
  "mailboxIdentity": "COPY_FROM_INSPECTION",
  "snapshotId": "COPY_RECOVERY_SNAPSHOT_ID",
  "binding": "COPY_FROM_INSPECTION",
  "configHash": "COPY_FROM_INSPECTION",
  "operations": [
    {
      "kind": "run",
      "id": "COPY_RUN_ID",
      "fingerprint": "COPY_RUN_FINGERPRINT",
      "outcome": "fenced",
      "evidence": {
        "source": "operator",
        "recordHash": "SHA256_OF_PROTECTED_EVIDENCE",
        "observedAt": 0
      }
    }
  ]
}
```

Replace every placeholder and `observedAt` with the evidence observation time in Unix milliseconds, between snapshot creation and the present. Retain the underlying evidence privately; the plan contains its SHA-256 reference. Plans and command attribution are local operator attestations. A source label or hash does not independently prove a provider outcome.

| Target | Outcomes and requirements |
| --- | --- |
| `run` with `id` and `fingerprint` | `resume` requires Graph/adapter evidence of no effects, retained valid mail, known remaining budget and resolved in-flight actions. Normal runtime authorization still applies. Pending approvals and existing grants remain unchanged. `sent` requires recorded send intent and Graph acceptance evidence. `fenced` retains uncertainty; `skip` abandons work as failed only with evidence of no effects and no unresolved send/action. Completed/ignored history cannot be rewritten. |
| `action` with `key` and `fingerprint` | `no-effect` requires adapter evidence and changes executing/uncertain work to pending. `fenced` leaves it uncertain. Existing results cannot be replaced or fabricated. |
| `message` with `messageId` and `conversationId` | For a missing immutable provider identity, `sent` requires Graph acceptance evidence; `fenced` records unknown effects. Both create a content-free replay identity. Already-known messages are rejected. |

For a resumed tool run, include the matching action absence decision in the batch or apply it first under the same recovery binding. Investigate both Graph and configured adapters: absence of a sent email alone does not establish absence of business writes. Missing or malformed historical budgets can be fenced or abandoned but cannot be renewed for execution.

```sh
node src/cli.mjs recovery-preview --config ./agent/agent.yaml --plan ./recovery-plan.json
node src/cli.mjs recovery-apply --config ./agent/agent.yaml --plan ./recovery-plan.json \
  --digest COPY_PREVIEW_PLAN_DIGEST --actor operator@example.org \
  --reason "Reconciled against protected provider and adapter evidence"
```

Review the preview's exact decisions and use its `planDigest`. Apply validates every original target before committing any changes, audits and receipt together. Retrying the same plan with the same digest, actor and reason returns `idempotent: true` without duplicate decisions. Inspect again before preparing another batch. Neither command initializes adapters, sends email or removes the hold.

### Review and release recovered state

Keep the old deployment stopped throughout reconciliation and release. Reconcile every executable run with the plan commands above. Unknown effects may remain explicitly fenced; release enables safe intake without making those effects repeatable. A recovery batch or a consistent snapshot alone cannot establish that later messages and business effects have all been found.

Prepare a second private JSON file with the exact fields below. Copy identity/binding/configuration values from current inspection, set `coverage.from` to `recovery.snapshotCreatedAt`, and replace the other zero timestamps with actual Unix milliseconds. `through` must include the restore and old deployment's stop and cannot be in the future. The old stop may precede the snapshot if the source never restarted. Hash a protected evidence record covering every relevant Graph and adapter source, including adapters from the old configuration; `allSources: true` explicitly attests that coverage.

```json
{
  "format": 1,
  "mode": "continuity",
  "mailboxIdentity": "COPY_FROM_INSPECTION",
  "snapshotId": "COPY_RECOVERY_SNAPSHOT_ID",
  "binding": "COPY_FROM_INSPECTION",
  "configHash": "COPY_FROM_INSPECTION",
  "coverage": {
    "from": 0,
    "through": 0,
    "oldOwnerStoppedAt": 0,
    "evidenceHash": "SHA256_OF_PROTECTED_WHOLE_WINDOW_EVIDENCE",
    "allSources": true
  },
  "acceptHistoryGap": false
}
```

Choose one path:

| Mode | Checkpoint and effects |
| --- | --- |
| `continuity`, `acceptHistoryGap: false` | Preserve the original completed Graph checkpoint. Reconstruct missing identities/effect fences from whole-window evidence first; later no-effect messages can enter normally from that checkpoint. Preview performs no network calls. |
| `history-gap`, `acceptHistoryGap: true` | Explicitly accept missing inbound history. Preview uses the configured Graph credential to read a fresh baseline while held. It stages the resulting private cursor and reports the skipped interval through baseline observation. Existing queued work, approvals and unknown effects still require reconciliation; they are not discarded. |

```sh
node src/cli.mjs recovery-release-preview --config ./agent/agent.yaml \
  --plan ./recovery-release.json --actor operator@example.org \
  --reason "Reviewed the complete recovery window"
node src/cli.mjs recovery-release-apply --config ./agent/agent.yaml \
  --plan ./recovery-release.json --digest COPY_PREVIEW_REVIEW_DIGEST \
  --actor operator@example.org --reason "Reviewed the complete recovery window"
```

Review the mode, coverage, executable-work count, checkpoint digests and, for a gap, `skippedHistory`. Apply needs the exact `reviewDigest`, actor and reason from preview. It performs no network calls. Changing executable work, configuration, checkpoint, hold or staged review requires new reconciliation or preview. Waiting approvals must still match the original pending call, current policy and expiry; existing grants are never renewed. Runtime authorization remains in force after release.

Each command is limited to 60 seconds and 10,000 executable runs, read in metadata pages of at most 100. Gap baseline reads are additionally capped at 100 pages and 10,000 messages. Cap exhaustion, provider failure, unfinished/invalid baseline, cancellation and stale proof leave the old checkpoint and hold intact. Provider retry deadlines persist across failed baseline attempts. Nothing automatically resets an invalid or expired checkpoint; continuity validates its format and mailbox scope, while provider acceptance is checked by ordinary polling. If a preserved cursor is later rejected, take a new stopped backup and restore into a fresh held root for an explicitly reviewed gap procedure.

Successful apply commits the checkpoint choice, release audit, receipt and hold removal together. An exact retry before the daemon advances that checkpoint returns `idempotent: true`; a newer hold or advanced checkpoint cannot be cleared by an old receipt. Confirm `status` reports `recovery: null`, then start only the restored deployment and check `health` after its first successful poll. Retain the original state, protected evidence and snapshot according to the backup policy.

Do not clear holds or checkpoints with SQL, delete replay identities, replay approved actions, or infer an external outcome from missing local data. Unknown business effects still need adapter-specific reconciliation without fabricated results or bypassing governed approval.

Ordinary outage recovery continues to use the existing durable queue and effect fences. Restarting does not clear provider retry deadlines or uncertain outcomes. A send or external write whose result is unknown must remain fenced until authoritative evidence supports its reconciliation; it must never be retried blindly.

## Credential rotation and upgrades

For credential rotation, stage replacement secret values in the deployment secret manager without changing mailbox identity, client ID, permissions or resource scope. Run `doctor --live` with the replacement values to make read-only probes, switch the deployment to those values, and confirm health. Revoke the old secret as a separate administrator action after the replacement is active. Never store secret values in the bundle, snapshot or image. If the provider does not allow overlapping credentials, plan the outage and preserve the state root.

Before upgrading, stop the daemon and take a fresh backup. After migration, do not point an older binary at newer state: unsupported state versions fail closed, and automatic downgrade is not supported. For rollback, restore a compatible pre-upgrade snapshot into a fresh root and follow the same recovery-hold procedure; do not replace or reuse the current state directory. Keep the post-upgrade state and snapshot until recovery and rollback decisions are complete.
