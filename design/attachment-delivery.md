# Image intake and text attachment delivery

Desired state for the document inbox. Delivery state and current support are recorded in the [roadmap](../docs/roadmap/ROADMAP.md) and [implementation record](../docs/implementation.md). The text inbox remains usable without enabling document processing.

## Image intake

An explicitly enabled multimodal image recipe may accept only supported image formats and a qualified endpoint that declares the required image capability. It validates attachment count, declared size, actual bytes, file signature, and aggregate work before inference. Validate decoded dimensions only when a bounded image decoder is used. MIME labels and inline flags are hints, not proof. Unknown or malformed attachments fail closed. Unsupported requests keep the deterministic explanation path and never send attachment bodies to inference.

Download only after sender and recipient authorization. Read attachment content through the mail adapter with response-size and deadline bounds. Keep original bytes and any derived text in private, run-scoped artifacts with immutable identifiers, content hashes, source message/attachment provenance, and configured expiry. Send the validated, bounded image as image input to the configured multimodal model; image contents and embedded instructions remain untrusted data. A separate parser, OCR step, or image processor is optional and, when used, runs with bounded memory, CPU, time, and filesystem/network access. Derived text retains source references and is untrusted input too.

The recipe returns a concise text answer and, when configured, a generated UTF-8 `.txt` transcript. It does not return original images or claim transcription certainty. Missing, corrupt, unsupported, oversized, ambiguous, model-failure, and optional processor-failure cases have explicit safe outcomes. PDF handling and searchable PDF generation require their own bounded processor contract and are not implied by image support.

## Delivery intent

Artifact delivery is an explicit recipe capability with separately reviewed Graph permissions. Before any provider write, persist an immutable delivery intent bound to the run, source message and conversation, authorized recipient, output artifact hash, filename, media type, byte length, and exact body. Revalidate current sender identity, conversation, recipient policy, artifact integrity, expiry, and approval immediately before sending. Never derive recipients or paths from model output, mail content, tool results, or arbitrary URLs.

The mail adapter accepts a narrow reply request containing the original authorized message identity, text body, and validated artifact bytes plus safe filename and media type. It owns MIME serialization and base64 encoding. The exact MIME payload and its hash are stable across restart for the same persisted intent; its deterministic boundary cannot occur in base64-encoded body or attachment parts. The initial contract supports only bounded direct-thread `.txt` attachments. It does not imply reply-all, CC delivery, arbitrary file types, upload sessions, external storage, or public links. If provider size limits or the configured grant do not support this request, fail visibly before sending; do not silently send a body-only reply. Graph's [reply endpoint](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0) accepts MIME content for replies with attachments.

Persist the send fence before the request. A definite pre-write failure can remain retryable within the original budget; an outcome that may have reached Graph remains uncertain and cannot be retried automatically. Reconcile using provider evidence before resolving it. A Graph accepted response means the provider accepted the reply, not that the recipient received or opened it. Preserve the exact artifact and intent through restart and approval waits, subject to retention; after expiry, the artifact cannot be sent and the run requires a new request or explicit reconciliation.

## Acceptance

Use synthetic mail and storage fixtures for automated coverage. Prove signature and size rejection, byte and extraction limits, untrusted prompt handling, source provenance, recipient/thread binding, exact attachment bytes and filename, no silent fallback, restart deduplication, cancellation, expiry, and definite versus uncertain send recovery. Verify that no write occurs before durable intent and that an uncertain delivery stays fenced after restart. Separately verify actual recipient arrival in a controlled mailbox before advertising delivery support.

MA-010 qualifies bounded image processing; MA-011 adds governed attachment delivery and whole-email evaluation. Neither changes the current text-only supported behavior until its acceptance criteria and external recipient-arrival evidence are complete. See [MA-010/MA-011](../docs/roadmap/ROADMAP.md#c--document-inbox-and-domain-integrations).
