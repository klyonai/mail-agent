import { lstat, mkdir, chmod, open, unlink, rmdir, link, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { TextDecoder } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { acquireStoppedLease } from './store.mjs';
import { maintenanceLimits } from './maintenance-limits.mjs';
import { runMaintenanceWorker } from './maintenance-worker.mjs';
import { validateArtifactHandle } from './artifact-files.mjs';
import { validStateSchema } from './state-schema.mjs';
import { validateImage, IMAGE_BOUNDS } from './image-validation.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const manifestKeysV1 = ['format', 'id', 'createdAt', 'mailboxIdentity', 'stateSchema', 'applicationVersion', 'database', 'sha256'];
const manifestKeysV2 = [...manifestKeysV1, 'artifacts'];
const workerCodes = new Set(['ABORTED', 'TIMEOUT', 'STATE_UNSAFE', 'INVALID_STATE', 'IDENTITY_MISMATCH', 'UNSUPPORTED_SCHEMA', 'TOO_LARGE', 'FAILED']);

export class BackupError extends Error {
  constructor(code) {
    super(code === 'BACKUP_OWNED' ? 'State backup requires the agent to be stopped.' : 'State backup could not complete.');
    this.name = 'BackupError'; this.code = code;
  }
}

function fail(code) { throw new BackupError(code); }
function aborted(signal) { if (signal?.aborted) fail('BACKUP_ABORTED'); }
function time(value) { return Number.isSafeInteger(value) && value >= 0; }
function digest(value) { return typeof value === 'string' && digestPattern.test(value); }
function version(value) { return typeof value === 'string' && value.length <= 64 && versionPattern.test(value); }
function path(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) fail('BACKUP_INVALID_INPUT');
  return resolve(value);
}

function settings({ stateRoot, directory, identity, clock = Date.now, snapshotId = randomUUID(), applicationVersion = '0.1.0', signal, maxBytes, timeoutMs }) {
  validateIdentityFields({ identity, snapshotId, applicationVersion, clock });
  validateSignal(signal);
  const limits = readLimits({ maxBytes, timeoutMs });
  const createdAt = clock();
  if (!time(createdAt)) fail('BACKUP_INVALID_INPUT');
  return { stateRoot: path(stateRoot), directory: path(directory), identity, snapshotId, applicationVersion, signal, createdAt, ...limits };
}

function readLimits(value) {
  try { return maintenanceLimits(value); } catch { fail('BACKUP_INVALID_INPUT'); }
}

function validateIdentityFields({ identity, snapshotId, applicationVersion, clock }) {
  if (!digest(identity) || typeof snapshotId !== 'string' || !uuidPattern.test(snapshotId) || !version(applicationVersion) || typeof clock !== 'function') fail('BACKUP_INVALID_INPUT');
}

function validateSignal(signal) {
  if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) fail('BACKUP_INVALID_INPUT');
}

function deadline(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { timeout, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, caller: signal };
}

function operationError(error, budget) {
  if (budget?.timeout.aborted && !budget.caller?.aborted) return new BackupError('BACKUP_TIMEOUT');
  return safeError(error);
}

function privateStat(stat, kind) {
  return stat[kind]() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid();
}

async function privateDirectory(directory, code) {
  let stat;
  try { stat = await lstat(directory); } catch { fail(code); }
  if (!privateStat(stat, 'isDirectory')) fail(code);
  return stat;
}

async function privateFile(filename, { optional = false, code = 'BACKUP_STATE_UNSAFE' } = {}) {
  let stat;
  try { stat = await lstat(filename); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; fail(code); }
  if (!privateStat(stat, 'isFile') || stat.nlink !== 1) fail(code);
  return stat;
}

async function guardDatabase(filename, maxBytes) {
  const file = await privateFile(filename);
  const wal = await privateFile(`${filename}-wal`, { optional: true });
  for (const suffix of ['-shm', '-journal']) await privateFile(`${filename}${suffix}`, { optional: true });
  if (file.size + (wal?.size ?? 0) > maxBytes) fail('BACKUP_TOO_LARGE');
}

async function freshDestination(directory) {
  await privateDirectory(dirname(directory), 'BACKUP_DESTINATION_UNSAFE');
  try { await lstat(directory); fail('BACKUP_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function createOwnedFile(filename, owned) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    owned.files.set(filename, await handle.stat());
    await handle.chmod(0o600);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function syncFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function safeWorkerValue(value, identity) {
  if (!value || value.mailboxIdentity !== identity || !digest(value.sha256)) fail('BACKUP_FAILED');
  if (!Number.isInteger(value.stateSchema) || value.stateSchema < 0 || value.stateSchema > 5) fail('BACKUP_UNSUPPORTED_SCHEMA');
}

async function publishManifest(directory, manifest, owned, signal) {
  aborted(signal);
  const staging = join(directory, '.manifest.pending');
  const destination = join(directory, 'manifest.json');
  const handle = await createOwnedFile(staging, owned);
  try { await handle.writeFile(`${JSON.stringify(manifest)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  aborted(signal);
  await link(staging, destination); // An atomic completion marker; an existing path can never be overwritten.
  owned.files.set(destination, owned.files.get(staging));
  await unlink(staging);
  owned.files.delete(staging);
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  aborted(signal);
}

const maxArtifactRefs = 100;
const maxParityRuns = 10_000;

function liveArtifactRows(stateRoot) {
  const filename = join(stateRoot, 'agent.sqlite');
  const db = new DatabaseSync(filename, { readOnly: true, allowExtension: false, timeout: 0 });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON;');
    return artifactRowsFromDb(db);
  } finally { db.close(); }
}

function artifactRowsFromDb(db) {
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (version !== '5' || !validStateSchema(db, 5)) fail('BACKUP_INVALID_STATE');
  const rows = db.prepare(`SELECT handle,run_id,purpose,created_at,expires_at,metadata FROM artifact_refs
    WHERE retired_at IS NULL ORDER BY handle LIMIT ?`).all(maxArtifactRefs + 1);
  if (rows.length > maxArtifactRefs) fail('BACKUP_TOO_LARGE');
  const artifacts = rows.map(row => {
    let handle;
    try { handle = validateArtifactHandle(JSON.parse(row.metadata)); } catch { fail('BACKUP_INVALID_STATE'); }
    if (row.handle !== handle.id || row.run_id !== handle.runId || row.expires_at !== handle.expiresAt
      || !time(row.created_at) || handle.expiresAt < row.created_at
      || !['image-input', 'text-output'].includes(row.purpose)) fail('BACKUP_INVALID_STATE');
    return { purpose: row.purpose, createdAt: row.created_at, handle };
  });
  validateRunArtifactParity(db, artifacts);
  return artifacts;
}

function validateRunArtifactParity(db, artifacts) {
  const rows = db.prepare(`SELECT id,data FROM runs
    WHERE json_type(data,'$.imageArtifacts')='array' OR json_type(data,'$.outputArtifact')='object' LIMIT ?`).all(maxParityRuns + 1);
  if (rows.length > maxParityRuns) fail('BACKUP_TOO_LARGE');
  const expected = new Map();
  for (const row of rows) addRunExpectations(expected, row);
  if (expected.size !== artifacts.length) fail('BACKUP_INVALID_STATE');
  for (const artifact of artifacts) {
    const key = `${artifact.purpose}:${artifact.handle.id}`;
    const handle = expected.get(key);
    if (!handle || !isDeepStrictEqual(handle, artifact.handle)) fail('BACKUP_INVALID_STATE');
  }
}

function addRunExpectations(expected, row) {
  let run;
  try { run = JSON.parse(row.data); } catch { fail('BACKUP_INVALID_STATE'); }
  const inputs = run.imageArtifacts ?? [];
  if (!Array.isArray(inputs) || inputs.length > 4) fail('BACKUP_INVALID_STATE');
  for (const handle of inputs) addExpected(expected, 'image-input', row.id, handle);
  validateContextReferences(inputs, run.messages);
  validateOutputReference(run, expected, row.id);
}

function validateOutputReference(run, expected, runId) {
  if (!run.outputArtifact) {
    if (run.deliveryIntent || run.replyKind === 'transcript') fail('BACKUP_INVALID_STATE');
    return;
  }
  addExpected(expected, 'text-output', runId, run.outputArtifact);
  validateDeliveryIntent(run, run.outputArtifact);
}

function validateDeliveryIntent(run, handle) {
  const intent = run.deliveryIntent;
  const keys = ['messageId', 'conversationId', 'recipient', 'bodySha256', 'artifactId', 'artifactSha256', 'filename', 'mediaType', 'size', 'expiresAt', 'payloadSha256'];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent) || Object.keys(intent).length !== keys.length
    || !keys.every(key => Object.hasOwn(intent, key)) || !run.mail || !run.reply) fail('BACKUP_INVALID_STATE');
  if (!intentMatchesRun(intent, run) || !intentMatchesArtifact(intent, handle)) fail('BACKUP_INVALID_STATE');
}

function intentMatchesRun(intent, run) {
  const digestPattern = /^[a-f0-9]{64}$/;
  const bodyDigest = createHash('sha256').update(run.reply).digest('hex');
  return intent.messageId === run.mail.id && intent.conversationId === run.mail.conversationId
    && intent.recipient === String(run.mail.sender).toLowerCase() && intent.bodySha256 === bodyDigest
    && digestPattern.test(intent.bodySha256 ?? '');
}

function intentMatchesArtifact(intent, handle) {
  return intent.artifactId === handle.id && intent.artifactSha256 === handle.sha256
    && intent.filename === handle.name && intent.mediaType === handle.mediaType && intent.size === handle.size
    && intent.expiresAt === handle.expiresAt && /^[a-f0-9]{64}$/.test(intent.payloadSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(intent.artifactSha256 ?? '');
}

function validateContextReferences(inputs, messages) {
  if (messages == null) return;
  const references = contextParts(messages);
  if (references.length !== inputs.length) fail('BACKUP_INVALID_STATE');
  for (const [index, part] of references.entries()) {
    let canonical;
    try { canonical = validateArtifactHandle(part.artifact); } catch { fail('BACKUP_INVALID_STATE'); }
    if (!isDeepStrictEqual(inputs[index], canonical)) fail('BACKUP_INVALID_STATE');
  }
}

function contextParts(messages) {
  if (messages == null) return [];
  if (!Array.isArray(messages) || messages.length > 4096) fail('BACKUP_INVALID_STATE');
  const current = messages.findLastIndex(message => message?.role === 'user');
  let parts = 0;
  const references = [];
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    parts += content.length;
    if (parts > 4096) fail('BACKUP_INVALID_STATE');
    references.push(...imageReferences(content, index, current));
  }
  return references;
}

function imageReferences(content, index, current) {
  const references = [];
  for (const part of content) {
    if (part?.type === 'file' || part?.type === 'image') fail('BACKUP_INVALID_STATE');
    if (part?.type !== 'image-reference') continue;
    if (index !== current) fail('BACKUP_INVALID_STATE');
    references.push(part);
  }
  return references;
}

function addExpected(expected, purpose, runId, value) {
  let handle;
  try { handle = validateArtifactHandle(value); } catch { fail('BACKUP_INVALID_STATE'); }
  if (handle.runId !== runId) fail('BACKUP_INVALID_STATE');
  const key = `${purpose}:${handle.id}`;
  if (expected.has(key)) fail('BACKUP_INVALID_STATE');
  expected.set(key, handle);
}

async function privateBytes(filename, maxBytes) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!privateStat(before, 'isFile') || before.nlink !== 1 || before.size > maxBytes) fail('BACKUP_STATE_UNSAFE');
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || after.size !== before.size || !privateStat(after, 'isFile') || after.nlink !== 1) fail('BACKUP_STATE_UNSAFE');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

async function directoryNames(directory, maximum = 3) {
  const iterator = await opendir(directory);
  const names = [];
  try {
    for (;;) { const entry = await iterator.read(); if (!entry) break; names.push(entry.name); if (names.length > maximum) fail('BACKUP_INVALID_STATE'); }
  } finally { await iterator.close(); }
  return names.sort();
}

async function createPrivateDirectory(path, owned) {
  await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  if (!privateStat(stat, 'isDirectory')) fail('BACKUP_STATE_UNSAFE');
  owned.directories ??= new Map();
  owned.directories.set(path, stat);
}

async function ensurePrivateDirectory(path, owned) {
  try { await createPrivateDirectory(path, owned); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await privateDirectory(path, 'BACKUP_STATE_UNSAFE');
  }
}

async function copyArtifact(sourceRoot, destinationRoot, artifact, owned, signal, maxBytes) {
  aborted(signal);
  const handle = artifact.handle;
  const source = join(sourceRoot, 'artifacts', handle.runId, handle.id);
  await privateDirectory(join(sourceRoot, 'artifacts'), 'BACKUP_STATE_UNSAFE');
  await privateDirectory(join(sourceRoot, 'artifacts', handle.runId), 'BACKUP_STATE_UNSAFE');
  await privateDirectory(source, 'BACKUP_STATE_UNSAFE');
  const names = await directoryNames(source);
  if (names.length !== 2 || names[0] !== 'bytes' || names[1] !== 'manifest.json') fail('BACKUP_INVALID_STATE');
  const metadataBytes = await privateBytes(join(source, 'manifest.json'), 16_384);
  let metadata;
  try { metadata = validateArtifactHandle(JSON.parse(metadataBytes.toString('utf8'))); } catch { fail('BACKUP_INVALID_STATE'); }
  if (!isDeepStrictEqual(metadata, handle)) fail('BACKUP_INVALID_STATE');
  const bytes = await privateBytes(join(source, 'bytes'), Math.min(maxBytes, handle.size));
  verifyArtifactBytes(handle, bytes);
  aborted(signal);

  const target = join(destinationRoot, handle.runId, handle.id);
  await ensurePrivateDirectory(join(destinationRoot, handle.runId), owned);
  await createPrivateDirectory(target, owned);
  const bytePath = join(target, 'bytes'), metaPath = join(target, 'manifest.json');
  const byteFile = await createOwnedFile(bytePath, owned);
  try { await byteFile.writeFile(bytes); await byteFile.sync(); } finally { await byteFile.close(); }
  const metaFile = await createOwnedFile(metaPath, owned);
  try { await metaFile.writeFile(`${JSON.stringify(handle)}\n`); await metaFile.sync(); } finally { await metaFile.close(); }
  await syncDirectory(target);
}

async function copyArtifacts(stateRoot, directory, artifacts, owned, signal, maxBytes, databaseBytes) {
  const target = join(directory, 'artifacts');
  await createPrivateDirectory(target, owned);
  let total = databaseBytes;
  for (const artifact of artifacts) {
    aborted(signal);
    total += artifact.handle.size;
    if (total > maxBytes) fail('BACKUP_TOO_LARGE');
    await copyArtifact(stateRoot, target, artifact, owned, signal, maxBytes - total + artifact.handle.size);
  }
  await syncDirectory(target);
}

function sameFile(current, prior) { return current.ino === prior.ino && current.dev === prior.dev; }

async function cleanup(owned) {
  if (!owned.stat) return;
  try {
    if (!sameFile(await lstat(owned.directory), owned.stat)) return;
    for (const [filename, prior] of owned.files) {
      try { if (sameFile(await lstat(filename), prior)) await unlink(filename); } catch { /* Preserve unfamiliar paths. */ }
    }
    for (const [directory, prior] of [...(owned.directories ?? [])].reverse()) {
      try { if (sameFile(await lstat(directory), prior)) await rmdir(directory); } catch { /* Preserve unfamiliar directories. */ }
    }
    try { await rmdir(owned.directory); } catch { /* An unfamiliar or inaccessible file is never deleted. */ }
  } catch { /* The incomplete directory stays private; no completion is reported. */ }
}

function safeError(error) {
  if (error instanceof BackupError) return error;
  const code = typeof error?.code === 'string' ? error.code.replace(/^MAINTENANCE_/, '') : '';
  return new BackupError(workerCodes.has(code) ? `BACKUP_${code}` : 'BACKUP_FAILED');
}

async function exportSnapshot(value, owned, workerRunner) {
  const source = join(value.stateRoot, 'agent.sqlite');
  await guardDatabase(source, value.maxBytes);
  aborted(value.signal);
  try { await mkdir(value.directory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('BACKUP_DESTINATION_EXISTS'); throw error; }
  owned.stat = await lstat(value.directory);
  await chmod(value.directory, 0o700);
  const destination = join(value.directory, 'snapshot.sqlite');
  const handle = await createOwnedFile(destination, owned);
  await handle.close();
  const metadata = await workerRunner({ operation: 'snapshot', source, destination, identity: value.identity, maxBytes: value.maxBytes },
    { signal: value.signal, timeoutMs: value.timeoutMs });
  aborted(value.signal);
  safeWorkerValue(metadata, value.identity);
  await privateFile(destination);
  await syncFile(destination);
  await syncDirectory(value.directory);
  await syncDirectory(dirname(value.directory));
  let manifest;
  if (metadata.stateSchema === 5) {
    const artifacts = liveArtifactRows(value.stateRoot);
    const databaseBytes = (await lstat(destination)).size;
    await copyArtifacts(value.stateRoot, value.directory, artifacts, owned, value.signal, value.maxBytes, databaseBytes);
    manifest = { format: 2, id: value.snapshotId, createdAt: value.createdAt, mailboxIdentity: value.identity, stateSchema: 5,
      applicationVersion: value.applicationVersion, database: 'snapshot.sqlite', sha256: metadata.sha256,
      artifacts: artifacts.map(({ purpose, createdAt, handle }) => ({ purpose, createdAt, handle })) };
  } else {
    manifest = { format: 1, id: value.snapshotId, createdAt: value.createdAt, mailboxIdentity: value.identity, stateSchema: metadata.stateSchema,
      applicationVersion: value.applicationVersion, database: 'snapshot.sqlite', sha256: metadata.sha256 };
  }
  await publishManifest(value.directory, manifest, owned, value.signal);
  return { snapshotId: value.snapshotId, directory: value.directory, stateSchema: metadata.stateSchema, createdAt: value.createdAt };
}

export async function backupState(options, { workerRunner = runMaintenanceWorker, deadlineFactory = deadline } = {}) {
  let release, budget;
  const owned = { files: new Map() };
  try {
    const value = settings(options);
    budget = deadlineFactory(value.timeoutMs, value.signal);
    value.signal = budget.signal;
    owned.directory = value.directory;
    aborted(value.signal);
    await freshDestination(value.directory);
    aborted(value.signal);
    try { release = acquireStoppedLease(value.stateRoot); }
    catch (error) { fail(/owned or locked/.test(error.message) ? 'BACKUP_OWNED' : 'BACKUP_STATE_UNSAFE'); }
    const result = await exportSnapshot(value, owned, workerRunner);
    release(); release = null;
    return result;
  } catch (error) {
    await cleanup(owned);
    throw operationError(error, budget);
  } finally {
    if (release) {
      try { release(); } catch { /* The lease implementation closes its SQLite lock even on metadata failure. */ }
    }
  }
}

function validManifest(value, identity) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = value.format === 1 ? manifestKeysV1 : value.format === 2 ? manifestKeysV2 : [];
  if (!keys.length || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  return validManifestIdentity(value, identity) && validManifestFormat(value);
}

function validManifestIdentity(value, identity) {
  return typeof value.id === 'string' && uuidPattern.test(value.id) && time(value.createdAt) && value.mailboxIdentity === identity;
}

function validManifestFormat(value) {
  if (!Number.isInteger(value.stateSchema) || !version(value.applicationVersion) || value.database !== 'snapshot.sqlite' || !digest(value.sha256)) return false;
  if (value.format === 1) return value.stateSchema >= 0 && value.stateSchema <= 4;
  return value.format === 2 && value.stateSchema === 5 && validArtifactManifest(value.artifacts);
}

function validArtifactManifest(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length > maxArtifactRefs) return false;
  const ids = [];
  try { for (const item of artifacts) { if (!validArtifactEntry(item)) return false; ids.push(item.handle.id); } }
  catch { return false; }
  return ids.every((id, index) => index === 0 || ids[index - 1] < id);
}

function validArtifactEntry(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).length !== 3 || !['createdAt', 'handle', 'purpose'].every(key => Object.hasOwn(item, key))
    || !time(item.createdAt) || !['image-input', 'text-output'].includes(item.purpose)) return false;
  const handle = validateArtifactHandle(item.handle);
  return handle.expiresAt >= item.createdAt;
}

function checkedManifestArtifact(item) {
  try { return { purpose: item.purpose, createdAt: item.createdAt, handle: validateArtifactHandle(item.handle) }; }
  catch { fail('BACKUP_INVALID_STATE'); }
}

async function readManifest(directory, identity) {
  const filename = join(directory, 'manifest.json');
  await privateFile(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) fail('BACKUP_INVALID_STATE');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!validManifest(value, identity)) fail('BACKUP_INVALID_STATE');
    return value;
  } finally { await handle.close(); }
}

async function snapshotEntries(directory, manifest, signal, directoryOpener) {
  const handle = await directoryOpener(directory, { bufferSize: 1 });
  const names = [];
  try {
    for (let index = 0; index < 3; index++) {
      aborted(signal);
      const entry = await handle.read();
      aborted(signal);
      if (!entry) break;
      if (index === 3) fail('BACKUP_INVALID_STATE');
      names.push(entry.name);
    }
  } finally { await handle.close(); }
  names.sort();
  const expected = manifest.format === 1 ? ['manifest.json', 'snapshot.sqlite'] : ['artifacts', 'manifest.json', 'snapshot.sqlite'];
  if (!isDeepStrictEqual(names, expected)) fail('BACKUP_INVALID_STATE');
}

async function verifyArtifactTree(directory, artifacts, maxBytes, signal) {
  let total = (await lstat(join(directory, 'snapshot.sqlite'))).size;
  const expected = new Map();
  for (const item of artifacts) {
    const handle = item.handle;
    total += handle.size;
    if (total > maxBytes) fail('BACKUP_TOO_LARGE');
    if (!expected.has(handle.runId)) expected.set(handle.runId, []);
    expected.get(handle.runId).push(handle.id);
  }
  const root = join(directory, 'artifacts');
  await privateDirectory(root, 'BACKUP_STATE_UNSAFE');
  const runIds = [...expected.keys()].sort();
  if (!isDeepStrictEqual(await directoryNames(root, maxArtifactRefs), runIds)) fail('BACKUP_INVALID_STATE');
  for (const [runId, ids] of expected) await verifyArtifactRun(root, runId, ids, artifacts, signal);
}

async function verifyArtifactRun(root, runId, ids, artifacts, signal) {
  aborted(signal);
  const run = join(root, runId);
  await privateDirectory(run, 'BACKUP_STATE_UNSAFE');
  ids.sort();
  if (!isDeepStrictEqual(await directoryNames(run, maxArtifactRefs), ids)) fail('BACKUP_INVALID_STATE');
  for (const id of ids) await verifyArtifactDirectory(run, id, artifacts.find(item => item.handle.id === id)?.handle);
}

async function verifyArtifactDirectory(run, id, handle) {
  if (!handle) fail('BACKUP_INVALID_STATE');
  const path = join(run, id);
  await privateDirectory(path, 'BACKUP_STATE_UNSAFE');
  if (!isDeepStrictEqual(await directoryNames(path), ['bytes', 'manifest.json'])) fail('BACKUP_INVALID_STATE');
  const manifestBytes = await privateBytes(join(path, 'manifest.json'), 16_384);
  let fileHandle;
  try { fileHandle = validateArtifactHandle(JSON.parse(manifestBytes.toString('utf8'))); } catch { fail('BACKUP_INVALID_STATE'); }
  if (!isDeepStrictEqual(fileHandle, handle)) fail('BACKUP_INVALID_STATE');
  const bytes = await privateBytes(join(path, 'bytes'), handle.size);
  verifyArtifactBytes(handle, bytes);
}

function verifyArtifactBytes(handle, bytes) {
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

function verifyDatabaseArtifactParity(databasePath, artifacts) {
  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, timeout: 0 });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON;');
    if (!validStateSchema(db, 5)) fail('BACKUP_INVALID_STATE');
    const actual = artifactRowsFromDb(db);
    if (!isDeepStrictEqual(actual, artifacts)) fail('BACKUP_INVALID_STATE');
  } finally { db.close(); }
}

export async function inspectSnapshot({ directory, identity, maxBytes, timeoutMs, signal }, {
  workerRunner = runMaintenanceWorker, deadlineFactory = deadline, directoryOpener = opendir
} = {}) {
  let budget;
  try {
    directory = path(directory);
    if (!digest(identity)) fail('BACKUP_INVALID_INPUT');
    const limits = readLimits({ maxBytes, timeoutMs });
    validateSignal(signal);
    budget = deadlineFactory(limits.timeoutMs, signal);
    signal = budget.signal;
    aborted(signal);
    await privateDirectory(directory, 'BACKUP_STATE_UNSAFE');
    const manifest = await readManifest(directory, identity);
    await snapshotEntries(directory, manifest, signal, directoryOpener);
    const databasePath = join(directory, manifest.database);
    await guardDatabase(databasePath, limits.maxBytes);
    aborted(signal);
    const metadata = await workerRunner({ operation: 'validate', source: databasePath, identity, maxBytes: limits.maxBytes }, { timeoutMs: limits.timeoutMs, signal });
    aborted(signal);
    safeWorkerValue(metadata, identity);
    if (metadata.stateSchema !== manifest.stateSchema || !timingSafeEqual(Buffer.from(metadata.sha256), Buffer.from(manifest.sha256))) fail('BACKUP_INVALID_STATE');
    if (manifest.format === 2) {
      const artifacts = manifest.artifacts.map(checkedManifestArtifact);
      await verifyArtifactTree(directory, artifacts, limits.maxBytes, signal);
      verifyDatabaseArtifactParity(databasePath, artifacts);
    }
    return { manifest, databasePath };
  } catch (error) { throw operationError(error, budget); }
}
