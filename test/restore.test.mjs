import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat, link, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '../src/store.mjs';
import { backupState } from '../src/backup.mjs';
import { restoreState } from '../src/restore.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { mailboxIdentity } from '../src/state-identity.mjs';

const runtimeConfig = { id: 'synthetic', state_root: 'restored-state', mailbox: { tenant_id: 'tenant', client_id: 'client', address: 'box@example.test', poll_seconds: 30 },
  model: {}, mcp: [], policy: { tools: {} }, retention: { content_hours: 24, audit_days: 30 } };
const identity = mailboxIdentity(runtimeConfig);
const snapshotId = '11111111-1111-4111-8111-111111111111';
const actor = 'operator@example.test';
const reason = 'Recover state after a synthetic outage drill.';
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ma-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'source-state');
  const store = openStore(stateRoot, { identity, clock: () => 20 });
  store.saveRun({ id: 'run-synthetic', messageKey: 'message-synthetic', conversationKey: 'conversation-synthetic', status: 'awaiting_approval', sequence: 1, createdAt: 10,
    budget: { modelCalls: 1, toolCalls: 0, activeMs: 10 }, mail: { body: 'SYNTHETIC_PRIVATE_BODY' }, approval: { id: 'approval-synthetic' } });
  store.saveRun({ id: 'queued-synthetic', messageKey: 'queued-message', conversationKey: 'queued-conversation', status: 'queued', sequence: 2, createdAt: 11,
    budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, mail: { body: 'QUEUED_PRIVATE_BODY' } });
  store.saveRun({ id: 'uncertain-synthetic', messageKey: 'uncertain-message', conversationKey: 'uncertain-conversation', status: 'uncertain', sequence: 3, createdAt: 12,
    budget: { modelCalls: 1, toolCalls: 0, activeMs: 10 }, mail: { body: 'UNCERTAIN_PRIVATE_BODY' }, uncertainty: { kind: 'send' } });
  store.saveAction({ key: 'uncertain-action', runId: 'uncertain-synthetic', state: 'uncertain', effect: 'write' });
  store.setMeta('cursor', 'cursor-synthetic');
  store.close();
  const snapshot = join(root, 'snapshot');
  await backupState({ stateRoot, directory: snapshot, identity, snapshotId, clock: () => 30 });
  return { root, stateRoot, snapshot, target: join(root, 'restored-state') };
}

async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('restore imports a validated snapshot into a fresh held state and preserves the source', async t => {
  const value = await fixture(t);
  const sourceBytes = await readFile(join(value.snapshot, 'snapshot.sqlite'));
  const manifestBytes = await readFile(join(value.snapshot, 'manifest.json'));
  const restored = await restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, clock: () => 40 });
  assert.deepEqual(restored, { snapshotId, stateRoot: await realpath(value.target), stateSchema: 5, recoveryRequired: true });
  assert.equal((await lstat(value.target)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(value.target, 'agent.sqlite'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(value.target)).sort(), ['agent.sqlite', 'artifacts', 'owner.sqlite']);
  assert.equal((await lstat(join(value.target, 'artifacts'))).mode & 0o777, 0o700);
  const db = new DatabaseSync(join(value.target, 'agent.sqlite'), { readOnly: true });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5');
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='restore_hold'").get().value),
    { snapshotId, snapshotCreatedAt: 30, restoredAt: 40 });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='cursor'").get().value, 'cursor-synthetic');
  assert.match(db.prepare('SELECT data FROM runs WHERE id=?').get('run-synthetic').data, /SYNTHETIC_PRIVATE_BODY/);
  assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get('queued-synthetic').status, 'queued');
  assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get('uncertain-synthetic').status, 'uncertain');
  assert.equal(JSON.parse(db.prepare('SELECT data FROM actions WHERE key=?').get('uncertain-action').data).state, 'uncertain');
  const audit = db.prepare("SELECT event,actor,details FROM audit WHERE event='restore-held'").get();
  assert.equal(audit.event, 'restore-held');
  assert.equal(audit.actor, sha256(actor));
  assert.equal(db.prepare("SELECT target FROM audit WHERE event='restore-held'").get().target, snapshotId);
  assert.deepEqual(JSON.parse(audit.details), { reasonHash: sha256(reason) });
  db.close();
  assert.deepEqual(await readFile(join(value.snapshot, 'snapshot.sqlite')), sourceBytes);
  assert.deepEqual(await readFile(join(value.snapshot, 'manifest.json')), manifestBytes);
  await absent(join(value.target, 'owner.lock'));
  await absent(join(value.target, '.restore-incomplete'));
});

test('restoring a held snapshot retains its earliest reconciliation boundary', async t => {
  const value = await fixture(t);
  await restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, clock: () => 40 });
  const secondSnapshot = join(value.root, 'snapshot-again');
  await backupState({ stateRoot: value.target, directory: secondSnapshot, identity, clock: () => 50 });
  const secondTarget = join(value.root, 'restored-again');
  await restoreState({ snapshot: secondSnapshot, stateRoot: secondTarget, identity, actor, reason, clock: () => 60 });
  const db = new DatabaseSync(join(secondTarget, 'agent.sqlite'), { readOnly: true });
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='restore_hold'").get().value),
    { snapshotId, snapshotCreatedAt: 30, restoredAt: 60 });
  db.close();
});

test('restore rejects identity mismatch and leaves no state target', async t => {
  const value = await fixture(t);
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity: 'b'.repeat(64), actor, reason }), { code: 'BACKUP_INVALID_STATE' });
  await absent(value.target);
});

test('restore refuses an existing target without changing it', async t => {
  const value = await fixture(t);
  const existing = join(value.root, 'existing');
  const store = openStore(existing, { identity });
  store.close();
  const before = await readFile(join(existing, 'agent.sqlite'));
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: existing, identity, actor, reason }), { code: 'BACKUP_DESTINATION_EXISTS' });
  assert.deepEqual(await readFile(join(existing, 'agent.sqlite')), before);
});

test('restore allows an owner-controlled read-only group parent and rejects writable group parents', async t => {
  const shared = await fixture(t);
  await chmod(shared.root, 0o750);
  const result = await restoreState({ snapshot: shared.snapshot, stateRoot: shared.target, identity, actor, reason });
  assert.equal((await lstat(result.stateRoot)).mode & 0o777, 0o700);
  const writable = await fixture(t);
  await chmod(writable.root, 0o770);
  await assert.rejects(restoreState({ snapshot: writable.snapshot, stateRoot: writable.target, identity, actor, reason }), { code: 'BACKUP_DESTINATION_UNSAFE' });
  await absent(writable.target);
});

test('restore rejects malformed or modified snapshots before target publication', async t => {
  const value = await fixture(t);
  await chmod(join(value.snapshot, 'manifest.json'), 0o600);
  const manifest = JSON.parse(await readFile(join(value.snapshot, 'manifest.json'), 'utf8'));
  manifest.sha256 = '0'.repeat(64);
  await writeFile(join(value.snapshot, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason }), { code: 'BACKUP_INVALID_STATE' });
  await absent(value.target);
});

test('restore rejects future schemas and snapshots with non-private modes', async t => {
  const value = await fixture(t);
  const manifestPath = join(value.snapshot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.stateSchema = 6;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason }), { code: 'BACKUP_INVALID_STATE' });
  await absent(value.target);
  await chmod(manifestPath, 0o600);
  await chmod(value.snapshot, 0o755);
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason }), { code: 'BACKUP_STATE_UNSAFE' });
  await absent(value.target);
});

test('restore rejects symlinked snapshot and target paths', async t => {
  const value = await fixture(t);
  const snapshotLink = join(value.root, 'snapshot-link');
  await symlink(value.snapshot, snapshotLink);
  await assert.rejects(restoreState({ snapshot: snapshotLink, stateRoot: value.target, identity, actor, reason }), { code: 'BACKUP_STATE_UNSAFE' });
  await absent(value.target);
  const targetLink = join(value.root, 'target-link');
  await symlink(join(value.root, 'nonexistent'), targetLink);
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: targetLink, identity, actor, reason }), { code: 'BACKUP_DESTINATION_EXISTS' });
});

test('restore validates actor and reason before creating any state', async t => {
  const value = await fixture(t);
  for (const input of [{ actor: 'not-an-email' }, { reason: ' ' }, { reason: 'r'.repeat(2049) }]) {
    await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, ...input }), { code: 'BACKUP_INVALID_INPUT' });
    await absent(value.target);
  }
});

test('restore cancellation leaves no target and never publishes after abort', async t => {
  const value = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, signal: controller.signal }, {
    workerRunner: async () => { controller.abort(); throw Object.assign(new Error('cancelled'), { code: 'MAINTENANCE_ABORTED' }); }
  }));
  await absent(value.target);
});

test('restore timeout leaves no target when a worker does not finish', async t => {
  const value = await fixture(t);
  const workerRunner = async (_request, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(Object.assign(new Error('cancelled'), { code: 'MAINTENANCE_ABORTED' }));
    else signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'MAINTENANCE_ABORTED' })), { once: true });
  });
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, timeoutMs: 20 }, { workerRunner }));
  await absent(value.target);
  await absent(join(value.root, '.restored-state.restore-incomplete'));
});

test('restore cleans only its reserved paths when final database publication fails', async t => {
  const value = await fixture(t);
  const reservation = join(value.root, '.restored-state.restore-incomplete');
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason }, {
    linkImpl: async () => { throw Object.assign(new Error('synthetic publication failure'), { code: 'EIO' }); }
  }), { code: 'BACKUP_FAILED' });
  await absent(value.target);
  await absent(reservation);
});

test('cancellation after the database link rolls back the owned unpublished target', async t => {
  const value = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason, signal: controller.signal }, {
    linkImpl: async (source, target) => { await link(source, target); controller.abort(); }
  }), { code: 'BACKUP_ABORTED' });
  await absent(value.target);
  await absent(join(value.root, '.restored-state.restore-incomplete'));
});

test('restored runtime remains held before any mailbox or tool work', async t => {
  const value = await fixture(t);
  const source = openStore(value.stateRoot, { identity, clock: () => 35 });
  const queued = source.getRun('queued-synthetic');
  queued.status = 'completed';
  source.saveRun(queued);
  source.saveRun({ id: 'post-snapshot-synthetic', messageKey: 'post-snapshot-message', conversationKey: 'post-snapshot-conversation', status: 'completed', sequence: 4, createdAt: 35,
    budget: { modelCalls: 1, toolCalls: 0, activeMs: 5 }, mail: { body: 'POST_SNAPSHOT_PRIVATE_BODY' } });
  source.audit('send-accepted', queued, { target: 'synthetic-recipient' });
  source.setMeta('cursor', 'cursor-after-send');
  source.close();
  await restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity, actor, reason });
  const effects = { mail: 0, model: 0, mcp: 0 };
  const runtime = await createRuntime({ root: value.root, mode: 'operator', config: runtimeConfig,
    clock: () => 40,
    mail: { check: async () => { effects.mail++; }, poll: async () => { effects.mail++; }, send: async () => { effects.mail++; } },
    model: { step: async () => { effects.model++; } }, mcp: { listTools: async () => { effects.mcp++; }, call: async () => { effects.mcp++; } } });
  try {
    await assert.rejects(runtime.processMessage({ id: 'new-message', conversationId: 'conversation', sender: 'sender@example.test', to: [], body: 'synthetic', subject: '' }),
      /Restored state requires provider reconciliation/);
    await assert.rejects(runtime.start({ once: true }), /Restored state requires provider reconciliation/);
    const restored = new DatabaseSync(join(value.target, 'agent.sqlite'), { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT status FROM runs WHERE id=?').get('queued-synthetic').status, 'queued');
      assert.equal(restored.prepare('SELECT id FROM runs WHERE id=?').get('post-snapshot-synthetic'), undefined);
      assert.equal(restored.prepare("SELECT value FROM meta WHERE key='cursor'").get().value, 'cursor-synthetic');
    } finally { restored.close(); }
    assert.deepEqual(effects, { mail: 0, model: 0, mcp: 0 });
  } finally { await runtime.stop(); }
});
