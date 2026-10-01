# Model endpoint reference evaluation

MA-009 provides a source-checkout command for one configured endpoint and a fixed synthetic text recipe. It uses the actual inference SDK. It sends no mail, executes no tools, connects to no MCP server and acquires no runtime state. It does not use the bundle's customer instructions or qualify arbitrary recipes.

```sh
npm run test:live:model -- --config ./agent/agent.yaml --run \
  --timeout-seconds 120 --report ./private/model-report.json
```

Supply only the model's configured secret environment variable. Graph/MCP credentials are not needed. The config and instruction files must still validate, but their contents are not included in inference. `--run` explicitly permits synthetic inference requests, which may incur provider charges. The report directory must already exist, be owner-owned with mode `0700`, and have no symlinks in its resolved path. A new `0600` report file is reserved before inference; existing files are never overwritten.

Five fixed cases check arithmetic, a German greeting, exact structured extraction, a missing-document clarification and quoted-input injection. These are narrow, reproducible rubrics. The ambiguity case supplies its required question; it checks obedience to that reference task, rather than general clarification quality.

Add `--probe-tools` only when the config already declares `model.capabilities.tools: true`. This adds an exact read proposal with no prose and one continuation using a hostile synthetic tool result. The proposal is never executed. There are at most seven requests, one provider request per case, no retries, an overall 10–300 second deadline, per-call timeout at most 30 seconds, 256 output tokens and a 4 KiB accepted text bound. An invalid proposal skips its continuation; a dependency failure stops further requests. Images and PDFs are visibly unsupported in this evaluator.

## Reading evidence

Reports contain per-case pass/fail/not-checked, fixed codes, request counts and hashes of the endpoint, requested alias and observed aliases. Prompts, responses, URLs and credentials are excluded. A missing or unexpected returned alias fails the identity check; the command does not invent a mapping. Exact alias equality does **not** verify model weights. A failed run exits nonzero; `qualificationComplete` remains false even for a passing reference suite.

For the MA-009 capability matrix in source-checkout `docs/roadmap/ROADMAP.md`, retain separate reports and administrator/provider evidence for two independently hosted endpoints, including reviewed alias mapping and model identity. An authenticated temporary relay must be identified in evidence together with the upstream endpoint hash; its loopback URL is not a second hosting provider. Re-evaluate after changing the endpoint, model, SDK or reference recipe.

Keep deterministic SDK/wire tests, actual endpoint evaluations and [whole-email/MCP acceptance](live-mcp-tests.md) separate. None substitutes for protected mail headers, mailbox scope, recipient arrival, genuine tool effects, business authorization or customer recipe quality. Current qualification limits are summarized in [public acceptance](public-acceptance.md); detailed source-checkout evidence is maintained in `docs/implementation.md`.
