import { lstat, mkdir, open, opendir, unlink, rmdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ImageError, IMAGE_BOUNDS, imageFail, imageCancelled } from './image-validation.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keys = ['id', 'runId', 'mediaType', 'size', 'width', 'height', 'sha256', 'expiresAt', 'source'];
const textKeys = ['id', 'runId', 'mediaType', 'name', 'size', 'sha256', 'expiresAt', 'source'];
export const TEXT_ARTIFACT_MAX_BYTES = 2000000;
function time(value) { return Number.isSafeInteger(value) && value >= 0; }
function exact(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function sourceId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function sourceValid(source) {
  return exact(source, ['messageId', 'attachmentId']) && sourceId(source.messageId) && sourceId(source.attachmentId);
}
export function validateArtifactHandle(handle) {
  const expected = handle?.mediaType === 'text/plain' ? textKeys : keys;
  if (!exact(handle, expected) || typeof handle.id !== 'string' || !uuid.test(handle.id)) imageFail('IMAGE_ARTIFACT_INVALID');
  validateIdentity(handle);
  if (handle.mediaType === 'text/plain') validateTextHandle(handle);
  else validateImageHandle(handle);
  return structuredClone(handle);
}
function validateIdentity(handle) {
  if (typeof handle.runId !== 'string' || !uuid.test(handle.runId) || !time(handle.expiresAt)) imageFail('IMAGE_ARTIFACT_INVALID');
  if (!sourceValid(handle.source) || typeof handle.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(handle.sha256)) imageFail('IMAGE_ARTIFACT_INVALID');
}
function validateTextHandle(handle) {
  if (handle.name !== 'transcription.txt' || handle.source.attachmentId !== 'generated-transcript') imageFail('IMAGE_ARTIFACT_INVALID');
  if (!Number.isSafeInteger(handle.size) || handle.size <= 0 || handle.size > TEXT_ARTIFACT_MAX_BYTES) imageFail('IMAGE_ARTIFACT_INVALID');
}
function validateImageHandle(handle) {
  if (!['image/png', 'image/jpeg'].includes(handle.mediaType)) imageFail('IMAGE_ARTIFACT_INVALID');
  for (const key of ['size', 'width', 'height']) if (!Number.isSafeInteger(handle[key]) || handle[key] <= 0) imageFail('IMAGE_ARTIFACT_INVALID');
  if (handle.size > IMAGE_BOUNDS.fileBytes || handle.width * handle.height > IMAGE_BOUNDS.hardPixels) imageFail('IMAGE_ARTIFACT_INVALID');
}
function scopeValid(handle, runId, expiresAt) {
  if (handle.runId !== runId || handle.expiresAt !== expiresAt) imageFail('IMAGE_ARTIFACT_INVALID');
}
function validArtifactValidators(validateBytes, validateHandle, validateSource) {
  return [validateBytes, validateHandle, validateSource].every(value => typeof value === 'function');
}
function validateArtifactFactoryOptions({ stateRoot, runId, expiresAt, clock, validateBytes, validateHandle, validateSource }) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot.length > 4096 || stateRoot.includes('\0')) imageFail('IMAGE_ARTIFACT_INVALID');
  if (typeof runId !== 'string' || !uuid.test(runId) || !time(expiresAt) || typeof clock !== 'function'
    || !validArtifactValidators(validateBytes, validateHandle, validateSource)) imageFail('IMAGE_ARTIFACT_INVALID');
}
function privateStat(value, kind) {
  return value[kind]() && value.uid === process.getuid() && !(value.mode & 0o077) && !value.isSymbolicLink();
}
async function privateDir(directory, signal) {
  imageCancelled(signal);
  const value = await lstat(directory);
  if (!privateStat(value, 'isDirectory')) imageFail('IMAGE_ARTIFACT_UNSAFE');
  return value;
}
async function ensureDir(directory, signal) {
  imageCancelled(signal);
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await privateDir(directory, signal);
  if (created) { await syncDir(directory); await syncDir(dirname(directory)); }
}
async function trustedAncestry(directory, signal) {
  await privateDir(directory, signal);
  for (let path = dirname(directory);; path = dirname(path)) {
    imageCancelled(signal); const value = await lstat(path);
    if (value.isSymbolicLink()) await trustedAlias(path, value);
    else if (!trustedParent(value)) imageFail('IMAGE_ARTIFACT_UNSAFE');
    if (dirname(path) === path) break;
  }
  const canonical = await realpath(directory);
  for (let path = dirname(canonical);; path = dirname(path)) {
    imageCancelled(signal); const value = await lstat(path);
    if (!trustedParent(value)) imageFail('IMAGE_ARTIFACT_UNSAFE');
    if (dirname(path) === path) break;
  }
}
function trustedParent(value) {
  const owner = value.uid === 0 || value.uid === process.getuid();
  const writable = Boolean(value.mode & 0o022), stickyRoot = value.uid === 0 && Boolean(value.mode & 0o1000);
  return value.isDirectory() && !value.isSymbolicLink() && owner && (!writable || stickyRoot);
}
async function trustedAlias(path, value) {
  const aliases = new Map([['/tmp', '/private/tmp'], ['/var', '/private/var']]);
  if (value.uid !== 0 || !aliases.has(path) || await realpath(path) !== aliases.get(path)) imageFail('IMAGE_ARTIFACT_UNSAFE');
}
async function syncDir(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function createFile(filename, bytes, owned, signal) {
  imageCancelled(signal);
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    owned.set(filename, await handle.stat());
    await handle.writeFile(bytes); await handle.sync(); imageCancelled(signal);
  } finally { await handle.close(); }
}
async function readPrivate(filename, maximum, signal) {
  imageCancelled(signal);
  const initial = await lstat(filename);
  validateReadStat(initial, maximum);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    validateReadStat(before, maximum);
    if (before.dev !== initial.dev || before.ino !== initial.ino) imageFail('IMAGE_ARTIFACT_UNSAFE');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      imageCancelled(signal);
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat(); imageCancelled(signal);
    validateReadStat(after, maximum);
    if (offset !== before.size || after.size !== before.size) imageFail('IMAGE_ARTIFACT_UNSAFE');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
function validateReadStat(value, maximum) {
  if (!privateStat(value, 'isFile') || value.nlink !== 1 || value.size > maximum) imageFail('IMAGE_ARTIFACT_UNSAFE');
}
async function directoryFiles(directory, signal, deleting = false) {
  const iterator = await opendir(directory);
  const names = [];
  try {
    for (;;) {
      imageCancelled(signal); const entry = await iterator.read();
      if (!entry) break;
      names.push(entry.name); if (names.length > 2) imageFail('IMAGE_ARTIFACT_UNSAFE');
    }
  } finally { await iterator.close(); }
  if (deleting && (!names.length || isDeepStrictEqual(names, ['manifest.json']))) return names;
  if (!isDeepStrictEqual(names.sort(), ['bytes', 'manifest.json'])) imageFail('IMAGE_ARTIFACT_UNSAFE');
  return names;
}
async function cleanOwned(directory, owned) {
  for (const [filename, original] of owned) {
    try {
      const current = await lstat(filename);
      if (current.dev === original.dev && current.ino === original.ino && current.isFile()) await unlink(filename);
    } catch { /* Leave paths whose ownership cannot be established. */ }
  }
  try { await rmdir(directory); } catch { /* An unexpected file must never be removed. */ }
}
async function safe(operation) {
  try { return await operation(); }
  catch (error) { if (error instanceof ImageError) throw error; imageFail('IMAGE_ARTIFACT_UNAVAILABLE'); }
}

// Caller holds the exclusive runtime lease. Check private generated parents and
// ancestor ownership/writability on every operation; permit only known root-owned
// macOS /tmp and /var aliases. Crash orphans require separate bounded retention.
export function createArtifactFiles({ stateRoot, runId, expiresAt, clock = Date.now, validateBytes,
  validateHandle = validateArtifactHandle, validateSource = sourceValid }) {
  validateArtifactFactoryOptions({ stateRoot, runId, expiresAt, clock, validateBytes, validateHandle, validateSource });
  const root = resolve(stateRoot), base = join(root, 'artifacts'), run = join(base, runId);
  function fresh() {
    const now = clock();
    if (!time(now)) imageFail('IMAGE_ARTIFACT_INVALID');
    if (now >= expiresAt) imageFail('IMAGE_EXPIRED');
  }
  async function parents(signal, create = false) {
    await trustedAncestry(root, signal);
    if (create) { await ensureDir(base, signal); await ensureDir(run, signal); }
    else { await privateDir(base, signal); await privateDir(run, signal); }
  }
  async function existingParents(signal) {
    await trustedAncestry(root, signal);
    for (const directory of [base, run]) {
      if (await absentDirectory(directory)) { await syncDir(dirname(directory)); return false; }
      await privateDir(directory, signal);
    }
    return true;
  }
  async function manifest(handle, signal, deleting = false) {
    validateHandle(handle); scopeValid(handle, runId, expiresAt); await parents(signal);
    const directory = join(run, handle.id); await privateDir(directory, signal);
    const names = await directoryFiles(directory, signal, deleting);
    if (deleting && !names.length) return directory;
    let metadata;
    try { metadata = JSON.parse((await readPrivate(join(directory, 'manifest.json'), 16384, signal)).toString('utf8')); }
    catch (error) { if (error instanceof ImageError) throw error; imageFail('IMAGE_ARTIFACT_INVALID'); }
    if (!isDeepStrictEqual(metadata, handle)) imageFail('IMAGE_ARTIFACT_INVALID');
    return directory;
  }
  async function put(bytes, { metadata, source, signal } = {}) {
    return safe(async () => {
      fresh(); imageCancelled(signal);
      if (!validateSource(source)) imageFail('IMAGE_ARTIFACT_INVALID');
      if (!(bytes instanceof Uint8Array) || bytes.length > IMAGE_BOUNDS.fileBytes) imageFail('IMAGE_TOO_LARGE');
      const ownedBytes = Buffer.from(bytes);
      const handle = Object.freeze({ id: randomUUID(), runId, ...metadata, expiresAt, source: Object.freeze(structuredClone(source)) });
      validateHandle(handle); scopeValid(handle, runId, expiresAt); verifyBytes(ownedBytes, handle, validateBytes);
      await parents(signal, true); const directory = join(run, handle.id), owned = new Map();
      await mkdir(directory, { mode: 0o700 });
      try {
        await createFile(join(directory, 'bytes'), ownedBytes, owned, signal);
        fresh(); await createFile(join(directory, 'manifest.json'), Buffer.from(JSON.stringify(handle)), owned, signal);
        await syncDir(directory); await syncDir(run); imageCancelled(signal); fresh();
        return handle;
      } catch (error) { await cleanOwned(directory, owned); throw error; }
    });
  }
  async function read(handle, { signal } = {}) {
    return safe(async () => {
      fresh(); const directory = await manifest(handle, signal);
      const bytes = await readPrivate(join(directory, 'bytes'), handle.size, signal);
      verifyBytes(bytes, handle, validateBytes);
      fresh(); imageCancelled(signal); return bytes;
    });
  }
  async function remove(handle, { signal, allowMissing = false } = {}) {
    return safe(async () => {
      validateHandle(handle); scopeValid(handle, runId, expiresAt);
      if (allowMissing && !await existingParents(signal)) return false;
      if (allowMissing && await absentDirectory(join(run, handle.id))) { await syncDir(run); return false; }
      const directory = await manifest(handle, signal, allowMissing);
      await removableFiles(directory, signal, allowMissing);
      for (const file of ['bytes', 'manifest.json']) await unlinkOwned(join(directory, file), allowMissing);
      await rmdir(directory); await syncDir(run);
      return true;
    });
  }
  async function purgeExpired(handles, { signal } = {}) {
    return safe(async () => {
      if (!Array.isArray(handles) || handles.length > IMAGE_BOUNDS.count) imageFail('IMAGE_ARTIFACT_INVALID');
      const now = clock(); if (!time(now)) imageFail('IMAGE_ARTIFACT_INVALID');
      let count = 0;
      for (const handle of handles) {
        validateHandle(handle); scopeValid(handle, runId, expiresAt); imageCancelled(signal);
        if (handle.expiresAt <= now) { await remove(handle, { signal }); count++; }
      }
      return count;
    });
  }
  return { put, read, remove, purgeExpired };
}
function verifyBytes(bytes, handle, validateBytes) {
  let metadata;
  try { metadata = validateBytes(bytes, handle); }
  catch { imageFail('IMAGE_ARTIFACT_INVALID'); }
  for (const [key, value] of Object.entries(metadata)) if (value !== handle[key]) imageFail('IMAGE_ARTIFACT_INVALID');
}
async function absentDirectory(directory) {
  try { await lstat(directory); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function removableFiles(directory, signal, allowMissing) {
  for (const file of ['bytes', 'manifest.json']) {
    imageCancelled(signal);
    let current;
    try { current = await lstat(join(directory, file)); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') continue; throw error; }
    if (!privateStat(current, 'isFile') || current.nlink !== 1) imageFail('IMAGE_ARTIFACT_UNSAFE');
  }
}
async function unlinkOwned(filename, allowMissing) {
  try { await unlink(filename); }
  catch (error) { if (!allowMissing || error.code !== 'ENOENT') throw error; }
}
export async function removeArtifactReferences({ stateRoot, references, clock = Date.now, signal }) {
  if (!Array.isArray(references) || references.length > 100 || typeof clock !== 'function') imageFail('IMAGE_ARTIFACT_INVALID');
  const now = clock(); if (!time(now)) imageFail('IMAGE_ARTIFACT_INVALID');
  let removed = 0;
  for (const reference of references) {
    imageCancelled(signal);
    const handle = validateArtifactHandle(reference?.handle);
    if (reference.retired !== true && handle.expiresAt > now) continue;
    const files = createArtifactFiles({ stateRoot, runId: handle.runId, expiresAt: handle.expiresAt, clock, validateBytes: () => ({}) });
    if (await files.remove(handle, { signal, allowMissing: true })) removed++;
  }
  return removed;
}

async function boundedNames(directory, maximum, signal) {
  const iterator = await opendir(directory), names = [];
  try {
    for (;;) {
      imageCancelled(signal); const entry = await iterator.read(); if (!entry) break;
      names.push(entry.name); if (names.length > maximum) imageFail('IMAGE_ARTIFACT_LIMIT');
    }
  } finally { await iterator.close(); }
  return names;
}
function orphanSettings({ stateRoot, runId, expiresAt, references, clock, maxEntries }) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot.length > 4096 || stateRoot.includes('\0')) imageFail('IMAGE_ARTIFACT_INVALID');
  if (typeof runId !== 'string' || !uuid.test(runId) || !time(expiresAt) || typeof clock !== 'function') imageFail('IMAGE_ARTIFACT_INVALID');
  orphanLimits(references, maxEntries);
  const now = clock(); if (!time(now)) imageFail('IMAGE_ARTIFACT_INVALID');
  return { root: resolve(stateRoot), now, known: new Set(references) };
}
function orphanLimits(references, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 100) imageFail('IMAGE_ARTIFACT_LIMIT');
  if (!Array.isArray(references) || references.length > 100) imageFail('IMAGE_ARTIFACT_LIMIT');
  for (const id of references) if (typeof id !== 'string' || !uuid.test(id)) imageFail('IMAGE_ARTIFACT_INVALID');
}
async function knownRunDirectory(root, runId, signal) {
  await trustedAncestry(root, signal);
  const base = join(root, 'artifacts'), run = join(base, runId);
  for (const path of [base, run]) {
    if (await absentDirectory(path)) { await syncDir(dirname(path)); return null; }
    await privateDir(path, signal);
  }
  return run;
}
async function orphanManifest(directory, names, runId, id, now, signal) {
  if (!names.includes('manifest.json')) return true;
  const bytes = await readPrivate(join(directory, 'manifest.json'), 16384, signal);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return true; } // An expired known run authorizes cleanup of a partial manifest write.
  const handle = validateArtifactHandle(value);
  if (handle.id !== id || handle.runId !== runId) imageFail('IMAGE_ARTIFACT_INVALID');
  return handle.expiresAt <= now;
}
async function orphanCandidate(run, runId, id, now, signal) {
  const directory = join(run, id); await privateDir(directory, signal);
  const names = await boundedNames(directory, 2, signal);
  if (names.some(name => !['bytes', 'manifest.json'].includes(name))) imageFail('IMAGE_ARTIFACT_UNSAFE');
  for (const name of names) {
    const file = await lstat(join(directory, name)), maximum = name === 'bytes' ? IMAGE_BOUNDS.fileBytes : 16384;
    if (!privateStat(file, 'isFile') || file.nlink !== 1 || file.size > maximum) imageFail('IMAGE_ARTIFACT_UNSAFE');
  }
  const expired = await orphanManifest(directory, names, runId, id, now, signal);
  return expired ? { directory, names } : null;
}
export async function cleanExpiredRunOrphans({ stateRoot, runId, expiresAt, references = [], clock = Date.now, signal, maxEntries = 100 }) {
  return safe(async () => {
    imageCancelled(signal);
    const { root, now, known } = orphanSettings({ stateRoot, runId, expiresAt, references, clock, maxEntries });
    if (now < expiresAt) return { removed: 0, complete: true };
    const run = await knownRunDirectory(root, runId, signal);
    if (!run) return { removed: 0, complete: true };
    const names = await boundedNames(run, maxEntries, signal), candidates = [];
    for (const id of names) {
      if (!uuid.test(id)) imageFail('IMAGE_ARTIFACT_UNSAFE');
      if (known.has(id)) continue;
      const candidate = await orphanCandidate(run, runId, id, now, signal);
      if (candidate) candidates.push(candidate);
    }
    for (const candidate of candidates) await deleteOrphan(candidate, signal);
    await syncDir(run);
    return { removed: candidates.length, complete: true };
  });
}
async function deleteOrphan({ directory, names }, signal) {
  await privateDir(directory, signal);
  for (const name of names) {
    imageCancelled(signal); const file = await lstat(join(directory, name));
    if (!privateStat(file, 'isFile') || file.nlink !== 1) imageFail('IMAGE_ARTIFACT_UNSAFE');
  }
  for (const name of names) { imageCancelled(signal); await unlink(join(directory, name)); }
  await rmdir(directory);
}
