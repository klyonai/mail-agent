# Experimental document inbox

The [example recipe](../examples/document-inbox/agent.yaml) uses configuration
schema 2 to accept bounded PNG and baseline JPEG images and optionally return a
UTF-8 `transcription.txt` attachment. This is development preparation for
MA-010/MA-011. Image quality, actual recipient arrival and Linux qualification
remain acceptance gates; it is not advertised as supported production behavior.

Copy the recipe and its `AGENT.md` into a private operator bundle. Configure the
mailbox, authenticated sender/recipient allowlists, external secret environment
variables and a qualified image-capable model. Follow the existing
[tenant setup](microsoft-365-setup.md) and [diagnostics](diagnostics.md).
`init` continues to generate the default text recipe. Use `check` to validate
this explicit image bundle before any live deployment.

Images require `model.capabilities.images: true` and
`documents.images.enabled: true`. The model's configured image context reserve
is charged per current image, separately from text and output. The default
reserve is 8192 per image with a 65536 context budget; qualify and adjust it for
the actual endpoint. Declaring a capability does not prove the model can read
documents accurately. PDF remains disabled.

The complete attachment manifest is checked before any content download.
Inline, linked, mixed unsupported, malformed and oversized documents get an
explanation without inference. Authorized images are read only through scoped
Graph attachment IDs, structurally validated, stored privately with fixed
expiry and hydrated as byte-backed SDK parts immediately before inference.
Historical conversations do not reload old image bodies.

`documents.output.format: text` returns the model answer in the reply body.
`text-attachment` publishes the answer as the fixed text file with a short
review notice. Only successful model output can create that file; errors and
unsupported requests receive ordinary explanations. The runtime persists and
rechecks exact output bytes, recipient/thread and MIME intent before a single
Graph reply. Missing or changed saved content never causes a body-only delivery
fallback. Provider acceptance does not establish recipient arrival.

Graph uses the existing scoped `Mail.Read` and `Mail.Send` permissions. No draft,
mailbox editing, upload session or external storage grant is required. Keep the
mailbox isolated to one deployment and use [artifact-aware stopped backup and
restore](recovery.md). Retention retires database references before deleting
private bytes, while message identities and uncertain effects stay fenced.

Before promoting a recipe, evaluate representative readable/unreadable images,
pixel-embedded instruction attacks, failure cases, restart and expiry; then
verify an actual direct-thread attachment arriving at the authorized recipient.
Record model quality separately from software and provider protocol checks.
