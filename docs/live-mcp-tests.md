# Opt-in live MCP acceptance

MA-008 qualification uses `npm run test:live:mcp -- ...`. It runs the actual runtime, inference SDK, Graph adapter and a dedicated stdio MCP server. It is an acceptance tool from the source checkout, excluded from the installed package. MCP remains experimental until the qualification gates summarized in [public acceptance](public-acceptance.md) are met; source delivery state is maintained in `docs/roadmap/ROADMAP.md`.

## Preconditions and effects

Use a dedicated test mailbox with **every other consumer stopped**, an independent authorized sender, a working configured model endpoint, and the private credentials described in [live email tests](live-tests.md). Verify the endpoint and tool capability before sending mail; an example URL is not a live dependency. Production identity, transport and recipient gates apply unchanged. Administrator verification of trusted headers remains required.

The source bundle must contain no MCP connections or tool policies. The runner copies its mail/model configuration into new private temporary state and supplies only the reviewed synthetic adapter under `test/fixtures/live-mcp/` in the source checkout. It enables tool inference for that copy, grants one automatic read and requires exact local approval for one fixed note in a fresh UUID namespace. It does not grant authority over business records or modify the source bundle.

Each invocation submits **one synthetic email**. A successful ordinary case performs the injection read, pauses for the exact write proposal, restarts, grants that proposal using the specified local actor, confirms one durable fixture write, and submits one reply. A second restart/replay must produce no new model/tool/send attempt. The runner verifies the reply body and sole recipient in the agent's Sent Items. It does not read or prove arrival in the sender's inbox.

```sh
npm run test:live:mcp -- \
  --config ./agent/agent.yaml \
  --sender-env-file ./private/live.env \
  --sender-token-file ./private/sender-token.json \
  --sender-address sender@example.org \
  --actor operator@example.org \
  --approve-synthetic-write \
  --timeout-seconds 300 \
  --report ./private/mcp-report.json
```

`--approve-synthetic-write` explicitly authorizes the runner to approve only its exact dedicated fixture proposal. The local actor is audit attribution under host access control; it is not independent email authentication. The suite never accepts email or tool output as approval.

## Failure cases and evidence limits

`--failure-mode before-write` returns a controlled adapter error before persistence; `after-write` persists the note/audit and then returns an error. Each is a separate invocation with one new email. Both must remain uncertain after restart, attempt the write once, and send no reply. Their fixture ledgers establish respectively zero and one write; neither error response authorizes an automatic retry. These are controlled errors, not proof of a real process crash during a live write.

The adapter advertises a forbidden tool, but runtime policy excludes it from model-visible tools. A deterministic policy probe confirms its rejection; the report does not claim that the real model attempted a forbidden call. Synthetic tests separately force forbidden calls and malformed arguments. Tool-result injection remains in tool context, and the live case must still observe the read, exact approval, confirmed write and correct reply.

Separate source-checkout caller-process crash tests use genuine `SIGKILL` before dispatch and after a real stdio fixture commit, before the runtime records completion. They prove restart fencing with scripted model/mail; they do not substitute for a live Office 365 interruption or provider crash inside its transaction.

The total deadline is 10–600 seconds, including polling and approval continuation. Individual dependency calls are bounded. Deadline/cancellation cannot authorize a later write. Progress and reports contain markers, counts, hashes and fixed error codes, without provider bodies, credentials or unrelated mail. A dependency failure may cause the runtime's ordinary deterministic failure reply; this is a failed qualification, even when Graph accepts it.

Success in ordinary mode removes temporary test state only after evidence checks. Failures and controlled uncertainty cases preserve private state under `mail-agent-mcp-<marker>-` in the temporary directory. Reports use new owner-only files and refuse overwrite. Test emails remain in the mailbox. Inspect authoritative provider and fixture evidence before retrying an uncertain effect; restart alone is not reconciliation.

## Recorded ordinary live result

A bounded Office 365/real-model/stdio fixture journey passes one read, exact local
approval across restart, one write/audit, one threaded reply and no-effect replay.
The independent test recipient Inbox separately verifies arrival; the runner
itself still uses only agent Sent Items for reply checks. No new permission is
added, and no business adapter is exercised. The forbidden-tool result is the
deterministic policy probe described above. The ordinary case does not establish
live controlled-failure or process-interruption outcomes, full tenant grant/send
scope or protected-header trust. MCP remains experimental until the remaining
qualification and dependency gates in [public acceptance](public-acceptance.md)
are met.
