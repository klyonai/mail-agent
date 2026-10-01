import { DatabaseSync } from 'node:sqlite';
import { lstatSync, openSync, closeSync, fsyncSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute } from 'node:path';
import { openStore } from './store.mjs';
import { recoveryState } from './recovery-hold.mjs';
import { validStateSchema } from './state-schema.mjs';

class WorkerFailure extends Error {
  constructor(code) { super('State maintenance failed.'); this.code = code; }
}

function privateFile(path, { optional = false } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw new WorkerFailure('STATE_UNSAFE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw new WorkerFailure('STATE_UNSAFE');
  }
  return stat;
}

function privateParent(path) {
  const stat = lstatSync(dirname(path));
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new WorkerFailure('STATE_UNSAFE');
}

function inputFiles(path, maxBytes) {
  privateParent(path);
  const file = privateFile(path);
  const wal = privateFile(`${path}-wal`, { optional: true });
  privateFile(`${path}-shm`, { optional: true });
  privateFile(`${path}-journal`, { optional: true });
  if (file.size + (wal?.size ?? 0) > maxBytes) throw new WorkerFailure('TOO_LARGE');
}

function openReadonly(path) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 0 });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON;');
  return db;
}

function stateMetadata(db, identity) {
  if (db.prepare("SELECT type FROM sqlite_schema WHERE name='meta'").get()?.type !== 'table') throw new WorkerFailure('INVALID_STATE');
  const rows = db.prepare("SELECT key,value FROM meta WHERE key IN ('identity','schema_version') AND typeof(value)='text' AND length(value)<=64").all();
  const metadata = Object.fromEntries(rows.map(row => [row.key, row.value]));
  if (metadata.identity !== identity) throw new WorkerFailure('IDENTITY_MISMATCH');
  const rawVersion = metadata.schema_version;
  const schemaPresent = db.prepare("SELECT 1 FROM meta WHERE key='schema_version' LIMIT 1").get();
  if (schemaPresent && !/^[0-5]$/.test(rawVersion)) throw new WorkerFailure('UNSUPPORTED_SCHEMA');
  return { stateSchema: rawVersion === undefined ? 0 : Number(rawVersion), mailboxIdentity: identity };
}

function checkIntegrity(db) {
  const results = db.prepare('PRAGMA integrity_check').all();
  if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new WorkerFailure('INVALID_STATE');
}

function inspectState(path, identity, { standalone = false, canonical = false, hold } = {}) {
  const db = openReadonly(path);
  try {
    checkIntegrity(db);
    if (standalone && db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw new WorkerFailure('INVALID_STATE');
    const metadata = stateMetadata(db, identity);
    if (canonical && !validStateSchema(db, metadata.stateSchema)) throw new WorkerFailure('INVALID_STATE');
    if (hold) verifyHold(db, hold);
    return metadata;
  } finally { db.close(); }
}

async function checksum(path, maxBytes) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new WorkerFailure('TOO_LARGE');
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function snapshot(request) {
  privateParent(request.destination);
  if (privateFile(request.destination).size !== 0) throw new WorkerFailure('STATE_UNSAFE');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (privateFile(`${request.destination}${suffix}`, { optional: true })) throw new WorkerFailure('STATE_UNSAFE');
  }
  const source = openReadonly(request.source);
  try {
    checkIntegrity(source);
    stateMetadata(source, request.identity);
    source.prepare('VACUUM main INTO ?').run(request.destination);
  } finally { source.close(); }
  const fd = openSync(request.destination, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return request.destination;
}

function validateRequest(request) {
  if (!['snapshot', 'validate', 'restore'].includes(request?.operation)) throw new WorkerFailure('FAILED');
  if (!safePath(request.source)) throw new WorkerFailure('FAILED');
  if (typeof request.identity !== 'string' || !/^[a-f0-9]{64}$/.test(request.identity)) throw new WorkerFailure('FAILED');
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 17_179_869_184) throw new WorkerFailure('FAILED');
  if (request.operation === 'snapshot' && !safePath(request.destination)) throw new WorkerFailure('FAILED');
  if (request.operation === 'restore') validateRestoreFields(request);
}

function safePath(value) { return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !value.includes('\0'); }

function validateRestoreFields(request) {
  if (basename(request.source) !== 'agent.sqlite') throw new WorkerFailure('FAILED');
  const hold = request.hold;
  if (!hold || Object.keys(hold).sort().join(',') !== 'restoredAt,snapshotCreatedAt,snapshotId') throw new WorkerFailure('FAILED');
  if (typeof hold.snapshotId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(hold.snapshotId)) throw new WorkerFailure('FAILED');
  if (![hold.snapshotCreatedAt, hold.restoredAt].every(value => Number.isSafeInteger(value) && value >= 0)) throw new WorkerFailure('FAILED');
  if (![request.actorDigest, request.reasonDigest].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new WorkerFailure('FAILED');
}

function restore(request) {
  inspectState(request.source, request.identity, { standalone: true, canonical: true });
  const store = openStore(dirname(request.source), { identity: request.identity, clock: () => request.hold.restoredAt });
  let hold;
  try {
    hold = restoredHold(store, request.hold);
    store.transaction(() => {
      store.setMeta('restore_hold', JSON.stringify(hold));
      store.audit('restore-held', undefined, { actor: request.actorDigest, target: request.hold.snapshotId, reasonHash: request.reasonDigest });
    });
  } finally { store.close(); }
  consolidate(request.source);
  inspectState(request.source, request.identity, { standalone: true, canonical: true, hold });
  return request.source;
}

function verifyHold(db, expectedHold) {
  const row = db.prepare("SELECT CASE WHEN length(value)<=1024 THEN value ELSE '' END AS value FROM meta WHERE key='restore_hold'").get();
  const state = recoveryState({ getMeta: () => row?.value });
  if (!state || state.reason !== 'restore-reconciliation' || state.snapshotId !== expectedHold.snapshotId
    || state.snapshotCreatedAt !== expectedHold.snapshotCreatedAt || state.restoredAt !== expectedHold.restoredAt) {
    throw new WorkerFailure('INVALID_STATE');
  }
}

function consolidate(path) {
  const db = new DatabaseSync(path, { allowExtension: false, timeout: 0 });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');
    if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy !== 0) throw new WorkerFailure('INVALID_STATE');
    if (db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode !== 'delete') throw new WorkerFailure('INVALID_STATE');
  } finally { db.close(); }
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function restoredHold(store, incoming) {
  if (store.getMeta('restore_hold') === undefined) return incoming;
  const prior = recoveryState(store);
  if (!prior || prior.reason === 'invalid-record') throw new WorkerFailure('INVALID_STATE');
  return { snapshotId: prior.snapshotId, snapshotCreatedAt: prior.snapshotCreatedAt, restoredAt: incoming.restoredAt };
}

async function execute(request) {
  validateRequest(request);
  inputFiles(request.source, request.maxBytes);
  const path = operationPath(request);
  inputFiles(path, request.maxBytes);
  const metadata = inspectState(path, request.identity, { standalone: true, canonical: request.operation === 'restore' });
  return { ...metadata, sha256: await checksum(path, request.maxBytes) };
}

function operationPath(request) {
  if (request.operation === 'snapshot') return snapshot(request);
  if (request.operation === 'restore') return restore(request);
  return request.source;
}

function respond(message, status) {
  process.send(message, () => { process.disconnect(); process.exit(status); });
}

if (!process.send) process.exit(1);
process.once('message', request => {
  void execute(request).then(value => respond({ ok: true, value }, 0)).catch(error => {
    respond({ ok: false, code: error instanceof WorkerFailure ? error.code : 'INVALID_STATE' }, 1);
  });
});
