# Release procedure

## Current status

The project is pre-release software. The `klyonai/mail-agent` repository exists privately; `package.json` remains `private`. Internal version `0.1.1` prepares a new private candidate; its source/tag/artifacts require independent binding and qualification. The earlier `v0.1.0` tag and artifacts remain unchanged, with no public GitHub release or registry image published. Distribution is GitHub source and a versioned image intended for `ghcr.io/klyonai/mail-agent`; Docker is the primary deployment artifact and public npm publication is not requested. MIT and latest-patch `0.1.x` support on qualified Node.js 24 are selected, with best-effort maintenance/security fixes and no response-time or service-level guarantee. Reporting and general support routes still require user selection and verification.

Hosted CI at source commit `6f166e3` passes 697 synthetic tests plus lint. Manual candidate run `36911854152` generated private package/image artifacts. Exact downloaded package installation, image/source-byte binding, offline non-root preview and schema-5 recovery pass. Local Linux amd64 image execution used emulation on an arm64 engine; native hosted Ubuntu source checks are separate. The exact amd64 image scan retains 0 Critical, 51 High matches across 13 CVEs, 155 total findings and zero npm findings. It is not clean; advisory disposition remains open.

This document defines release gates and operator review. Source-only status and evidence are in `docs/roadmap/ROADMAP.md` and `docs/implementation.md`; `docs/release-plan.md` is navigation, not another backlog. The installed package includes [public acceptance](public-acceptance.md).

The current Dockerfile prepares a minimal Distroless runtime using the exact Node builder binary; Compose initialization uses Node rather than a shell. The local prototype has separate vendor-signature, actual state/operations/TLS, complete native inventory and exact-image scan evidence. Its scan retains seven High matches across four CVEs; signed source/binary review also finds affected gzip-file functions bundled into Node. No default text/records invocation path was identified, but vulnerable code and indirect-call uncertainty remain. Present the scoped disposition at final release review and requalify added native code. Hosted source/package/image preview passes; a fresh version-bound candidate is still required. Preserve the earlier `v0.1.0` image/tag evidence and qualify a changed release candidate independently; no earlier scan extends to the new image.

## Required gates before publication

Release only after MA-001 through MA-007 meet their acceptance criteria. Ordinary Office 365/real-model/MCP text acceptance and independent recipient arrival pass. A fresh injected SDK 503 case supplies complete counter/reply/replay/arrival evidence while the original missing counter stays unreconstructed. Reviewed tenant roles are scoped `Mail.Read`/`Mail.Send` with the sole agent mailbox; zero Entra administrator/user consent grants were observed, and other-test-mailbox reads/sends returned 403. Protected-header verification remains open: a received Graph-MIME forgery lacked its required control, and a once-submitted Internet SMTP forgery was rejected with 450 without received-header proof.

MA-007 retains final public source/history/artifact review, declared platform qualification, residual image-advisory disposition, verified reporting/support routes and publishing gates. The repository exists privately; GHCR publishing and a public release are unverified. GitHub private vulnerability reporting requires a public repository, as documented in [GitHub reporting requirements](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). If selected, stage and review source while private, obtain final approval for public visibility, then enable and verify reporting and monitoring before the first release/image. A confirmed alternative private contact can satisfy the reporting gate before visibility changes.

Before publication:

1. Freeze a candidate and confirm the supported recipe, Node version, platform, model capabilities, MCP qualification, installation prerequisites, state schema, migration behavior, backup/restore limits, and rollback limits against the roadmap and current evidence.
2. Run the default checks from a clean environment. Obtain a successful hosted CI run and qualify the packed CLI and versioned Linux image in a customer-like environment. Keep live acceptance opt-in, bounded, authorized, and reported without secrets or private content.
3. Review dependency and image changes, lockfile consistency, shipped files, executable permissions, container user, and artifact contents. Exclude credentials, local state, private configuration, raw customer data, and environment-specific incident records.
4. Preserve private incident evidence and historical records unchanged outside the public tree. Prepare a separate sanitized acceptance summary, check every public link, and avoid editing the original records to make them publishable.
5. Publish only after the release notes state exactly what is supported, what has been qualified, required configuration and permissions, known limitations, upgrade steps, recovery/rollback limits, supported versions, and the verified security reporting route.

## Qualify a private candidate

Use Node 24.21.0 or a later 24.x release. The currently pinned image and CI runtime are 24.21.0. From the checkout:

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm audit --omit=dev
```

`test:package` packs the declared `src/*.mjs` runtime files, inert examples and named operator documents, verifies the resulting inventory against the current source files and document list, and installs into a fresh temporary consumer with its own npm configuration/cache and lifecycle scripts disabled. It needs public npm registry access. It reads every installed Markdown document and verifies inline local file/directory link targets against the packed inventory; external URLs and fragment identifiers are not checked. Source-only development records and test commands are labelled explicitly. From outside the checkout it exercises the installed executable, inert and configured setup, the emitted offline check command and a deterministic fixture reply. It uses no deployment credentials or live mail/model/tools, and removes the temporary installation. Passing this does not establish tenant or live model acceptance; source and artifact content review remains a separate release gate.

The manual source-checkout workflow `.github/workflows/release-candidate.yml` must be dispatched against a reviewed `vVERSION` tag with a matching package version. It rejects a branch, mismatched version or invalid commit identity. It runs checks, packed installation and the dependency audit, builds the digest-pinned Linux image, and executes its fixture preview without networking. A seven-day workflow artifact contains the package, saved image, source/version and image metadata, and checksums. Repository permissions are read-only; it does not publish to npm, a container registry or GitHub Releases. The recorded private candidate run passes for its exact tagged source; later candidates require their own qualification.

Public publishing, a verified monitored reporting route, final source/history/artifact review, residual advisory disposition and release notes remain MA-007 gates. Promotion uses the manual procedure below; the candidate workflow remains read-only. A private workflow artifact is not a published or supported release.

## Promote the exact qualified artifacts

Publication remains blocked until all required gates and explicit final user approval are recorded. This procedure publishes to GitHub Releases and GHCR; it does not publish to npm. Use a private candidate directory and review file, preserve the original download, and run only the reviewed source-checkout tooling. The installed package does not include `scripts/release-verify.mjs`.

### Prepare and review

1. Read GitHub API metadata for the exact repository, `.github/workflows/release-candidate.yml`, successful completed run **and attempt**, and immutable artifact ID. Check repository/head-repository identity, reviewed workflow at the full source commit, tag/version and run conclusion. Use `GET /repos/{repository}/actions/runs/{runId}/attempts/{attempt}` and `GET /repos/{repository}/actions/artifacts/{artifactId}`; download that artifact ID and verify its API archive digest before extraction. An expired artifact, failed run or artifact selected only by name/“latest” is insufficient. Resolve `vVERSION` through any annotated tag objects to the same source commit; never create or move a tag during promotion. [GitHub artifact metadata](https://docs.github.com/en/rest/actions/artifacts) exposes artifact identity, expiry, digest and source-run binding.
2. Retain exactly six files: `mail-agent-VERSION.tgz`, `image.tar`, `candidate.json`, `pack.json`, `image.json` and `SHA256SUMS`. Derive the private trusted review from unchanged qualification evidence, not from an untrusted candidate's own checksum file. Its strict format is `{format:1, repository, version, sourceCommit, node, platform, imageId, checksums}`; `checksums` maps the five filenames other than `SHA256SUMS` to reviewed SHA-256 values. `node` matches candidate metadata; separately verify the actual qualified CI/runtime version. The currently qualified image platform is `linux/amd64`; other platforms require their own candidate.

From the **source checkout only**:

```sh
node scripts/release-verify.mjs --directory PRIVATE_CANDIDATE --review PRIVATE_REVIEW.json
```

The network-free command checks the bounded inventory, actual file hashes, tarball SHA-1/SHA-512, checksum and metadata consistency. It writes/publishes nothing and returns `prepared-not-approved`, `manifestDigest`, repository/version/source/platform/image identity and each file's SHA-256/size. This is preparation, not live provenance, approval, or validation of the saved Docker archive's payload.

3. Before approval, bind actual layout/content qualification of the exact downloaded `.tgz` and `image.tar` to their reviewed SHA-256 values. Check bounded archive entry paths/types/count/unpacked size/modes, without traversal, links or unexpected payloads; require exact package inventory/content and a clean consumer installation with lifecycle scripts disabled. Require saved-image content/source binding and loaded image ID/platform/labels; selected-image inspection alone does not review all archive contents. Reuse unchanged qualification evidence only when both archive hashes match. `pack.json` is declared metadata, and a fresh source `test:package` result does not qualify a different release tarball.

Present that exact manifest digest, full source/tag, destinations and reviewed release-note hash for final user approval. Confirm every MA-001–MA-007 gate, public source/history/artifact review, protected-header acceptance, residual advisory disposition, qualified platform, maintenance policy and selected reporting/support routes. Verify the repository is currently public and the private reporting route is enabled where applicable, monitored and usable. Repository visibility, GHCR package visibility and release publication are distinct approved effects. No contact or gate may be assumed from a successful verifier result. If artifacts or policy documents change, qualify a new candidate.

### Promote after approval

4. Load the original `image.tar` once with `docker image load --input`; inspect the loaded image and require its ID, OS/architecture and `org.opencontainers.image.revision`/`version` labels to equal the approved metadata. Do not execute candidate code with publishing credentials. Before the **first push**, inspect `ghcr.io/klyonai/mail-agent:VERSION` read-only: an absent version may proceed; an exact already-owned match is acknowledged without pushing again; conflicting or unknown state stops for review and is never overwritten. Tag that image ID only as this exact version and push using an approved least-privilege credential. No build, repack, replacement `docker save`, or `latest` update is part of promotion.
5. Record the remote registry manifest digest; it is **not** the Docker image ID. Verify the manifest config digest equals the qualified image ID, then verify a credential-free pull by registry digest and inspect the resulting ID/platform. GHCR initially defaults packages to private: making this package public needs the approved visibility step and anonymous access verification before release publication. [GitHub's registry guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) documents visibility and digest pulls.
6. Inspect for an existing release first. Create a new operator-owned **draft** for the existing approved tag, or resume only a draft already bound to this promotion receipt. `gh release create --verify-tag --draft` checks tag existence; it does not replace the full source-commit check. Upload the six original files without `--clobber`. Verify exact names, sizes and API SHA-256 digests; where a digest is unavailable, download read-only and hash the bytes. Include the full source commit, registry digest, supported scope, known limitations and approved reporting/support policy in the notes.
7. Recheck public repository/reporting gates, unchanged Git tag/source, original local hashes, anonymous image access, release ownership and all six remote asset hashes immediately before publishing the draft. Require the registry `VERSION` tag still to resolve to the recorded registry digest. Require the draft notes to match the approved release-note SHA-256 over exact UTF-8 bytes, preserving actual newline bytes without trimming or normalization. A changed digest or note hash stops publication for review. Record a content-free receipt: approved manifest digest, actor/time, repository/workflow/run/attempt/artifact IDs and archive digest, source/tag, release-note hash, gate evidence references, image ID/platform, registry digest and release/asset IDs with verified sizes/hashes. Do not include tokens, signed download URLs or private deployment evidence. GitHub and GHCR publication is not atomic; a moving tag invalidates promotion rather than authorizing a different source.

### Partial or uncertain publication

After a lost push, upload or publish response, inspect the exact remote image/tag, release and assets before another mutation. Resume only matching, owned state; an already published exact release is acknowledged rather than recreated. Conflicting hashes, changed tags/gates, unknown ownership or incomplete assets stop for reviewed repair. Never automatically delete, overwrite, retag or rebuild. GitHub documents that a failed upload can leave a `starter` asset; preserve it for inspection rather than using `--clobber` to conceal the partial result. [Release asset API](https://docs.github.com/en/rest/releases/assets).

## Public evidence preparation

[The separate acceptance summary](public-acceptance.md) describes product-level
evidence and its limits without operational incident narratives. It is included in the npm artifact; private source evidence is not. The npm filename allowlist
excludes live evidence and roadmap history; this does not review their contents,
the public source tree or reachable Git history.

Before archiving, inventory the original evidence and retain a private manifest
with file paths, byte counts and content hashes. Verify copied bytes against both
the manifest and unchanged originals. Temporary verified copies are preparation;
they do not satisfy permanent private archival. Once a durable private archive is
verified, prepare the public tree separately, redirect active evidence references
to sanitized summaries, and review source, reachable Git history, artifact
contents and public links. Do not delete original evidence or rewrite historical
records to make a publication candidate pass.

## Maintenance after release

Maintain only versions covered by the published support policy. Review dependency and runtime updates, security reports, and supported-version changes through the named monitored contacts and documented response process. For each maintenance release, repeat the applicable artifact and acceptance checks, describe state migration and rollback constraints, and update the changelog and implementation evidence. Never promise rollback across an unsupported state schema downgrade; use the documented stopped backup and fresh held restore procedure where applicable.

## Decisions and acceptance still required

- Select and verify private security reporting and general support routes. If GitHub reporting is selected, approve public source visibility before feature enablement and verify monitoring before the first release/image.
- Complete protected-header administrator acceptance and the remaining deployment trust evidence.
- Review final public source/history/artifacts, declared image platforms and residual advisories; qualify the artifacts actually published.
- Verify GHCR publishing access and complete final release notes/publication review. The MIT, organization, `0.1.x`/Node 24 and best-effort support policy decisions are already recorded.
