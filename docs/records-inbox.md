# Experimental records inbox

This recipe adds one dedicated folder-backed MCP server to one mailbox. Record
files are business truth; Mail Agent state tracks runs and approvals. Qualification
status and first-release limits are summarized in [public acceptance](public-acceptance.md); this recipe remains experimental.

## Configure

Start with [the bundle](../examples/records-inbox/agent.yaml), its instructions and
actor policy. Configure the mailbox/model using the [setup guide](quickstart.md).
Agent ID, mailbox, requester and approver must agree in both policies. Sender
admission does not grant record visibility. Scope lists name explicit record IDs.

The example uses container paths: mount your private bundle read-only at `/bundle`,
agent state at `/state` and a separate persistent records root at `/records`, owned
by service UID 1000. Create `records/record-a/record.json` inside that records root
from the synthetic seed. Directories are `0700`, files `0600`. For a Node install,
change the server argument to the installed package's `mcp/records/server.mjs`
and choose absolute private root/policy paths. The default text setup stays unchanged.

Reads and proposals are automatic; apply tools require exact local approval.
Proposal arguments bind the record revision and content hash. A conflict requires
a fresh proposal. Optional coordination notes use ordinary approved records;
there is no separate memory or search-index service.

## Reconcile an uncertain write

Stop the mailbox daemon and its child adapter. Keep the records root quiescent
until the decision is applied. `ACTION_SHA256` is the exact approval ID previously
shown by `mail-agent approvals`; it is also the adapter operation ID in its
private ledger/pending fence. Replace the placeholders and use the same policy.

```sh
umask 077
mail-agent records-intent --config /bundle/agent.yaml --action ACTION_SHA256 \
  --actor operator@example.org --reason "Inspect the uncertain records action" > intent.json
node /app/mcp/records/server.mjs inspect --root /records --policy /bundle/actor-policy.json \
  --intent intent.json --actor operator@example.org --reason "Inspect authoritative records" > receipt.json
mail-agent reconcile-records --config /bundle/agent.yaml --action ACTION_SHA256 \
  --receipt receipt.json --actor operator@example.org --reason "Verified the stopped authoritative receipt"
```

The receipt is an operator attestation backed by host access controls. Review it
against the authoritative adapter; copying an arbitrary tool response is not
proof. Unknown/unresolved outcomes retain the fence. Confirmed commits are recorded
without another write. Confirmed non-writes require a fresh exact approval before
retry. Expired content is not restored. Restart the daemon after the decision.

Inspection leaves the adapter fence in place. A later exact-approved change may
settle a prior commit only from matching intent, pending binding and current
record marker, saving the original receipt and audit before proceeding. Unresolved
evidence continues to block changes.

## Retention and recovery

Deletion clears the current record content and leaves a tombstone and content-free
provenance. Operator copies, interrupted temporary files and backups require their
own retention decisions; this is not secure erasure. Keep the entire records root,
including operation receipts and pending fences, in stopped backups. The agent's
`backup` command covers agent state/artifacts, not this business root. Restore both
to consistent snapshots and reconcile uncertain actions before resuming.

Agent restore starts held. Follow the [recovery procedure](recovery.md), keep
unresolved records runs/actions fenced, and release the hold only after reviewing
the whole recovery window. Hold release preserves business-write uncertainty.
Then use the stopped records inspection/reconciliation procedure above before
starting the mailbox daemon. Unknown outcomes stay fenced.

Limits, tools and authorization details are in the [adapter README](../mcp/records/README.md).
Generic MCP and HTTP do not receive actor context. Linux/image and live-mail
qualification remain required before advertising the recipe as supported.
