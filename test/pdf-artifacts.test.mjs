import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPdfArtifacts } from '../src/pdf-artifacts.mjs';
import { createPdfRequest, validatePdfResponse } from '../src/pdf-contract.mjs';

const now = 1_800_000_000_000;
const runId = 'd4d7a7fd-bf8f-47dd-8972-b2dad02f9b44';
const processorDigest = 'a'.repeat(64);
const source = Buffer.from('%PDF-1.7\n%%EOF\n', 'ascii');
const sourceBinding = { messageId: 'synthetic-message', attachmentId: 'synthetic-pdf' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function setup(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'mail-agent-pdf-artifacts-'));
  await chmod(stateRoot, 0o700);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const png = await readFile(new URL('./fixtures/images/synthetic-note.png', import.meta.url));
  let clock = now;
  let clockHook;
  let calls = 0;
  const create = () => createPdfArtifacts({ stateRoot, runId, expiresAt: now + 60_000,
    processorDigest, clock: () => { calls++; clockHook?.(calls); return clock; } });
  const artifacts = create();
  const request = createPdfRequest({ bytes: source, processorDigest, expiresAt: now + 60_000 }, { now });
  const rendered = validatePdfResponse({ version: 1, complete: true, jobId: request.jobId,
    inputSha256: request.inputSha256, processorDigest, pageCount: 1, encrypted: false,
    pages: [{ pageNumber: 1, mediaType: 'image/png', data: png.toString('base64') }] }, { request, now });
  return { stateRoot, png, create, artifacts, rendered, source, sourceBinding,
    setNow(value) { clock = value; }, setClockHook(hook) { calls = 0; clockHook = hook; } };
}

async function runDirectories(stateRoot) {
  try { return await readdir(join(stateRoot, 'artifacts', runId)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('PDF artifact storage durably round-trips source and complete page provenance', async t => {
  const fx = await setup(t);
  const input = await fx.artifacts.putSource(fx.source, { source: fx.sourceBinding });
  assert.equal(input.format, 2);
  assert.equal(input.kind, 'pdf-input');
  assert.equal(input.sha256, digest(fx.source));
  const pages = await fx.artifacts.putPages(input, fx.rendered);
  assert.equal(pages.length, 1);
  const page = pages[0];
  assert.equal(page.format, 2);
  assert.equal(page.kind, 'pdf-page');
  assert.equal(page.mediaType, 'image/png');
  assert.equal(page.source.pdfId, input.id);
  assert.equal(page.source.pdfSha256, input.sha256);
  assert.equal(page.source.pageNumber, 1);
  assert.equal(page.source.processorDigest, processorDigest);
  assert.deepEqual(await fx.artifacts.read(input), fx.source);
  assert.deepEqual(await fx.artifacts.read(page), fx.png);
  const reopened = fx.create();
  assert.deepEqual(await reopened.read(input), fx.source);
  assert.deepEqual(await reopened.read(page), fx.png);
  const [inputDirectory, pageDirectory] = await runDirectories(fx.stateRoot);
  for (const artifactId of [inputDirectory, pageDirectory]) {
    const directory = join(fx.stateRoot, 'artifacts', runId, artifactId);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'bytes'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'manifest.json'))).mode & 0o777, 0o600);
  }
});

test('PDF page publication rejects wrong source, processor, order, and partial output before creating pages', async t => {
  const fx = await setup(t);
  const input = await fx.artifacts.putSource(fx.source, { source: fx.sourceBinding });
  const alteredSource = { ...input, sha256: 'b'.repeat(64) };
  await assert.rejects(fx.artifacts.putPages(alteredSource, fx.rendered), error => error.code === 'PDF_ARTIFACT_INVALID');
  await assert.rejects(fx.artifacts.putPages(input, { ...fx.rendered, processorDigest: 'b'.repeat(64) }),
    error => error.code === 'PDF_INVALID_OUTPUT' || error.code === 'PDF_ARTIFACT_INVALID');
  const reversed = { ...fx.rendered, pages: [{ ...fx.rendered.pages[0], pageNumber: 2 }] };
  await assert.rejects(fx.artifacts.putPages(input, reversed), error => error.code === 'PDF_INVALID_OUTPUT');
  assert.deepEqual(await runDirectories(fx.stateRoot), [input.id]);
  assert.deepEqual(await fx.artifacts.read(input), fx.source);
});

test('PDF storage rejects corrupt, missing, expired, cancelled, and unsafe asset access safely', async t => {
  const fx = await setup(t);
  const input = await fx.artifacts.putSource(fx.source, { source: fx.sourceBinding });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(fx.artifacts.putSource(fx.source, { source: { ...fx.sourceBinding, attachmentId: randomUUID() }, signal: aborted.signal }),
    error => error.code === 'PDF_CANCELLED');
  const pages = await fx.artifacts.putPages(input, fx.rendered);
  const page = pages[0];
  const bytesPath = join(fx.stateRoot, 'artifacts', runId, page.id, 'bytes');
  await writeFile(bytesPath, Buffer.from('corrupt'));
  await assert.rejects(fx.artifacts.read(page), error => error.code === 'PDF_ARTIFACT_INVALID');
  const missing = await fx.artifacts.putSource(fx.source, { source: { ...fx.sourceBinding, attachmentId: 'missing-source' } });
  await unlink(join(fx.stateRoot, 'artifacts', runId, missing.id, 'bytes'));
  await assert.rejects(fx.artifacts.read(missing), error => error.code === 'PDF_ARTIFACT_UNAVAILABLE');
  const unsafe = await fx.artifacts.putSource(fx.source, { source: { ...fx.sourceBinding, attachmentId: 'unsafe-source' } });
  const unsafeBytes = join(fx.stateRoot, 'artifacts', runId, unsafe.id, 'bytes');
  const externalBytes = join(fx.stateRoot, 'external-bytes');
  await writeFile(externalBytes, fx.source, { mode: 0o600 });
  await unlink(unsafeBytes);
  await symlink(externalBytes, unsafeBytes);
  await assert.rejects(fx.artifacts.read(unsafe), error => error.code === 'PDF_ARTIFACT_UNSAFE');
  fx.setNow(now + 60_000);
  await assert.rejects(fx.artifacts.read(input), error => error.code === 'PDF_EXPIRED');
  assert.equal(await fx.artifacts.remove(page), true);
});

test('PDF page transaction removes only its newly published pages after a later write failure', async t => {
  const fx = await setup(t);
  const input = await fx.artifacts.putSource(fx.source, { source: fx.sourceBinding });
  const first = fx.rendered.pages[0];
  const completeTwoPageResult = { ...fx.rendered, pageCount: 2, pages: [first, { ...first, pageNumber: 2 }] };
  const abort = new AbortController();
  fx.setClockHook(call => { if (call === 6) abort.abort(); });
  await assert.rejects(fx.artifacts.putPages(input, completeTwoPageResult, { signal: abort.signal }),
    error => error.code === 'PDF_CANCELLED');
  assert.deepEqual(await runDirectories(fx.stateRoot), [input.id]);
  assert.deepEqual(await fx.artifacts.read(input), fx.source);
});
