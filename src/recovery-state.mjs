import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openStore } from './store.mjs';
import { recoveryState } from './recovery-hold.mjs';
import { validStateSchema } from './state-schema.mjs';
import { restoreReservationPath } from './state-paths.mjs';
import { digest } from './policy.mjs';

export const RECOVERY_STATE_ERROR_CODE = 'RECOVERY_STATE_UNSAFE';
const marker = '.restore-incomplete';

export function fixedRecoveryStateError() {
  const error = new Error('Recovery state is unavailable or unsafe.');
  error.code = RECOVERY_STATE_ERROR_CODE;
  return error;
}

function fail() { throw fixedRecoveryStateError(); }

function validateRequest({ stateRoot, identity, clock, allowReleased = false }, callback) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot.length > 4096 || stateRoot.includes('\0')
    || typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity) || typeof clock !== 'function' || typeof callback !== 'function'
    || typeof allowReleased !== 'boolean') fail();
  return { stateRoot: resolve(stateRoot), identity, clock, allowReleased };
}

function privateStat(stat, directory) {
  return (directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink() && !(stat.mode & 0o077)
    && (!process.getuid || stat.uid === process.getuid());
}

function assertPrivateSidecars(databasePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    let stat;
    try { stat = lstatSync(`${databasePath}${suffix}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!privateStat(stat, false) || stat.nlink !== 1) fail();
  }
}

function absentMarker(path) {
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fail();
}

function preflight(stateRoot, identity, allowReleased) {
  const rootStat = lstatSync(stateRoot);
  const databasePath = join(stateRoot, 'agent.sqlite');
  const databaseStat = lstatSync(databasePath);
  if (!privateStat(rootStat, true) || !privateStat(databaseStat, false) || databaseStat.nlink !== 1) fail();
  absentMarker(join(stateRoot, marker));
  absentMarker(restoreReservationPath(stateRoot));
  assertPrivateSidecars(databasePath);

  const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, timeout: 0 });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; PRAGMA cell_size_check=ON;');
    return readRecoveryDescriptor(db, identity, allowReleased);
  } finally { db.close(); }
}

function readRecoveryDescriptor(db, identity, allowReleased) {
  const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (version !== '5' || !validStateSchema(db, Number(version))) fail();
  if (db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value !== identity) fail();
  const rawHold = boundedText(db, 'restore_hold', 1024, { optional: allowReleased });
  const rawCursor = boundedText(db, 'cursor', 65536, { optional: true });
  const recovery = recoveryState({ getMeta: key => key === 'restore_hold' ? rawHold ?? undefined : undefined });
  if (!(allowReleased && rawHold === null) && (!rawHold || !recovery?.required || recovery.reason !== 'restore-reconciliation')) fail();
  return { rawHold, rawCursor, recovery, binding: digest([identity, rawHold, rawCursor]), cursorDigest: digest(rawCursor), stateSchema: 5 };
}

function boundedText(db, key, limit, { optional = false } = {}) {
  const row = db.prepare(`SELECT CASE WHEN typeof(value)='text' AND length(value)<=? THEN value END AS value FROM meta WHERE key=?`).get(limit, key);
  if (!row && optional) return null;
  if (typeof row?.value !== 'string') fail();
  return row.value;
}

function validateOpenedStore(store, identity, descriptor) {
  if (store.getMeta('schema_version') !== '5' || store.getMeta('identity') !== identity
    || (store.getMeta('restore_hold') ?? null) !== descriptor.rawHold || (store.getMeta('cursor') ?? null) !== descriptor.rawCursor) fail();
  const recovery = recoveryState(store);
  if (descriptor.recovery === null) { if (recovery !== null) fail(); return; }
  validateOpenedHold(recovery,descriptor);
}

function validateOpenedHold(recovery,descriptor) {
  if (!recovery?.required || recovery.reason !== 'restore-reconciliation'
    || recovery.snapshotId !== descriptor.recovery.snapshotId || recovery.snapshotCreatedAt !== descriptor.recovery.snapshotCreatedAt
    || recovery.restoredAt !== descriptor.recovery.restoredAt) fail();
}

/** Run a callback while this process owns a valid held state root. */
export async function withRecoveryStore(request, callback, { openStoreImpl = openStore } = {}) {
  let store, result, failed = false;
  try {
    const value = validateRequest({ clock: Date.now, ...request }, callback);
    const descriptor = preflight(value.stateRoot, value.identity, value.allowReleased);
    store = openStoreImpl(value.stateRoot, { identity: value.identity, clock: value.clock });
    validateOpenedStore(store, value.identity, descriptor);
    result = await callback(store, { ...descriptor });
  } catch {
    failed = true;
  }
  try { store?.close?.(); } catch { failed = true; }
  if (failed) throw fixedRecoveryStateError();
  return result;
}
