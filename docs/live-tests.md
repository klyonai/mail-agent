# Opt-in live email acceptance

Commands in this guide require the source checkout. Acceptance scripts are not
included in the installed package; running the mailbox agent does not require
these test scripts or delegated sender credentials.

For the separate approval-bound synthetic MCP journey, see [live MCP acceptance](live-mcp-tests.md). This text suite rejects MCP connections.

The default suite sends two uniquely labelled synthetic emails to the configured agent mailbox: arithmetic and a quoted wrong-answer instruction. `--german` adds a German response case; `--model-failure` adds a controlled injected-failure case; `--text-scenarios` adds clarification, follow-up and sender-denial checks described below. It runs the actual runtime, checks reply text and recipients in the agent mailbox's Sent Items, then restarts and replays intake to verify exact reply counts.

This is a real external-effects test. Use a dedicated test mailbox with a text-only bundle and no MCP connections or tool policies. The suite rejects business connectors, never deletes existing mail, and leaves its synthetic messages in the mailbox. It establishes a fresh baseline and uses separate temporary private state; production jobs and checkpoints are untouched. Only exact synthetic subjects from the expected sender enter its queue, including the explicitly registered follow-up when enabled. Normal sender authentication and recipient policy remain enforced.

Stop every other agent consuming this test mailbox before running the suite. Its temporary state does not acquire the normal deployment's ownership lock, and another consumer could independently act on the synthetic requests. Prefer a mailbox used only for acceptance testing.

The mailbox application needs scoped read/send authority. Real inference also needs a configured model endpoint and secret. The live suite sends the test messages from a separate delegated sender with `Mail.Send`; [sender setup](live-sender-setup.md) explains the external token acquisition prerequisite. Invoking the script authorizes only its bounded synthetic messages and replies.

## Independent sender

Use a separate operational sender account with an active Exchange mailbox. The runner does not acquire the first delegated token; it accepts an owner-only token cache created by a tenant-approved exporter using public-client flow. See [delegated sender setup](live-sender-setup.md).

The runner expects a private cache containing exactly the values it uses: `accessToken`, `refreshToken`, and `expiresAt`. It accepts expiry in milliseconds, seconds, or ISO date form. A private environment file can provide `LOCAL_SENDER_TENANT_ID`, `LOCAL_SENDER_CLIENT_ID`, `LOCAL_SENDER_ALLOWED_RECIPIENTS`, and the exact agent secret variable names. Alternatively supply them through the process environment. Generic credential names are not remapped to the agent's configured references.

`LOCAL_SENDER_ALLOWED_RECIPIENTS` is a comma/space-separated allowlist and must include the configured agent mailbox. The sender must also appear in the agent's sender and recipient policies. The runner checks token tenant/address/scope claims only as hints; Microsoft validates the credential and delegated authority. It refreshes an expired access token with Microsoft and updates the private cache. The sender token requires only delegated `Mail.Send`; the runner does not use the sender's `Mail.Read` permission.

Delegated mode requires a sender address different from the agent mailbox. Self-mail cannot establish independent sender evidence.

```sh
node scripts/live-email-e2e.mjs \
  --config ./agent/agent.yaml \
  --sender-env-file ./private/live.env \
  --sender-token-file ./private/sender-token.json \
  --sender-address sender@example.org \
  --german --timeout-seconds 300 \
  --report ./private/live-report.json
```

The environment and token files must be owner-only regular files owned by the user running the command. Keep the containing directory private as well. The script rejects group/world-accessible credential files and never prints token values. Do not put either file in the agent bundle, source control, or a report directory shared with others.

## Injected model failure

Add `--model-failure` to exercise the deterministic unavailable-model path during real Graph intake/send. It adds one synthetic `model-unavailable` request and injects a fixed HTTP 503 at the model-fetch boundary through the actual SDK. It makes no upstream model request for that case; the other cases still use the configured real model. The suite verifies one exact failure reply (`The configured service failed or the execution budget expired. Confirmed actions will not be repeated.`) and that restart/replay does not retry the failed model call. This is an **injected** 503, not evidence of an actual provider outage. The option is incompatible with `--transport-only`.

When enabled, the report includes `modelFailure` with `source: "injected"`, `status: 503`, `interceptedRequests: 1`, `upstreamRequests: 0`, and `restartNoRetryVerified: true`. A successful injection result establishes the runner's controlled failure behavior only; it does not establish recipient arrival.

## Follow-up, clarification and sender denial

Add `--text-scenarios` to the independent-sender command. This adds a request
that needs one clarification question, a MIME follow-up asking the model to use
its previous arithmetic answer, and one denied-sender request. Without other
flags, the suite submits five requests and expects four replies; `--german`
and `--model-failure` each add one request and reply.

The follow-up references the observed agent reply's Internet Message ID. The
suite requires the incoming follow-up to have the original conversation ID
before allowing inference, then requires exactly two matching replies in that
conversation. MIME references alone do not establish Exchange threading;
actual observed conversation identity is required. Sender authority remains
delegated `Mail.Send`, with no sender inbox read.

For denial, the suite temporarily removes the sender from only its private
configuration copy. The request must satisfy the original admission policy,
then be ignored with zero model/tool calls and zero replies under the narrowed
policy. Replay under that policy and after restoring the original copy must
preserve the terminal decision and budgets. Restoration also runs on failure;
the supplied agent bundle is unchanged.

Successful reports include `textScenarios` with clarification verification,
same-conversation reply count, and denial/restart/policy-restoration results.
The variable clarification text is represented by `clarification-requested`.
These checks do not establish recipient arrival or tenant access/header policy.

## Transport-only inference

`--transport-only` injects a deterministic synthetic model while preserving real Graph intake, runtime policy, send and restart behavior. Use it with the independent delegated sender above. Reports show `realModel: false`; this establishes observed mail transport behavior only. Omit it for actual model evaluation.

## Remaining acceptance gates

The optional paths have synthetic runner coverage. Bounded Office 365 acceptance
also verifies clarification, real-model same-thread follow-up, denied-sender
silence and zero-effect replay. A repaired clarification evaluator and a
continuation using saved state preserve the original failed attempt. Independent
Inbox observations verify all five text replies.

A fresh separate one-case injected SDK 503 journey verifies one interception,
zero upstream inference, one exact deterministic reply, unchanged model/send
counters after restart/replay, and independent Inbox arrival. The original
missing interception counter remains unreconstructed; the fresh result supplies
separate complete evidence rather than changing that record. This is controlled
injection, not a real provider outage.

The reviewed test application has scoped `Mail.Read`/`Mail.Send` roles and only
the agent mailbox in scope, with zero observed Entra administrator/user consent
grants; effective other-test-mailbox reads and sends return 403. Protected header
assurance remains open. A received Graph-MIME forgery normalized as unauthenticated
but lacked the wrapper's required control; a single Internet SMTP forgery was
rejected with 450 and provides no received-header evidence. Neither establishes
general protected-header trust. Record deployment-specific evidence under
[manual evidence](live-sender-setup.md#content-free-acceptance-evidence), without
raw mail, tokens or complete authentication headers in shared reports. The
suite's Sent Items check itself still does not prove independent Inbox arrival.

The runtime ignores messages sent by its own mailbox to prevent self-reply loops. The older `application-self` option is rejected by the suite before sending any mail. Historical self-mail results describe the earlier runtime; they do not establish current acceptance. Use a separate sender mailbox.

## Results and failure recovery

The total deadline is 10–600 seconds; individual HTTP calls are bounded. Progress reports contain phase/count metadata on each poll. Successful reports contain synthetic reply text, result flags, metrics and hashed identities. They exclude credentials, tokens, unrelated mail and source paths. The report path must be unused; files are created privately and never overwritten.

Success removes the temporary test state. Failure preserves it under the temporary directory prefix `mail-agent-live-<marker>-`; inspect provider evidence before retrying any uncertain send. The stdout progress marker identifies this directory without exposing credential locations. Failure output includes fixed safe codes or HTTP status, never provider bodies. Test emails remain in the mailbox for operator inspection.
