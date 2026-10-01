import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { createArtifactFiles, TEXT_ARTIFACT_MAX_BYTES } from './artifact-files.mjs';
import { imageFail, imageCancelled } from './image-validation.mjs';

function maxBytes(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > TEXT_ARTIFACT_MAX_BYTES) imageFail('TEXT_ARTIFACT_INVALID');
  return value;
}
function textMetadata(bytes) {
  if (!bytes.length || bytes.length > TEXT_ARTIFACT_MAX_BYTES) imageFail('TEXT_ARTIFACT_TOO_LARGE');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { imageFail('TEXT_ARTIFACT_INVALID'); }
  if (!text.trim() || text.includes('\0')) imageFail('TEXT_ARTIFACT_INVALID');
  return { mediaType: 'text/plain', name: 'transcription.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function createTextArtifacts(options) {
  const files = createArtifactFiles({ ...options, validateBytes: textMetadata });
  return { ...files, async put(text, { source, maxBytes: supplied = 262144, signal } = {}) {
    imageCancelled(signal);
    const limit = maxBytes(supplied);
    if (typeof text !== 'string' || text.length > limit || !text.isWellFormed()) imageFail('TEXT_ARTIFACT_INVALID');
    if (Buffer.byteLength(text, 'utf8') > limit) imageFail('TEXT_ARTIFACT_TOO_LARGE');
    const bytes = Buffer.from(text, 'utf8'), metadata = textMetadata(bytes);
    return files.put(bytes, { metadata, source, signal });
  } };
}
