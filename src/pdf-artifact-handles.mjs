import { PDF_BOUNDS, PdfError } from './pdf-contract.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const baseKeys = ['format', 'kind', 'id', 'runId', 'mediaType', 'size', 'sha256', 'expiresAt', 'source'];
const pageKeys = [...baseKeys, 'width', 'height'];
const inputSourceKeys = ['messageId', 'attachmentId'];
const pageSourceKeys = ['pdfId', 'pdfSha256', 'pageNumber', 'processorDigest'];

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function matches(value, pattern) { return typeof value === 'string' && pattern.test(value); }
function positive(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function sourceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function inputSource(source) {
  return exact(source, inputSourceKeys) && sourceId(source.messageId) && sourceId(source.attachmentId);
}
function pageSource(source) {
  return exact(source, pageSourceKeys) && matches(source.pdfId, uuid)
    && matches(source.pdfSha256, sha256) && matches(source.processorDigest, sha256)
    && positive(source.pageNumber, PDF_BOUNDS.maxPages);
}
export function validatePdfArtifactSource(source) { return inputSource(source) || pageSource(source); }

function baseIdentity(handle) {
  return handle.format === 2 && matches(handle.id, uuid) && matches(handle.runId, uuid)
    && matches(handle.sha256, sha256) && Number.isSafeInteger(handle.expiresAt) && handle.expiresAt >= 0;
}
function validInput(handle) {
  return exact(handle, baseKeys) && handle.kind === 'pdf-input' && handle.mediaType === 'application/pdf'
    && positive(handle.size, PDF_BOUNDS.sourceBytes) && inputSource(handle.source);
}
function validPage(handle) {
  return exact(handle, pageKeys) && handle.kind === 'pdf-page' && handle.mediaType === 'image/png'
    && positive(handle.size, PDF_BOUNDS.pageBytes) && positive(handle.width, PDF_BOUNDS.hardPixels)
    && positive(handle.height, PDF_BOUNDS.hardPixels) && handle.width * handle.height <= PDF_BOUNDS.hardPixels
    && pageSource(handle.source);
}
export function validatePdfArtifactHandle(handle) {
  if (!(validInput(handle) || validPage(handle)) || !baseIdentity(handle)) throw new PdfError('PDF_ARTIFACT_INVALID');
  return structuredClone(handle);
}
