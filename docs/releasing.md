# Release procedure

## Current status

The project is pre-release software. `package.json` remains marked `private`, and the current `0.1.0` value is internal development metadata. No public release has been made. The selected distribution is GitHub source at `klyonai/mail-agent` and a versioned Docker image intended for `ghcr.io/klyonai/mail-agent`; Docker is the primary deployment artifact, and public npm publication is not requested. The project is licensed under MIT. The intended support policy covers only the latest patch in `0.1.x` on a qualified Node.js 24 runtime, with best-effort maintenance and security updates and no response-time or service-level guarantee. The monitored private security reporting route and general support contact remain unselected; intended GitHub private vulnerability reporting must be confirmed and enabled, while using public Issues for general support remains pending user confirmation and repository setup.

This document defines the release gates and operator review. Local package qualification and a manual versioned candidate workflow are implemented; hosted CI and public publishing remain unqualified. In a source checkout, track current status in `docs/roadmap/ROADMAP.md` and observed results in `docs/implementation.md`. `docs/release-plan.md` is a navigation page, not a second backlog. The installed package includes a separate [acceptance summary](public-acceptance.md).

## Required gates before publication

Do not publish until MA-001 through MA-007 meet their roadmap acceptance criteria. Current ordinary Office 365, GLM, and MCP text acceptance, including independent recipient arrival, has passed. MA-004 still requires tenant grant and send-scope review, protected-header administrator verification, and complete evidence of the controlled-failure counter. MA-007 still requires hosted CI, public artifact and private-data review, final candidate/image qualification, and a verified private security reporting route. The selected license, GitHub identity, intended GHCR destination, and support policy are recorded here; selection does not establish that the repository, registry, reporting feature, or publishing workflow exists or is enabled.

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

The manual source-checkout workflow `.github/workflows/release-candidate.yml` must be dispatched against a reviewed `vVERSION` tag with a matching package version. It rejects a branch, mismatched version or invalid commit identity. It runs checks, packed installation and the dependency audit, builds the digest-pinned Linux image, and executes its fixture preview without networking. A seven-day workflow artifact contains the package, saved image, source/version and image metadata, and checksums. Repository permissions are read-only; it does not publish to npm, a container registry or GitHub Releases. Its hosted run is still required.

Public publishing, verification and enablement of the private security reporting route, source/history privacy review, final candidate qualification, and release notes remain MA-007 gates. The intended GitHub and GHCR destinations are recorded above; their existence and access must be verified before a publishing workflow uses the qualified reviewed candidate with traceable artifact provenance and the published maintenance policy.

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

## Decisions still required

- Verify that the selected GitHub repository and intended GHCR namespace are available and controlled by the maintainers.
- Select and verify the monitored private security reporting route and general support contact; enable GitHub private vulnerability reporting if that is the selected route.
- Confirm the `0.1.x`/qualified Node.js 24 support policy and best-effort/no-SLA wording before publication.
- Hosted candidate qualification and public publishing implementation.
- Remaining MA-004 tenant acceptance and artifact qualification.
