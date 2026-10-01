# Bounded image inbox

Desired state for MA-010; enabling and acceptance remain governed by the [roadmap](../docs/roadmap/ROADMAP.md). The default recipe remains text-only. [Attachment delivery](attachment-delivery.md) adds the separate MA-011 output contract.

## Recipe and authority

An operator explicitly enables image intake for one mailbox and qualifies the configured OpenAI-compatible model's image capability. The initial recipe accepts PNG and baseline JPEG image documents and returns bounded text with source references and transcription uncertainty. PDF, animated images, progressive JPEG, linked files, embedded messages, mixed unsupported attachments and arbitrary URLs remain unsupported. An optional isolated processor may replace direct vision; OCR is not a mandatory dependency.

Authenticate and authorize the direct sender and original reply recipient before listing or downloading attachments. Repeat authority checks before inference and delivery. Unknown senders, automatic mail, self-mail, CC-only requests and mismatched Reply-To remain silent. Authorized unsupported requests receive the existing deterministic explanation without downloading unsupported contents or calling a model/MCP. Initial synchronization never probes old messages.

Inline images are not automatically trusted signatures. Initially reject inline artifacts rather than guessing which image is a signature or document. Metadata listing must be complete and bounded; ambiguous, missing or failed metadata does not authorize inference. A throttled read retains queued work and the persisted provider deferral.

## Input bounds and provenance

Use a complete attachment manifest before content reads. Initial ceilings are four images, 5 MiB per image, 10 MiB total encoded bytes and twelve million pixels per image, with a hard maximum of twenty million pixels; operators may choose stricter limits. Validate declared sizes, actual streamed bytes, declared type versus signature, PNG chunk/CRC ordering and JPEG marker/frame boundaries, dimensions, termination and the aggregate budget. Reject truncation, trailing payloads, unsupported frames and zero or excessive dimensions. Every read and validation consumes the existing run deadline and honors cancellation.

Header and container inspection establishes these structural bounds, not complete pixel decoding or malware absence. Any local decoder additionally requires bounded raster memory, CPU/time and isolated execution. The configured model is an approved destination for private image bytes; its decoder and image behavior require endpoint qualification and representative-document acceptance.

The Graph adapter reads only attachment IDs from that manifest beneath the configured mailbox and immutable source-message ID. It bounds responses, forbids redirects and never follows attachment URLs. Reference/item attachments are rejected. [Graph attachment reads](https://learn.microsoft.com/en-us/graph/api/attachment-get?view=graph-rest-1.0) provide the scoped raw-content endpoint and use Mail.Read; attachment reads do not require mailbox editing.

Persist private run-scoped artifacts using generated identifiers, owner-only directories/files, exclusive publication, byte hashes, media type, dimensions, source message/attachment references and fixed expiry. Provider filenames are display data and never filesystem paths. Handles cannot authorize another run, a public URL or arbitrary local file. Verify hash, scope and expiry when reopening; retain no raw content in audit, status or indefinite replay fences.

The deployment supplies a validated state root through trusted, resolved ancestor directories; leaf privacy checks alone do not establish ancestry trust. Recheck private artifact parents on every access. Retention must also remove bounded orphaned partial artifacts after process interruption; cancellation cleanup does not substitute for crash recovery.

## Inference and restart

Build image parts just before inference from verified artifact bytes, alongside the original text request and explicit provenance. Use the pinned AI SDK's byte-backed file parts with explicit image media types, which the compatible adapter serializes as image data URLs; never supply URL-backed parts. [AI SDK prompt content](https://ai-sdk.dev/docs/foundations/prompts) supports multimodal messages; individual endpoint format support is qualified separately.

Images and any extracted text are untrusted user data. They cannot alter instructions, grant tools, change recipients or authorize writes. Reserve image count/byte and endpoint context costs separately from textual context; never count encoded image data as ordinary text tokens or silently discard the current image. Prior thread context does not import old image bodies. Durable model context stores artifact references, with byte parts hydrated only for the current request.

Restart reuses exact verified artifacts and cumulative budgets; it does not download a different attachment or replace expired content. Cancellation leaves bounded, recoverable work. Model/processor failure has a visible safe outcome without a successful-transcription claim. Text replies use the existing durable outbox and uncertain-send fence. Returning a transcript file requires MA-011's exact artifact/recipient delivery intent; provider acceptance does not prove arrival.

Artifact expiry follows content retention during approval waits, outages and recovery holds. Deleting bytes invalidates pending inference/delivery while preserving content-free identity and effect fences. Operational backup/restore must explicitly cover artifacts, their manifest and expiry, or restore must conservatively fence image work whose bytes are missing. SQLite-only backup cannot promise restoration of image work. No image recipe is enabled until this lifecycle is integrated.

## Acceptance gate

Synthetic tests cover representative PNG/JPEG documents, signature/type mismatch, incomplete or mixed manifests, inline images, count/aggregate/stream limits, malformed chunks/frames, cancellation, path/symlink isolation, hash mismatch, expiry, restart and retention. Prove authorization precedes every content read, unsupported requests make no inference calls, and SDK requests contain exact validated bytes without URL fetching.

Separately qualify actual image interpretation on representative documents, readable/unreadable regions, prompt injection embedded in pixels, missing inputs and endpoint failures. Record transcription quality and uncertainty honestly. MA-010 does not imply PDF support or recipient arrival of generated files; those require their own acceptance evidence.
