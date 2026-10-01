# Records MCP server

This is an experimental first-party, folder-backed records adapter. Its human-readable `records/<id>/record.json` files are authoritative. Keep the root and policy owned by the service operator and mode `0700`; record and policy files must be owned by the service UID and private. The adapter rejects symlinks, hard links, unsafe modes, oversized files, and unknown record fields.

Run one dedicated stdio process for one agent mailbox:

```sh
node mcp/records/server.mjs --root /private/records-root --policy /private/actor-policy.json
```

The containing Mail Agent configuration must set the `records` connection to stdio and opt in with `actor_context: mail-agent-v1`. The server advertises `experimental.mail-agent/actor-context` version 1 and requires the authenticated, namespaced invocation context on every tool request. It reloads the private policy for each invocation. It is not intended for HTTP transport or sharing between deployments.

Policy revocation denies subsequent requests; it does not cancel an operation
already in progress. Stop the owner and inspect its outcome when an immediate
operational cutoff is required.

`actor-policy.json` has this shape:

```json
{
  "version": 1,
  "agentId": "configured-agent-id",
  "mailbox": "agent@example.test",
  "connection": "records",
  "members": {
    "reader@example.test": {
      "read": ["record-a"],
      "edit": ["record-a"],
      "delete": []
    }
  },
  "approvers": ["operator@example.test"]
}
```

Scope lists are sorted, unique, explicit record IDs; wildcards are rejected. The initial tools are `search`, `get`, `propose_update`, `apply_approved_update`, `propose_delete`, `apply_approved_delete`, and `operation_status`. Proposals are read-only. Updates and tombstones require exact local approval context and matching record revision/hash. Generic automatic tool policy cannot authorize a write. `operation_status` never releases an unresolved write fence.

The local `inspectOperation({intent, actor, reason})` method returns a content-free receipt for operator reconciliation; it is not an MCP tool. Approved commits store immutable receipts at `operations/<operationId>.receipt.json`. Inspection follows `src/records-reconciliation.mjs`, records an audit event, and leaves pending fences in place. Unknown or unresolved results do not authorize writes. The adapter maintains a SQLite exclusive process lease only to serialize local folder operations; it does not store record truth in SQLite.

Inspect a private intent file while the server is stopped:

```sh
node mcp/records/server.mjs inspect --root /private/records-root \
  --policy /private/actor-policy.json --intent /private/intent.json \
  --actor operator@example.test --reason "Reconcile the interrupted update"
```

The command emits one JSON receipt to stdout, performs no MCP dispatch, and closes its local lease before exiting. The host must keep the root quiescent during reconciliation.

No connector, external service, or model call is made by this server. Record content returned to the model is untrusted input. Do not use this adapter for confidential data until the complete runtime approval and restore/reconciliation path has been qualified for the deployment.
