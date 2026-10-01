import { lstat } from 'node:fs/promises';
import { createArtifactFiles } from './artifact-files.mjs';
import { ImageError, validateImage } from './image-validation.mjs';
import { PdfError, pdfInputMetadata, validatePdfLimits } from './pdf-contract.mjs';
import { validatePdfArtifactHandle, validatePdfArtifactSource } from './pdf-artifact-handles.mjs';
import { join, resolve } from 'node:path';

const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const outputKeys = ['version', 'complete', 'jobId', 'inputSha256', 'processorDigest', 'pageCount', 'encrypted', 'pages'];
const pageKeys = ['pageNumber', 'mediaType', 'bytes', 'width', 'height', 'sha256'];

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function fail(code) { throw new PdfError(code); }

function mapStorageError(error) {
  if (error instanceof PdfError) return error;
  if (error instanceof ImageError) {
    const codes = { IMAGE_ARTIFACT_INVALID: 'PDF_ARTIFACT_INVALID', IMAGE_ARTIFACT_UNAVAILABLE: 'PDF_ARTIFACT_UNAVAILABLE',
      IMAGE_ARTIFACT_UNSAFE: 'PDF_ARTIFACT_UNSAFE', IMAGE_EXPIRED: 'PDF_EXPIRED',
      IMAGE_CANCELLED: 'PDF_CANCELLED', IMAGE_TOO_LARGE: 'PDF_TOO_LARGE' };
    return new PdfError(codes[error.code] ?? 'PDF_ARTIFACT_INVALID');
  }
  return new PdfError('PDF_ARTIFACT_UNAVAILABLE');
}

async function safely(operation) {
  try { return await operation(); } catch (error) { throw mapStorageError(error); }
}

function metadataFor(bytes, handle, limits) {
  if (handle.kind === 'pdf-input') return pdfInputMetadata(bytes, { maxBytes: limits.maxBytes });
  if (handle.kind === 'pdf-page') return validateImage(bytes, { mediaType: 'image/png',
    maxBytes: limits.maxPageBytes, maxPixels: limits.maxPixels });
  fail('PDF_ARTIFACT_INVALID');
}

function validClock(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('PDF_ARTIFACT_INVALID');
  return value;
}

async function missingArtifactPart(stateRoot, runId, handle) {
  const directory = join(resolve(stateRoot), 'artifacts', runId, handle.id);
  for (const name of ['bytes', 'manifest.json']) {
    try { await lstat(join(directory, name)); }
    catch (error) { if (error.code === 'ENOENT') return true; }
  }
  return false;
}

function sourceHandle(value, runId, expiresAt) {
  const handle = validatePdfArtifactHandle(value);
  if (handle.kind !== 'pdf-input' || handle.runId !== runId || handle.expiresAt !== expiresAt) fail('PDF_ARTIFACT_INVALID');
  return handle;
}

function validPageCount(result, limits) {
  return Number.isSafeInteger(result?.pageCount) && result.pageCount > 0
    && result.pageCount <= limits.maxPages && Array.isArray(result.pages) && result.pages.length === result.pageCount;
}

function validateRenderedIdentity(result, source, processorDigest, limits) {
  const matchesIdentity = result?.version === 1 && result.complete === true && result.encrypted === false
    && uuidPattern.test(result.jobId ?? '') && result.inputSha256 === source.sha256
    && result.processorDigest === processorDigest;
  if (!exact(result, outputKeys) || !matchesIdentity || !validPageCount(result, limits)) fail('PDF_INVALID_OUTPUT');
}

function validatePageShape(page, index) {
  return exact(page, pageKeys) && page.pageNumber === index + 1 && page.mediaType === 'image/png'
    && page.bytes instanceof Uint8Array && Number.isSafeInteger(page.width) && Number.isSafeInteger(page.height)
    && digestPattern.test(page.sha256 ?? '');
}

function validateRenderedPage(page, index, limits) {
  if (!validatePageShape(page, index)) fail('PDF_INVALID_OUTPUT');
  if (page.bytes.length > limits.maxPageBytes) fail('PDF_TOO_LARGE');
  let metadata;
  try { metadata = validateImage(page.bytes, { mediaType: 'image/png', maxBytes: limits.maxPageBytes, maxPixels: limits.maxPixels }); }
  catch (error) {
    if (error instanceof ImageError && error.code === 'IMAGE_TOO_LARGE') fail('PDF_TOO_LARGE');
    fail('PDF_INVALID_OUTPUT');
  }
  if (metadata.width !== page.width || metadata.height !== page.height || metadata.sha256 !== page.sha256) fail('PDF_INVALID_OUTPUT');
  return { ...metadata, bytes: Buffer.from(page.bytes), pageNumber: page.pageNumber };
}

function validatePageSet(result, source, processorDigest, limits) {
  validateRenderedIdentity(result, source, processorDigest, limits);
  let total = 0;
  const pages = [];
  for (let index = 0; index < result.pages.length; index++) {
    const page = validateRenderedPage(result.pages[index], index, limits);
    total += page.size;
    if (total > limits.maxTotalBytes) fail('PDF_TOO_LARGE');
    pages.push(page);
  }
  return pages;
}

export function createPdfArtifacts({ stateRoot, runId, expiresAt, processorDigest, clock = Date.now, limits: suppliedLimits } = {}) {
  const limits = validatePdfLimits(suppliedLimits);
  if (typeof processorDigest !== 'string' || !digestPattern.test(processorDigest)) fail('PDF_ARTIFACT_INVALID');
  const now = validClock(clock);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) fail('PDF_EXPIRED');
  let files;
  try {
    files = createArtifactFiles({ stateRoot, runId, expiresAt, clock,
      validateHandle: validatePdfArtifactHandle, validateSource: validatePdfArtifactSource,
      validateBytes: (bytes, handle) => metadataFor(bytes, handle, limits) });
  } catch (error) { throw mapStorageError(error); }

  async function putSource(bytes, { source, signal } = {}) {
    return safely(async () => {
      if (!validatePdfArtifactSource(source) || !source || !Object.hasOwn(source, 'messageId')) fail('PDF_ARTIFACT_INVALID');
      const metadata = pdfInputMetadata(bytes, { maxBytes: limits.maxBytes });
      return await files.put(bytes, { metadata: { format: 2, kind: 'pdf-input', ...metadata }, source, signal });
    });
  }

  async function putPages(value, result, { signal } = {}) {
    return safely(async () => {
      const source = sourceHandle(value, runId, expiresAt);
      if (validClock(clock) >= expiresAt) fail('PDF_EXPIRED');
      const sourceBytes = await files.read(source, { signal });
      const metadata = pdfInputMetadata(sourceBytes, { maxBytes: limits.maxBytes });
      if (metadata.sha256 !== source.sha256 || result?.inputSha256 !== source.sha256) fail('PDF_ARTIFACT_INVALID');
      const pages = validatePageSet(result, source, processorDigest, limits);
      const published = [];
      try {
        for (const page of pages) {
          if (signal?.aborted) fail('PDF_CANCELLED');
          const artifactSource = { pdfId: source.id, pdfSha256: source.sha256,
            pageNumber: page.pageNumber, processorDigest };
          published.push(await files.put(page.bytes, { metadata: { format: 2, kind: 'pdf-page',
            mediaType: page.mediaType, size: page.size, width: page.width, height: page.height, sha256: page.sha256 },
          source: artifactSource, signal }));
        }
        return published;
      } catch (error) {
        let cleanupFailed = false;
        for (const handle of published.reverse()) {
          try { await files.remove(handle); } catch { cleanupFailed = true; }
        }
        if (cleanupFailed) fail('PDF_CLEANUP_FAILED');
        throw error;
      }
    });
  }

  async function read(value, { signal } = {}) {
    return safely(async () => {
      const handle = validatePdfArtifactHandle(value);
      if (handle.runId !== runId || handle.expiresAt !== expiresAt) fail('PDF_ARTIFACT_INVALID');
      try { return await files.read(handle, { signal }); }
      catch (error) {
        const mapped = mapStorageError(error);
        if (mapped.code === 'PDF_ARTIFACT_UNSAFE' && await missingArtifactPart(stateRoot, runId, handle)) {
          fail('PDF_ARTIFACT_UNAVAILABLE');
        }
        throw mapped;
      }
    });
  }

  async function remove(value, { signal, allowMissing = false } = {}) {
    return safely(async () => {
      const handle = validatePdfArtifactHandle(value);
      if (handle.runId !== runId || handle.expiresAt !== expiresAt) fail('PDF_ARTIFACT_INVALID');
      return await files.remove(handle, { signal, allowMissing });
    });
  }

  return Object.freeze({ putSource, putPages, read, remove });
}
