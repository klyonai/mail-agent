import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { openStore, createStateSchema } from '../src/store.mjs';
import { validStateSchema } from '../src/state-schema.mjs';
import { backupState, inspectSnapshot } from '../src/backup.mjs';
import { runMaintenanceWorker } from '../src/maintenance-worker.mjs';

const identity = 'a'.repeat(64);
const snapshotId = '11111111-1111-4111-8111-111111111111';
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, version = 4) {
  const root = await mkdtemp(join(tmpdir(), 'ma-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  const store = openStore(stateRoot, { identity, clock: () => 20 });
  store.saveRun({ id: 'synthetic', messageKey: 'synthetic', conversationKey: 'synthetic', status: 'awaiting_approval', sequence: 1, createdAt: 10,
    budget: { modelCalls: 1, toolCalls: 0, activeMs: 10 }, mail: { body: 'SYNTHETIC_PRIVATE_BODY' }, approval: { id: 'approval-synthetic' } });
  store.close();
  const db = new DatabaseSync(join(stateRoot, 'agent.sqlite'));
  if (version === 0) db.exec("DELETE FROM meta WHERE key='schema_version'");
  else db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
  db.close();
  return { root, stateRoot, directory: join(root, 'snapshot'), identity, snapshotId, clock: () => 30 };
}

async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('stopped backup publishes a private standalone snapshot and a fixed safe manifest', async (t) => {
  const settings = await fixture(t);
  const before = await readFile(join(settings.stateRoot, 'agent.sqlite'));
  const result = await backupState(settings);
  assert.deepEqual(result, { snapshotId, directory: settings.directory, stateSchema: 4, createdAt: 30 });
  assert.deepEqual((await readdir(settings.directory)).sort(), ['manifest.json', 'snapshot.sqlite']);
  assert.equal((await lstat(settings.directory)).mode & 0o777, 0o700);
  for (const filename of ['manifest.json', 'snapshot.sqlite']) assert.equal((await lstat(join(settings.directory, filename))).mode & 0o777, 0o600);
  const snapshot = await readFile(join(settings.directory, 'snapshot.sqlite'));
  const manifest = JSON.parse(await readFile(join(settings.directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { format: 1, id: snapshotId, createdAt: 30, mailboxIdentity: identity, stateSchema: 4,
    applicationVersion: '0.1.0', database: 'snapshot.sqlite', sha256: sha256(snapshot) });
  assert.equal(JSON.stringify(manifest).includes('SYNTHETIC_PRIVATE_BODY'), false);
  const db = new DatabaseSync(join(settings.directory, 'snapshot.sqlite'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.match(db.prepare('SELECT data FROM runs').get().data, /SYNTHETIC_PRIVATE_BODY/);
  db.close();
  assert.deepEqual(await readFile(join(settings.stateRoot, 'agent.sqlite')), before);
  await absent(join(settings.stateRoot, 'owner.lock'));
});

test('backup refuses an active owner before touching source or target', async (t) => {
  const settings = await fixture(t);
  const store = openStore(settings.stateRoot, { identity });
  try {
    const before = await readFile(join(settings.stateRoot, 'agent.sqlite'));
    const lock = await readFile(join(settings.stateRoot, 'owner.lock'));
    let workerCalls = 0;
    await assert.rejects(backupState(settings, { workerRunner: async () => { workerCalls++; } }), { code: 'BACKUP_OWNED' });
    assert.equal(workerCalls, 0);
    assert.deepEqual(await readFile(join(settings.stateRoot, 'agent.sqlite')), before);
    assert.deepEqual(await readFile(join(settings.stateRoot, 'owner.lock')), lock);
    await absent(settings.directory);
  } finally { store.close(); }
});

test('backup preserves every supported source version without migration or mode changes', async (t) => {
  for (const version of [0, 1, 2, 3, 4]) {
    const settings = await fixture(t, version);
    const path = join(settings.stateRoot, 'agent.sqlite');
    const before = await readFile(path);
    const mode = (await lstat(path)).mode;
    assert.equal((await backupState(settings)).stateSchema, version);
    assert.deepEqual(await readFile(path), before);
    assert.equal((await lstat(path)).mode, mode);
  }
});

test('snapshot includes committed crash-left WAL data and excludes uncommitted work', async (t) => {
  const settings = await fixture(t);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_fixture(id INTEGER PRIMARY KEY); INSERT INTO wal_fixture VALUES(1); BEGIN; INSERT INTO wal_fixture VALUES(2);");
    process.exit(0);
  `, join(settings.stateRoot, 'agent.sqlite')], { env: {}, encoding: 'utf8' });
  assert.equal(child.status, 0);
  const before = await readFile(join(settings.stateRoot, 'agent.sqlite-wal'));
  assert.ok(before.length > 0);
  await backupState(settings);
  const db = new DatabaseSync(join(settings.directory, 'snapshot.sqlite'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT id FROM wal_fixture').all().map(row => row.id), [1]);
  db.close();
  assert.deepEqual(await readFile(join(settings.stateRoot, 'agent.sqlite-wal')), before);
});

test('unsafe identity, future schema, malformed state, and byte bounds fail safely and release ownership', async (t) => {
  for (const scenario of ['identity', 'future', 'malformed', 'bytes']) {
    const settings = await fixture(t);
    if (scenario === 'identity') settings.identity = 'b'.repeat(64);
    if (scenario === 'future') {
      const db = new DatabaseSync(join(settings.stateRoot, 'agent.sqlite'));
      db.exec("UPDATE meta SET value='6' WHERE key='schema_version'");
      db.close();
    }
    if (scenario === 'malformed') await writeFile(join(settings.stateRoot, 'agent.sqlite'), 'PRIVATE_CORRUPTION', { mode: 0o600 });
    if (scenario === 'bytes') settings.maxBytes = 1;
    await assert.rejects(backupState(settings), error => {
      assert.match(error.code, /^BACKUP_/);
      assert.doesNotMatch(error.message, /PRIVATE|sqlite|SELECT|agent\.sqlite/);
      return true;
    });
    await absent(settings.directory);
    await absent(join(settings.stateRoot, 'owner.lock'));
  }
});

test('source database and every sidecar reject symlinks, non-files, and permissive modes', async (t) => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const settings = await fixture(t);
    const path = join(settings.stateRoot, `agent.sqlite${suffix}`);
    await rm(path, { force: true });
    const victim = join(settings.root, 'victim');
    await writeFile(victim, 'FOREIGN', { mode: 0o600 });
    await symlink(victim, path);
    await assert.rejects(backupState(settings), { code: 'BACKUP_STATE_UNSAFE' });
    assert.equal(await readFile(victim, 'utf8'), 'FOREIGN');
    await absent(settings.directory);
  }
  for (const type of ['directory', 'permissive']) {
    const settings = await fixture(t);
    const path = join(settings.stateRoot, 'agent.sqlite-journal');
    if (type === 'directory') await mkdir(path, { mode: 0o700 });
    else { await writeFile(path, '', { mode: 0o600 }); await chmod(path, 0o644); }
    await assert.rejects(backupState(settings), { code: 'BACKUP_STATE_UNSAFE' });
    await absent(settings.directory);
  }
});

test('destination and input validation never overwrite or repair unsafe paths', async (t) => {
  const settings = await fixture(t);
  await mkdir(settings.directory, { mode: 0o700 });
  await writeFile(join(settings.directory, 'foreign'), 'FOREIGN');
  await assert.rejects(backupState(settings), { code: 'BACKUP_DESTINATION_EXISTS' });
  assert.equal(await readFile(join(settings.directory, 'foreign'), 'utf8'), 'FOREIGN');
  const unsafeParent = join(settings.root, 'unsafe-parent');
  await mkdir(unsafeParent, { mode: 0o755 });
  await chmod(unsafeParent, 0o755);
  await assert.rejects(backupState({ ...settings, directory: join(unsafeParent, 'snapshot') }), { code: 'BACKUP_DESTINATION_UNSAFE' });
  assert.equal((await lstat(unsafeParent)).mode & 0o777, 0o755);
  const alias = join(settings.root, 'parent-link');
  await symlink(settings.root, alias);
  await assert.rejects(backupState({ ...settings, directory: join(alias, 'new-snapshot') }), { code: 'BACKUP_DESTINATION_UNSAFE' });
  for (const extra of [{ identity: 'not-a-digest' }, { snapshotId: '../bad' }, { clock: () => -1 }, { maxBytes: 0 }, { timeoutMs: 0 }, { applicationVersion: 'PRIVATE\n' }, { directory: '\0' }]) {
    await assert.rejects(backupState({ ...settings, directory: join(settings.root, 'new'), ...extra }), { code: 'BACKUP_INVALID_INPUT' });
  }
});

function fakeChild(autoClose = true) {
  const child = new EventEmitter();
  child.sent = [];
  child.kills = [];
  child.send = (value, callback) => { child.sent.push(value); callback?.(); };
  child.kill = signal => { child.kills.push(signal); if (autoClose) Promise.resolve().then(() => child.emit('close', null, signal)); return true; };
  return child;
}

const request = { operation: 'validate', source: '/private/synthetic.sqlite', identity, maxBytes: 1_073_741_824 };

test('maintenance worker uses fixed Node executable, empty environment and ignored output; resolves after termination', async () => {
  const child = fakeChild();
  let spawnOptions;
  let settled = false;
  const promise = runMaintenanceWorker(request, { spawnImpl: (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.match(args[0], /backup-worker\.mjs$/);
    spawnOptions = options;
    return child;
  } }).then(value => { settled = true; return value; });
  assert.deepEqual(spawnOptions.env, {});
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  child.emit('message', { ok: true, value: { stateSchema: 4, mailboxIdentity: identity, sha256: 'b'.repeat(64) } });
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', 0, null);
  assert.equal((await promise).stateSchema, 4);
  assert.equal(child.listenerCount('message'), 0);
});

test('maintenance timeout and abort kill the worker and await termination without exposing private errors', async () => {
  for (const cause of ['timeout', 'abort', 'invalid']) {
    const child = fakeChild(false);
    const controller = new AbortController();
    let timer;
    let cleared = false;
    const promise = runMaintenanceWorker(request, { signal: controller.signal, spawnImpl: () => child,
      setTimer: callback => { timer = callback; return 1; }, clearTimer: () => { cleared = true; } });
    const rejected = assert.rejects(promise, error => {
      assert.equal(error.code, cause === 'timeout' ? 'MAINTENANCE_TIMEOUT' : cause === 'abort' ? 'MAINTENANCE_ABORTED' : 'MAINTENANCE_FAILED');
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    if (cause === 'timeout') timer();
    if (cause === 'abort') controller.abort(new Error('PRIVATE_ABORT'));
    if (cause === 'invalid') child.emit('message', { ok: true, value: { raw: 'PRIVATE_MAIL' } });
    assert.deepEqual(child.kills, ['SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    await rejected;
    assert.equal(cleared, true);
  }
});

test('aborted snapshot retains ownership until its child terminates, then cleans its private incomplete files', async (t) => {
  const settings = await fixture(t);
  const child = fakeChild(false);
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const promise = backupState({ ...settings, signal: controller.signal }, { workerRunner: (value, options) => runMaintenanceWorker(value, {
    ...options, spawnImpl: () => { started(); return child; }
  }) });
  const rejected = assert.rejects(promise, { code: 'BACKUP_ABORTED' });
  await ready;
  controller.abort();
  assert.throws(() => openStore(settings.stateRoot, { identity }), /owned or locked/);
  child.emit('close', null, 'SIGKILL');
  await rejected;
  await absent(settings.directory);
  const store = openStore(settings.stateRoot, { identity });
  store.close();
});

test('publication failure preserves unexpected files and never publishes a completion manifest', async (t) => {
  const settings = await fixture(t);
  const workerRunner = async value => {
    await copyFile(value.source, value.destination);
    await writeFile(join(settings.directory, 'manifest.json'), 'FOREIGN', { mode: 0o600 });
    return { stateSchema: 4, mailboxIdentity: identity, sha256: sha256(await readFile(value.destination)) };
  };
  await assert.rejects(backupState(settings, { workerRunner }), { code: 'BACKUP_FAILED' });
  assert.equal(await readFile(join(settings.directory, 'manifest.json'), 'utf8'), 'FOREIGN');
  await absent(join(settings.directory, 'snapshot.sqlite'));
  await absent(join(settings.stateRoot, 'owner.lock'));
});

test('snapshot inspection validates metadata and checksum without modifying the snapshot', async (t) => {
  const settings = await fixture(t);
  await backupState(settings);
  const source = join(settings.directory, 'snapshot.sqlite');
  const before = await readFile(source);
  const result = await inspectSnapshot(settings);
  assert.equal(result.databasePath, source);
  assert.equal(result.manifest.id, snapshotId);
  assert.equal(result.manifest.sha256, sha256(before));
  assert.deepEqual(await readFile(source), before);
  assert.deepEqual((await readdir(settings.directory)).sort(), ['manifest.json', 'snapshot.sqlite']);
});

test('snapshot inspection rejects unsafe manifests, substituted state, and incomplete artifacts', async (t) => {
  for (const scenario of ['hash', 'schema', 'filename', 'extra', 'oversized', 'identity', 'permissions', 'substitution', 'incomplete']) {
    const settings = await fixture(t);
    await backupState(settings);
    const filename = join(settings.directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(filename, 'utf8'));
    if (scenario === 'hash') manifest.sha256 = 'b'.repeat(64);
    if (scenario === 'schema') manifest.stateSchema = 3;
    if (scenario === 'filename') manifest.database = '../agent.sqlite';
    if (scenario === 'extra') manifest.private = 'PRIVATE_BODY';
    if (scenario === 'identity') manifest.mailboxIdentity = 'b'.repeat(64);
    await writeFile(filename, JSON.stringify(manifest));
    if (scenario === 'oversized') await writeFile(filename, 'PRIVATE'.repeat(3000));
    if (scenario === 'permissions') await chmod(filename, 0o644);
    if (scenario === 'substitution') {
      await unlinkSnapshot(settings.directory);
      await symlink(join(settings.stateRoot, 'agent.sqlite'), join(settings.directory, 'snapshot.sqlite'));
    }
    if (scenario === 'incomplete') await writeFile(join(settings.directory, '.manifest.pending'), 'PRIVATE', { mode: 0o600 });
    await assert.rejects(inspectSnapshot(settings), error => {
      assert.match(error.code, /^BACKUP_/);
      assert.doesNotMatch(error.message, /PRIVATE|SELECT|agent\.sqlite/);
      return true;
    });
  }
});

async function unlinkSnapshot(directory) { await rm(join(directory, 'snapshot.sqlite')); }

test('restore worker migrates without runtime recovery and retains the original reconciliation window', async (t) => {
  const settings = await fixture(t);
  const originalId = '22222222-2222-4222-8222-222222222222';
  const store = openStore(settings.stateRoot, { identity });
  store.setMeta('restore_hold', JSON.stringify({ snapshotId: originalId, snapshotCreatedAt: 5, restoredAt: 10 }));
  store.close();
  await backupState(settings);
  const staging = join(settings.root, 'restored');
  await mkdir(staging, { mode: 0o700 });
  const source = join(staging, 'agent.sqlite');
  await copyFile(join(settings.directory, 'snapshot.sqlite'), source);
  const result = await runMaintenanceWorker({ operation: 'restore', source, identity, maxBytes: 1_073_741_824,
    hold: { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 }, actorDigest: 'b'.repeat(64), reasonDigest: 'c'.repeat(64) });
  assert.equal(result.stateSchema, 5);
  const db = new DatabaseSync(source, { readOnly: true });
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='restore_hold'").get().value), {
    snapshotId: originalId, snapshotCreatedAt: 5, restoredAt: 40
  });
  assert.equal(db.prepare('SELECT status FROM runs').get().status, 'awaiting_approval');
  const audit = db.prepare("SELECT actor,target,details FROM audit WHERE event='restore-held'").get();
  assert.equal(audit.actor, 'b'.repeat(64));
  assert.equal(audit.target, snapshotId);
  assert.deepEqual(JSON.parse(audit.details), { reasonHash: 'c'.repeat(64) });
  db.close();
});

test('restore worker rejects malformed prior holds and raw attribution payloads', async (t) => {
  const settings = await fixture(t);
  const store = openStore(settings.stateRoot, { identity });
  store.setMeta('restore_hold', 'PRIVATE_MALFORMED');
  store.close();
  const value = { operation: 'restore', source: join(settings.stateRoot, 'agent.sqlite'), identity, maxBytes: 1_073_741_824,
    hold: { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 }, actorDigest: 'b'.repeat(64), reasonDigest: 'c'.repeat(64) };
  await assert.rejects(runMaintenanceWorker(value), { code: 'MAINTENANCE_INVALID_STATE' });
  await assert.rejects(runMaintenanceWorker({ ...value, actorDigest: 'operator@example.test' }), { code: 'MAINTENANCE_INVALID_INPUT' });
  const db = new DatabaseSync(value.source, { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='restore_hold'").get().value, 'PRIVATE_MALFORMED');
  assert.equal(db.prepare('SELECT count(*) AS count FROM audit').get().count, 0);
  db.close();
});

test('one original operation deadline covers filesystem phases and worker cancellation without refreshing the budget', async (t) => {
  const settings = await fixture(t);
  const timeout = new AbortController();
  const caller = new AbortController();
  let deadlineCalls = 0;
  const deadlineFactory = (timeoutMs, signal) => {
    deadlineCalls++;
    assert.equal(timeoutMs, 300_000);
    assert.equal(signal, caller.signal);
    return { timeout: timeout.signal, caller: signal, signal: AbortSignal.any([timeout.signal, signal]) };
  };
  const workerRunner = async (_value, options) => {
    assert.notEqual(options.signal, caller.signal);
    const reason = new Error('PRIVATE_TIMEOUT');
    reason.name = 'TimeoutError';
    timeout.abort(reason);
    throw Object.assign(new Error('PRIVATE_WORKER'), { code: 'MAINTENANCE_ABORTED' });
  };
  await assert.rejects(backupState({ ...settings, signal: caller.signal }, { workerRunner, deadlineFactory }), { code: 'BACKUP_TIMEOUT' });
  assert.equal(deadlineCalls, 1);
  await absent(settings.directory);
  await absent(join(settings.stateRoot, 'owner.lock'));
});

test('restore rejects additional or modified SQL schema before any hold or audit mutation', async (t) => {
  const mutations = [
    "CREATE TRIGGER malicious_hold AFTER INSERT ON meta WHEN NEW.key='restore_hold' BEGIN UPDATE meta SET value='' WHERE key='restore_hold'; END;",
    'CREATE VIEW extra_view AS SELECT * FROM meta;',
    'CREATE TABLE extra_table (value TEXT);',
    'ALTER TABLE meta ADD COLUMN unexpected TEXT;',
    "DROP TRIGGER actions_result_insert; CREATE TRIGGER actions_result_insert AFTER INSERT ON actions BEGIN DELETE FROM actions; END;"
  ];
  for (const mutation of mutations) {
    const settings = await fixture(t);
    const source = join(settings.stateRoot, 'agent.sqlite');
    const db = new DatabaseSync(source);
    db.exec(`PRAGMA journal_mode=DELETE; ${mutation}`);
    db.close();
    const before = await readFile(source);
    await assert.rejects(runMaintenanceWorker({ operation: 'restore', source, identity, maxBytes: 1_073_741_824,
      hold: { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 }, actorDigest: 'b'.repeat(64), reasonDigest: 'c'.repeat(64) }),
    { code: 'MAINTENANCE_INVALID_STATE' });
    assert.deepEqual(await readFile(source), before);
  }
});

test('restore worker publishes standalone DELETE state with a validated actual hold and no WAL sidecars', async (t) => {
  const settings = await fixture(t);
  const state = new DatabaseSync(join(settings.stateRoot, 'agent.sqlite'));
  state.exec("UPDATE meta SET value='5' WHERE key='schema_version'");
  state.close();
  await backupState(settings);
  const staging = join(settings.root, 'standalone-stage');
  await mkdir(staging, { mode: 0o700 });
  const source = join(staging, 'agent.sqlite');
  await copyFile(join(settings.directory, 'snapshot.sqlite'), source);
  await runMaintenanceWorker({ operation: 'restore', source, identity, maxBytes: 1_073_741_824,
    hold: { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 }, actorDigest: 'b'.repeat(64), reasonDigest: 'c'.repeat(64) });
  await absent(`${source}-wal`);
  await absent(`${source}-shm`);
  await absent(`${source}-journal`);
  const db = new DatabaseSync(source, { readOnly: true });
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='restore_hold'").get().value),
    { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 });
  db.close();
});

test('genuine schema versions zero through four restore with pending work, budgets, approvals and fences intact', async (t) => {
  for (const version of [0, 1, 2, 3, 4]) {
    const settings = await fixture(t);
    const staging = join(settings.root, `genuine-v${version}`);
    await mkdir(staging, { mode: 0o700 });
    const source = join(staging, 'agent.sqlite');
    const db = new DatabaseSync(source);
    createStateSchema(db, version);
    db.prepare('INSERT INTO meta VALUES (?,?)').run('identity', identity);
    if (version) db.prepare('INSERT INTO meta VALUES (?,?)').run('schema_version', String(version));
    const run = { id: 'genuine', messageKey: 'genuine-message', conversationKey: 'genuine-conversation', status: 'awaiting_approval',
      sequence: 1, createdAt: 10, budget: { modelCalls: 2, toolCalls: 1, activeMs: 35 }, approval: { id: 'approval-genuine' }, grants: ['grant-genuine'] };
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?)').run(run.id, run.messageKey, run.conversationKey, run.status, 20, JSON.stringify(run));
    const action = { key: 'genuine-action', runId: run.id, state: 'uncertain', effect: 'write' };
    db.prepare('INSERT INTO actions VALUES (?,?,?,?)').run(action.key, action.runId, action.state, JSON.stringify(action));
    assert.equal(validStateSchema(db, version), true);
    db.close();
    await chmod(source, 0o600);
    const result = await runMaintenanceWorker({ operation: 'restore', source, identity, maxBytes: 1_073_741_824,
      hold: { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 }, actorDigest: 'b'.repeat(64), reasonDigest: 'c'.repeat(64) });
    assert.equal(result.stateSchema, 5);
    const restored = new DatabaseSync(source, { readOnly: true });
    assert.equal(validStateSchema(restored, 5), true);
    assert.deepEqual(JSON.parse(restored.prepare('SELECT data FROM runs').get().data), run);
    assert.deepEqual(JSON.parse(restored.prepare('SELECT data FROM actions').get().data), action);
    assert.equal(restored.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5');
    restored.close();
  }
});

test('canonical SQL comparison ignores formatting but preserves quoted literals and bounds oversized objects', () => {
  const db = new DatabaseSync(':memory:');
  try {
    createStateSchema(db, 0);
    db.exec('DROP TABLE meta; CREATE TABLE meta( key TEXT PRIMARY KEY,value TEXT NOT NULL );');
    assert.equal(validStateSchema(db, 0), true);
    db.exec(`CREATE TABLE "${'x'.repeat(1000)}"(value TEXT);`);
    assert.equal(validStateSchema(db, 0), false);
  } finally { db.close(); }
  const current = new DatabaseSync(':memory:');
  try {
    createStateSchema(current, 4);
    const sql = current.prepare("SELECT sql FROM sqlite_schema WHERE name='actions_uncertainty_insert'").get().sql;
    current.exec(`DROP TRIGGER actions_uncertainty_insert; ${sql.replace("'uncertain'", "'uncertain '")}`);
    assert.equal(validStateSchema(current, 4), false);
    current.exec(`DROP TRIGGER actions_uncertainty_insert; ${sql.replace("'uncertain'", `'${'x'.repeat(65_536)}'`)}`);
    assert.equal(validStateSchema(current, 4), false);
  } finally { current.close(); }
});

test('snapshot directory inspection stops at the third entry and closes its bounded reader', async t => {
  const settings = await fixture(t);
  await backupState(settings);
  let reads = 0, closes = 0, workers = 0;
  const directoryOpener = async (path, options) => {
    assert.equal(path, settings.directory);
    assert.deepEqual(options, { bufferSize: 1 });
    return { read: async () => ({ name: ['manifest.json', 'snapshot.sqlite', 'unexpected'][reads++] ?? 'unbounded' }),
      close: async () => { closes++; } };
  };
  await assert.rejects(inspectSnapshot({ directory: settings.directory, identity }, { directoryOpener,
    workerRunner: async () => { workers++; } }), { code: 'BACKUP_INVALID_STATE' });
  assert.equal(reads, 3);
  assert.equal(closes, 1);
  assert.equal(workers, 0);
});

test('directory enumeration observes the original deadline and closes its reader before failing', async t => {
  const settings = await fixture(t);
  await backupState(settings);
  const timeout = new AbortController();
  let reads = 0, closes = 0;
  const directoryOpener = async () => ({ read: async () => { reads++; timeout.abort(); return { name: 'manifest.json' }; },
    close: async () => { closes++; } });
  await assert.rejects(inspectSnapshot({ directory: settings.directory, identity }, { directoryOpener,
    deadlineFactory: () => ({ timeout: timeout.signal, signal: timeout.signal }) }), { code: 'BACKUP_TIMEOUT' });
  assert.equal(reads, 1);
  assert.equal(closes, 1);
});
