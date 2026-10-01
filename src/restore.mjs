import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, link, unlink, rmdir, readdir, rename } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TextDecoder } from 'node:util';
import { acquireStoppedLease } from './store.mjs';
import { restoreReservationPath } from './state-paths.mjs';
import { inspectSnapshot } from './backup.mjs';
import { maintenanceLimits } from './maintenance-limits.mjs';
import { runMaintenanceWorker } from './maintenance-worker.mjs';
import { validateArtifactHandle } from './artifact-files.mjs';
import { validateImage, IMAGE_BOUNDS } from './image-validation.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const emailPattern = /^[^\s@<>]{1,128}@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;
const markerName = '.restore-incomplete';
const workerCodes = new Set(['ABORTED', 'TIMEOUT', 'STATE_UNSAFE', 'INVALID_STATE', 'IDENTITY_MISMATCH', 'UNSUPPORTED_SCHEMA', 'TOO_LARGE', 'FAILED']);
const backupCodes = new Set(['BACKUP_DESTINATION_EXISTS', 'BACKUP_DESTINATION_UNSAFE', 'BACKUP_INVALID_INPUT', 'BACKUP_INVALID_STATE',
  'BACKUP_STATE_UNSAFE', 'BACKUP_TOO_LARGE', 'BACKUP_IDENTITY_MISMATCH', 'BACKUP_UNSUPPORTED_SCHEMA', 'BACKUP_ABORTED', 'BACKUP_FAILED']);

export class RestoreError extends Error {
  constructor(code) {
    super(code === 'BACKUP_DESTINATION_EXISTS' ? 'Restore destination already exists.' : 'State restore could not complete.');
    this.name = 'RestoreError';
    this.code = code;
  }
}

function fail(code) { throw new RestoreError(code); }
function time(value) { return Number.isSafeInteger(value) && value >= 0; }
function digest(value) { return typeof value === 'string' && digestPattern.test(value); }
function abort(signal) { if (signal?.aborted) fail('BACKUP_ABORTED'); }

function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) fail('BACKUP_INVALID_INPUT');
  return resolve(value);
}

function validateIdentityAndActor(identity, actor, reason, clock) {
  const validActor = typeof actor === 'string' && emailPattern.test(actor.trim()) && actor.trim() === actor;
  if (!digest(identity) || typeof clock !== 'function' || !validActor || typeof reason !== 'string' || !reason.trim() || reason.length > 2048) fail('BACKUP_INVALID_INPUT');
}

function validateSignal(signal) {
  if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) fail('BACKUP_INVALID_INPUT');
}

function limitsFor(maxBytes, timeoutMs) {
  let limits;
  try { limits = maintenanceLimits({ maxBytes, timeoutMs }); } catch { fail('BACKUP_INVALID_INPUT'); }
  return limits;
}

function validateOptions({ snapshot, stateRoot, identity, actor, reason, clock, signal, maxBytes, timeoutMs }) {
  validateIdentityAndActor(identity, actor, reason, clock);
  validateSignal(signal);
  const limits = limitsFor(maxBytes, timeoutMs);
  const restoredAt = clock();
  if (!time(restoredAt)) fail('BACKUP_INVALID_INPUT');
  return { snapshot: safePath(snapshot), stateRoot: safePath(stateRoot), identity, actor, reason, restoredAt, signal, ...limits };
}

function privateDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid();
}

function safeParentDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o022) && stat.uid === process.getuid();
}

function privateFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.uid === process.getuid();
}

async function checkDestination(target) {
  const parent = dirname(target);
  const parentStat = await lstat(parent).catch(() => null);
  if (!parentStat || !safeParentDirectory(parentStat)) fail('BACKUP_DESTINATION_UNSAFE');
  const canonicalParent = await realpath(parent).catch(() => null);
  if (!canonicalParent) fail('BACKUP_DESTINATION_UNSAFE');
  const canonicalStat = await lstat(canonicalParent).catch(() => null);
  if (!canonicalStat || !safeParentDirectory(canonicalStat)) fail('BACKUP_DESTINATION_UNSAFE');
  const canonicalTarget = join(canonicalParent, basename(target));
  try { await lstat(canonicalTarget); fail('BACKUP_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { parent: canonicalParent, parentStat: canonicalStat, target: canonicalTarget };
}

function sameFile(left, right) { return left && right && left.dev === right.dev && left.ino === right.ino; }

async function writeMarker(path, signal) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    abort(signal);
    await handle.writeFile('restore in progress\n', 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    return await handle.stat();
  } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function copySnapshot(source, destination, maxBytes, signal, owned) {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    const sourceStat = await sourceHandle.stat();
    if (!privateFile(sourceStat) || sourceStat.size > maxBytes) fail(sourceStat.size > maxBytes ? 'BACKUP_TOO_LARGE' : 'BACKUP_STATE_UNSAFE');
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned.stageFiles.set(destination, await output.stat());
    await output.chmod(0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const cap = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new RestoreError('BACKUP_TOO_LARGE'));
      else { hash.update(chunk); callback(null, chunk); }
    } });
    await pipeline(createReadStream(source, { fd: sourceHandle.fd, autoClose: false }), cap, createWriteStream(destination, { fd: output.fd, autoClose: false }), { signal });
    if (bytes !== sourceStat.size) fail('BACKUP_INVALID_STATE');
    await output.sync();
    return hash.digest('hex');
  } finally {
    await output?.close();
    await sourceHandle.close();
  }
}

async function artifactBytes(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!privateFile(before) || before.size > maximum) fail('BACKUP_STATE_UNSAFE');
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || !privateFile(after)) fail('BACKUP_STATE_UNSAFE');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function verifyArtifactContent(handle, bytes) {
  if (bytes.length !== handle.size || createHash('sha256').update(bytes).digest('hex') !== handle.sha256) fail('BACKUP_INVALID_STATE');
  if (handle.mediaType.startsWith('image/')) {
    let metadata;
    try { metadata = validateImage(bytes, { mediaType: handle.mediaType, maxBytes: IMAGE_BOUNDS.fileBytes, maxPixels: IMAGE_BOUNDS.hardPixels }); }
    catch { fail('BACKUP_INVALID_STATE'); }
    if (!isDeepStrictEqual(metadata, { mediaType: handle.mediaType, size: handle.size, width: handle.width,
      height: handle.height, sha256: handle.sha256 })) fail('BACKUP_INVALID_STATE');
    return;
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('BACKUP_INVALID_STATE'); }
  if (!text.trim() || text.includes('\0')) fail('BACKUP_INVALID_STATE');
}

async function registerDirectory(path, directories) {
  await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!privateDirectory(stat)) fail('BACKUP_DESTINATION_UNSAFE');
  directories.set(path, stat);
}

async function registerArtifactFile(path, bytes, files) {
  const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    files.set(path, await output.stat());
    await output.chmod(0o600);
    await output.writeFile(bytes); await output.sync();
  } finally { await output.close(); }
}

async function copySnapshotArtifacts(snapshot, stage, manifest, owned, signal) {
  if (manifest.format !== 2) return;
  const sourceRoot = join(snapshot, 'artifacts'), targetRoot = join(stage, 'artifacts');
  owned.stageDirectories ??= new Map();
  owned.stageFiles ??= new Map();
  await registerDirectory(targetRoot, owned.stageDirectories);
  const references = manifest.artifacts.map(item => ({ purpose: item.purpose, createdAt: item.createdAt, handle: validateArtifactHandle(item.handle) }));
  const runDirs = new Set();
  for (const { handle } of references) {
    abort(signal);
    const source = join(sourceRoot, handle.runId, handle.id);
    const metaBytes = await artifactBytes(join(source, 'manifest.json'), 16_384);
    let saved;
    try { saved = validateArtifactHandle(JSON.parse(metaBytes.toString('utf8'))); } catch { fail('BACKUP_INVALID_STATE'); }
    if (!isDeepStrictEqual(saved, handle)) fail('BACKUP_INVALID_STATE');
    const bytes = await artifactBytes(join(source, 'bytes'), handle.size);
    verifyArtifactContent(handle, bytes);
    const targetRun = join(targetRoot, handle.runId);
    if (!runDirs.has(handle.runId)) { await registerDirectory(targetRun, owned.stageDirectories); runDirs.add(handle.runId); }
    const target = join(targetRun, handle.id);
    await registerDirectory(target, owned.stageDirectories);
    await registerArtifactFile(join(target, 'bytes'), bytes, owned.stageFiles);
    await registerArtifactFile(join(target, 'manifest.json'), Buffer.from(JSON.stringify(handle)), owned.stageFiles);
    await syncDirectory(target);
  }
  await syncDirectory(targetRoot);
}

async function registerPublishedArtifactTree(owned, targetRoot, references) {
  owned.targetDirectories ??= new Map();
  owned.targetFiles ??= new Map();
  owned.targetDirectories.set(targetRoot, await lstat(targetRoot));
  const runIds = [...new Set(references.map(item => item.handle.runId))];
  for (const runId of runIds) owned.targetDirectories.set(join(targetRoot, runId), await lstat(join(targetRoot, runId)));
  for (const { handle } of references) {
    const directory = join(targetRoot, handle.runId, handle.id);
    owned.targetDirectories.set(directory, await lstat(directory));
    for (const name of ['bytes', 'manifest.json']) {
      const path = join(directory, name); owned.targetFiles.set(path, await lstat(path));
    }
  }
}

function safeWorkerError(error) {
  if (error instanceof RestoreError) return error;
  if (backupCodes.has(error?.code)) return new RestoreError(error.code);
  const code = typeof error?.code === 'string' ? error.code.replace(/^MAINTENANCE_/, '') : '';
  const allowed = workerCodes.has(code) ? `BACKUP_${code}` : 'BACKUP_FAILED';
  return new RestoreError(allowed);
}

function workerMetadata(value, identity) {
  if (!value || value.mailboxIdentity !== identity || !digest(value.sha256)) fail('BACKUP_FAILED');
  if (!Number.isInteger(value.stateSchema) || value.stateSchema < 0 || value.stateSchema > 5) fail('BACKUP_UNSUPPORTED_SCHEMA');
}

async function removeOwnedFiles(files) {
  for (const [path, prior] of files ?? []) {
    try { if (sameFile(await lstat(path), prior)) await unlink(path); } catch { /* Preserve paths not owned by this operation. */ }
  }
}

async function cleanupTarget(owned) {
  if (!owned.targetStat) return;
  try {
    if (!sameFile(await lstat(owned.target), owned.targetStat)) return;
    await removeOwnedFiles(owned.targetFiles);
    for (const [path, prior] of [...(owned.targetDirectories ?? [])].reverse()) {
      try { if (sameFile(await lstat(path), prior)) await rmdir(path); } catch { /* Preserve non-owned directories. */ }
    }
    try { await rmdir(owned.target); } catch { /* A nonempty target is preserved. */ }
  } catch { /* A replacement target is never removed. */ }
}

async function cleanupStage(owned) {
  if (!owned.stageStat) return;
  try {
    if (!sameFile(await lstat(owned.stage), owned.stageStat)) return;
    await removeOwnedFiles(owned.stageFiles);
    for (const [path, prior] of [...(owned.stageDirectories ?? [])].reverse()) {
      try { if (sameFile(await lstat(path), prior)) await rmdir(path); } catch { /* Preserve non-owned directories. */ }
    }
    try { await rmdir(owned.stage); } catch { /* Preserve nonempty or replaced stage directories. */ }
  } catch { /* A replacement stage is never removed. */ }
}

async function cleanupReservation(owned) {
  if (!owned.reservationStat) return;
  try { await lstat(owned.target); return; } catch (error) { if (error.code !== 'ENOENT') return; }
  try { if (sameFile(await lstat(owned.reservation), owned.reservationStat)) await unlink(owned.reservation); } catch { /* Preserve a reservation not created by this operation. */ }
  try { await syncDirectory(dirname(owned.reservation)); } catch { /* Cleanup is best effort after an interrupted import. */ }
}

async function cleanup(owned) {
  if (owned.release) {
    try { owned.release(); } catch { /* Always try to drop the local ownership lease. */ }
    owned.release = null;
  }
  await cleanupTarget(owned);
  await cleanupStage(owned);
  await cleanupReservation(owned);
}

async function clearClosedWorkerSidecars(stage, owned) {
  const allowed = new Set(['agent.sqlite-wal', 'agent.sqlite-shm', 'agent.sqlite-journal', 'owner.sqlite', 'owner.sqlite-journal', 'owner.sqlite-wal', 'owner.sqlite-shm', 'owner.lock']);
  for (const name of await readdir(stage)) {
    if (name === 'agent.sqlite') continue;
    if (name === 'artifacts') {
      const artifactRoot = join(stage, name), stat = await lstat(artifactRoot);
      if (!privateDirectory(stat)) fail('BACKUP_STATE_UNSAFE');
      continue;
    }
    if (!allowed.has(name)) fail('BACKUP_STATE_UNSAFE');
    const path = join(stage, name);
    const stat = await lstat(path);
    if (!privateFile(stat)) fail('BACKUP_STATE_UNSAFE');
    owned.stageFiles.set(path, stat);
    if (name.startsWith('agent.sqlite') && (name.endsWith('-wal') || name.endsWith('-journal')) && stat.size > 0) fail('BACKUP_INVALID_STATE');
    await unlink(path);
    owned.stageFiles.delete(path);
  }
  await syncDirectory(stage);
}

async function stageSnapshot(value, dependencies, owned, parent) {
  const { manifest, databasePath } = await dependencies.inspectSnapshot({ directory: value.snapshot, identity: value.identity,
    maxBytes: value.maxBytes, timeoutMs: value.timeoutMs, signal: value.signal }, { workerRunner: dependencies.workerRunner });
  if (!manifest || !uuidPattern.test(manifest.id) || !time(manifest.createdAt) || manifest.mailboxIdentity !== value.identity || !digest(manifest.sha256)) fail('BACKUP_INVALID_STATE');
  owned.target = value.stateRoot;
  owned.stage = await mkdtemp(join(parent, `.${basename(value.stateRoot)}-restore-`));
  owned.stageStat = await lstat(owned.stage);
  await chmod(owned.stage, 0o700);
  owned.stageStat = await lstat(owned.stage);
  if (!privateDirectory(owned.stageStat)) fail('BACKUP_DESTINATION_UNSAFE');
  owned.stageDatabase = join(owned.stage, 'agent.sqlite');
  owned.stageFiles = new Map();
  const copiedHash = await copySnapshot(databasePath, owned.stageDatabase, value.maxBytes, value.signal, owned);
  owned.stageFiles.set(owned.stageDatabase, await lstat(owned.stageDatabase));
  if (!timingSafeEqual(Buffer.from(copiedHash), Buffer.from(manifest.sha256))) fail('BACKUP_INVALID_STATE');
  await copySnapshotArtifacts(value.snapshot, owned.stage, manifest, owned, value.signal);
  abort(value.signal);
  const inspected = await dependencies.workerRunner({ operation: 'validate', source: owned.stageDatabase, identity: value.identity, maxBytes: value.maxBytes },
    { signal: value.signal, timeoutMs: value.timeoutMs });
  workerMetadata(inspected, value.identity);
  if (inspected.stateSchema !== manifest.stateSchema || !timingSafeEqual(Buffer.from(inspected.sha256), Buffer.from(manifest.sha256))) fail('BACKUP_INVALID_STATE');
  const hold = { snapshotId: manifest.id, snapshotCreatedAt: manifest.createdAt, restoredAt: value.restoredAt };
  const metadata = await dependencies.workerRunner({ operation: 'restore', source: owned.stageDatabase, identity: value.identity, maxBytes: value.maxBytes,
    hold, actorDigest: createHash('sha256').update(value.actor).digest('hex'), reasonDigest: createHash('sha256').update(value.reason).digest('hex') },
  { signal: value.signal, timeoutMs: value.timeoutMs });
  abort(value.signal);
  workerMetadata(metadata, value.identity);
  if (metadata.stateSchema !== 5) fail('BACKUP_UNSUPPORTED_SCHEMA');
  await clearClosedWorkerSidecars(owned.stage, owned);
  const stagedStat = await lstat(owned.stageDatabase);
  if (!privateFile(stagedStat)) fail('BACKUP_STATE_UNSAFE');
  return { manifest, stagedStat };
}

async function publishRestoredState(value, { manifest, stagedStat }, owned, parent, linkImpl) {
  const targetStat = await lstat(value.stateRoot).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (targetStat) fail('BACKUP_DESTINATION_EXISTS');
  await mkdir(value.stateRoot, { mode: 0o700 });
  owned.targetStat = await lstat(value.stateRoot);
  await chmod(value.stateRoot, 0o700);
  if (!privateDirectory(owned.targetStat)) fail('BACKUP_DESTINATION_UNSAFE');
  const marker = join(value.stateRoot, markerName);
  owned.targetFiles = new Map([[marker, await writeMarker(marker, value.signal)]]);
  await syncDirectory(value.stateRoot);
  try { owned.release = acquireStoppedLease(value.stateRoot); }
  catch { fail('BACKUP_STATE_UNSAFE'); }
  const ownerDatabase = join(value.stateRoot, 'owner.sqlite');
  owned.targetFiles.set(ownerDatabase, await lstat(ownerDatabase));
  abort(value.signal);
  const destination = join(value.stateRoot, 'agent.sqlite');
  await linkImpl(owned.stageDatabase, destination);
  owned.targetFiles.set(destination, stagedStat);
  await chmod(destination, 0o600);
  if (manifest.format === 2) {
    const stagedArtifacts = join(owned.stage, 'artifacts'), targetArtifacts = join(value.stateRoot, 'artifacts');
    await rename(stagedArtifacts, targetArtifacts);
    for (const path of [...owned.stageFiles.keys()]) if (path.startsWith(`${stagedArtifacts}/`)) owned.stageFiles.delete(path);
    for (const path of [...owned.stageDirectories.keys()]) if (path === stagedArtifacts || path.startsWith(`${stagedArtifacts}/`)) owned.stageDirectories.delete(path);
    await registerPublishedArtifactTree(owned, targetArtifacts, manifest.artifacts);
    await syncDirectory(targetArtifacts);
  }
  await syncDirectory(value.stateRoot);
  await syncDirectory(parent);
  abort(value.signal);
  await unlink(owned.stageDatabase);
  owned.stageFiles.delete(owned.stageDatabase);
  await rmdir(owned.stage);
  owned.stageStat = null;
  await syncDirectory(parent);
  await unlink(marker);
  owned.targetFiles.delete(marker);
  await syncDirectory(value.stateRoot);
  owned.release();
  owned.release = null;
  await unlink(owned.reservation);
  owned.reservationStat = null;
  owned.targetStat = null;
  await syncDirectory(parent);
  return { snapshotId: manifest.id, stateRoot: value.stateRoot, stateSchema: 5, recoveryRequired: true };
}

async function restore(value, dependencies, owned) {
  abort(value.signal);
  const destinationInfo = await checkDestination(value.stateRoot);
  value.stateRoot = destinationInfo.target;
  owned.target = value.stateRoot;
  owned.reservation = restoreReservationPath(value.stateRoot);
  try { owned.reservationStat = await writeMarker(owned.reservation); }
  catch (error) { if (error.code === 'EEXIST') fail('BACKUP_DESTINATION_EXISTS'); throw error; }
  await syncDirectory(destinationInfo.parent);
  abort(value.signal);
  const staged = await stageSnapshot(value, dependencies, owned, destinationInfo.parent);
  return publishRestoredState(value, staged, owned, destinationInfo.parent, dependencies.linkImpl);
}

/** Import a snapshot into an absent state root. The restored database is held for operator reconciliation. */
export async function restoreState(options, { workerRunner = runMaintenanceWorker, inspectSnapshot: inspect = inspectSnapshot, linkImpl = link } = {}) {
  const owned = { targetFiles: new Map() };
  let value;
  let budgetSignal;
  try {
    value = validateOptions({ clock: Date.now, ...options });
    budgetSignal = AbortSignal.timeout(value.timeoutMs);
    const signal = value.signal ? AbortSignal.any([value.signal, budgetSignal]) : budgetSignal;
    value.signal = signal;
    return await restore(value, { workerRunner, inspectSnapshot: inspect, linkImpl }, owned);
  } catch (error) {
    await cleanup(owned);
    throw safeWorkerError(error);
  }
}
