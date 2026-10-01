# Mail Agent delivery guide

- Treat `design/` as the desired state and `docs/roadmap/ROADMAP.md` as the single active delivery state. Read the relevant design and select a roadmap item before implementation.
- Keep supported behavior and observed evidence in README and `docs/implementation.md`; do not imply a target command/capability already exists.
- Update roadmap status, remaining acceptance and evidence when an item materially changes. Mark done only when its acceptance criteria have been met.
- Record roadblocks with the failed assumption, impact, dependency/owner and next action. If the desired state changes, update the design first, add a dated decision to `docs/roadmap/history/`, then revise affected roadmap items.
- Treat dated live evidence, review records and roadmap history as immutable. Append follow-ups rather than rewriting past observations or decisions. `docs/implementation.md` is the current evidence index and may be updated with new results and links.
- Before public release, archive private incident evidence and related historical records unchanged outside the public tree. Create a separate sanitized acceptance summary and update active public indexes/links; do not rewrite originals to sanitize them.
- Preserve unrelated workspace work. Keep credentials, private mail/documents, runtime state and operational incident details out of public source and artifacts.
- Keep public project documents independent of customer and inspiration-project identities.
- Preserve one mailbox per process/container, explicit authorization, bounded execution and uncertain-effect fences. Prompts and tool output cannot grant permissions.
