import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPdfProcessor } from '../src/pdf-processor.mjs';
import { createPdfRequest, PDF_BOUNDS, PdfError } from '../src/pdf-contract.mjs';
import { runPdfWorker } from '../src/pdf-worker-supervisor.mjs';

const now = 1_800_000_000_000;
const workerPath = fileURLToPath(new URL('./fixtures/pdf/worker.mjs', import.meta.url));
const pngPath = new URL('./fixtures/images/synthetic-note.png', import.meta.url);
const processorDigest = createHash('sha256').update('synthetic-pdf-worker-v1').digest('hex');
const jobId = '00000000-0000-4000-8000-000000000123';
// This is a protocol fixture only. It has a PDF header and is not parsed by a PDF engine.
const pdfBytes = Buffer.from('%PDF-1.7\n% synthetic protocol fixture\n%%EOF\n');

function workerStarter(mode = 'success', observations = {}) {
  return ({ request }) => {
    const child = spawn(process.execPath, [workerPath, mode], {
      env: {}, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    observations.request = request;
    observations.child = child;
    observations.closed = false;
    observations.released = false;
    const closed = new Promise((resolve, reject) => {
      child.once('close', (code, signal) => { observations.closed = true; resolve({ code, signal }); });
      child.once('error', reject);
    });
    return {
      child,
      async terminate() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
      },
      async release() {
        await closed;
        observations.released = true;
      },
    };
  };
}

function processor(mode = 'success', observations = {}, overrides = {}) {
  return createPdfProcessor({ processorDigest, startWorker: workerStarter(mode, observations), clock: () => now,
    idFactory: () => jobId, ...overrides });
}

test('synthetic worker round trip binds one complete PNG page to the PDF bytes, job and processor', async () => {
  const observations = {}, png = await readFile(pngPath);
  const result = await processor('success', observations).render({ bytes: pdfBytes, expiresAt: now + 60_000 });
  const request = observations.request;
  assert.equal(request.version, 1);
  assert.equal(request.jobId, jobId);
  assert.equal(request.inputSha256, createHash('sha256').update(pdfBytes).digest('hex'));
  assert.equal(request.processorDigest, processorDigest);
  assert.equal(request.expiresAt, now + 60_000);
  assert.deepEqual(Buffer.from(request.data, 'base64'), pdfBytes);
  assert.deepEqual(request.limits, {
    maxBytes: PDF_BOUNDS.sourceBytes, maxPages: PDF_BOUNDS.maxPages,
    maxPageBytes: PDF_BOUNDS.pageBytes, maxTotalBytes: PDF_BOUNDS.totalBytes,
    maxPixels: PDF_BOUNDS.defaultPixels, dpi: PDF_BOUNDS.dpi, timeoutMs: PDF_BOUNDS.timeoutMs,
  });
  assert.equal(Object.hasOwn(request, 'path'), false);
  assert.equal(Object.hasOwn(request, 'url'), false);
  assert.equal(result.jobId, jobId);
  assert.equal(result.inputSha256, request.inputSha256);
  assert.equal(result.processorDigest, processorDigest);
  assert.equal(result.pageCount, 1);
  assert.equal(result.pages[0].pageNumber, 1);
  assert.equal(result.pages[0].mediaType, 'image/png');
  assert.deepEqual(result.pages[0].bytes, png);
  assert.equal(result.pages[0].sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(observations.closed, true);
  assert.equal(observations.released, true);
});

test('malformed, partial, encrypted, mismatched and oversized worker results fail with safe errors', async t => {
  for (const mode of ['wrong-job', 'wrong-input', 'wrong-processor', 'partial', 'encrypted', 'invalid-base64', 'too-many-pages', 'malformed-json', 'oversized-response', 'nonzero']) {
    await t.test(mode, async () => {
      const observations = {};
      await assert.rejects(processor(mode, observations).render({ bytes: pdfBytes, expiresAt: now + 60_000 }), error => {
        assert.ok(error instanceof PdfError);
        assert.match(error.code, /^PDF_/);
        assert.doesNotMatch(error.message, /synthetic|worker|response|record|private|PDF-1\.7/i);
        return true;
      });
      assert.equal(observations.closed, true);
      assert.equal(observations.released, true);
    });
  }
});

test('cancellation settles only after the owned worker is killed, reaped and released', async () => {
  const controller = new AbortController();
  const observations = {};
  const worker = processor('hang', observations, { idFactory: () => jobId });
  const pending = worker.render({ bytes: pdfBytes, expiresAt: now + 60_000, signal: controller.signal });
  assert.ok(observations.child, 'the synchronous owned starter returns its child before cancellation');
  controller.abort();
  await assert.rejects(pending, error => error instanceof PdfError && error.code === 'PDF_CANCELLED');
  assert.equal(observations.closed, true);
  assert.equal(observations.released, true);
});

test('deadline settles only after the owned worker is killed, reaped and released', async () => {
  const observations = {};
  let fireDeadline;
  const request = createPdfRequest({ bytes: pdfBytes, jobId, processorDigest, expiresAt: now + 60_000,
    limits: { timeoutMs: 100 } }, { now });
  const pending = runPdfWorker(request, { startWorker: workerStarter('hang', observations), clock: () => now,
    setTimer: callback => { fireDeadline = callback; return 'synthetic-timer'; }, clearTimer: () => {} });
  assert.ok(observations.child, 'the synchronous owned starter returns its child before deadline');
  fireDeadline();
  await assert.rejects(pending, error => error instanceof PdfError && error.code === 'PDF_TIMEOUT');
  assert.equal(observations.closed, true);
  assert.equal(observations.released, true);
});
