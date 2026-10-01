import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDF_BOUNDS, PdfError, pdfInputMetadata } from '../src/pdf-contract.mjs';
import { validatePdfArtifactHandle, validatePdfArtifactSource } from '../src/pdf-artifact-handles.mjs';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const sha256 = 'a'.repeat(64);
const pdf = Buffer.from('%PDF-1.7\nsynthetic, not a parsed document');
const input = () => ({ format: 2, kind: 'pdf-input', id, runId, mediaType: 'application/pdf',
  size: pdf.length, sha256, expiresAt: 5000, source: { messageId: 'message', attachmentId: 'attachment' } });
const page = () => ({ format: 2, kind: 'pdf-page', id, runId, mediaType: 'image/png',
  size: 100, width: 128, height: 48, sha256, expiresAt: 5000,
  source: { pdfId: id, pdfSha256: sha256, pageNumber: 1, processorDigest: 'b'.repeat(64) } });
const invalid = operation => assert.throws(operation,
  error => error instanceof PdfError && error.code === 'PDF_ARTIFACT_INVALID'
    && error.message === 'PDF artifact metadata is invalid.' && !error.cause);

test('PDF input metadata hashes bounded bytes with a header check, without parsing', () => {
  assert.deepEqual(pdfInputMetadata(pdf), { mediaType: 'application/pdf', size: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex') });
  assert.deepEqual(pdfInputMetadata(new Uint8Array(pdf), { maxBytes: pdf.length }), pdfInputMetadata(pdf));
  for (const maxBytes of [0, -1, 1.5, null, PDF_BOUNDS.sourceBytes + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => pdfInputMetadata(pdf, { maxBytes }), { code: 'PDF_INVALID_LIMITS' });
  }
  assert.throws(() => pdfInputMetadata(pdf, { maxBytes: pdf.length - 1 }), { code: 'PDF_TOO_LARGE' });
  assert.throws(() => pdfInputMetadata(Buffer.alloc(0)), { code: 'PDF_TOO_LARGE' });
  assert.throws(() => pdfInputMetadata('%PDF-1.7'), { code: 'PDF_INVALID_INPUT' });
  assert.throws(() => pdfInputMetadata(Buffer.from('not a PDF')), { code: 'PDF_UNSUPPORTED' });
});

test('format2 input and page handles validate and return independent nested clones', () => {
  for (const handle of [input(), page()]) {
    const cloned = validatePdfArtifactHandle(handle);
    assert.deepEqual(cloned, handle);
    assert.notEqual(cloned, handle);
    assert.notEqual(cloned.source, handle.source);
    cloned.source.extra = true;
    assert.equal(handle.source.extra, undefined);
    assert.equal(validatePdfArtifactSource(handle.source), true);
  }
  const maximum = page();
  maximum.size = PDF_BOUNDS.pageBytes; maximum.width = PDF_BOUNDS.hardPixels; maximum.height = 1;
  maximum.source.pageNumber = 4; maximum.expiresAt = 0;
  assert.deepEqual(validatePdfArtifactHandle(maximum), maximum);
});

test('handles reject unknown keys, wrong kinds/media, unsafe identities, dates, hashes and sizes', () => {
  const changes = [{ extra: true }, { format: 1 }, { kind: 'image-input' }, { mediaType: 'image/jpeg' },
    { id: id.toUpperCase() }, { runId: '../run' }, { sha256: 'A'.repeat(64) },
    { expiresAt: -1 }, { expiresAt: Infinity }, { expiresAt: 0.5 },
    { size: 0 }, { size: 1.5 }, { size: PDF_BOUNDS.sourceBytes + 1 }];
  for (const change of changes) invalid(() => validatePdfArtifactHandle({ ...input(), ...change }));
  for (const value of [undefined, null, [], {}, Object.create(input()),
    { ...input(), source: page().source }, { ...page(), source: input().source }]) {
    invalid(() => validatePdfArtifactHandle(value));
  }
  const hidden = input(); Object.defineProperty(hidden, 'extra', { value: true });
  invalid(() => validatePdfArtifactHandle(hidden));
  const symbol = input(); symbol[Symbol('extra')] = true;
  invalid(() => validatePdfArtifactHandle(symbol));
});

test('source strings are bounded and control-free and page provenance is exact', () => {
  for (const value of ['', 'x'.repeat(1025), 'bad\nvalue', 'bad\u007fvalue', null, 1]) {
    const source = { messageId: value, attachmentId: 'attachment' };
    assert.equal(validatePdfArtifactSource(source), false);
    invalid(() => validatePdfArtifactHandle({ ...input(), source }));
  }
  assert.equal(validatePdfArtifactSource({ messageId: 'x'.repeat(1024), attachmentId: 'x'.repeat(1024) }), true);
  for (const source of [null, [], {}, { ...input().source, content: 'untrusted' },
    { ...page().source, pdfId: '../pdf' }, { ...page().source, pdfSha256: 'no' },
    { ...page().source, processorDigest: 'no' }, { ...page().source, pageNumber: 0 },
    { ...page().source, pageNumber: 5 }, { ...page().source, pageNumber: 1.5 },
    { ...page().source, path: '/private/path' }]) {
    assert.equal(validatePdfArtifactSource(source), false);
  }
});

test('page dimensions and bytes are positive safe integers within hard raster bounds', () => {
  for (const change of [{ width: 0 }, { height: -1 }, { width: 0.5 }, { height: Infinity },
    { width: Number.MAX_SAFE_INTEGER }, { width: 20000000, height: 2 },
    { size: PDF_BOUNDS.pageBytes + 1 }]) {
    invalid(() => validatePdfArtifactHandle({ ...page(), ...change }));
  }
});

test('artifact error vocabulary remains fixed and never accepts an arbitrary message', () => {
  assert.equal(new PdfError('PDF_ARTIFACT_UNAVAILABLE').message, 'PDF artifact is unavailable.');
  assert.equal(new PdfError('PDF_ARTIFACT_UNSAFE').message, 'PDF artifact storage is unsafe.');
  assert.equal(new PdfError('private content').code, 'PDF_INVALID_INPUT');
});
