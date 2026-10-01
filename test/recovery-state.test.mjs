import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, symlink, writeFile, readFile, chmod, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { withRecoveryStore, RECOVERY_STATE_ERROR_CODE } from '../src/recovery-state.mjs';

const identity = 'a'.repeat(64);
const hold = JSON.stringify({ snapshotId: '00000000-0000-4000-8000-000000000001', snapshotCreatedAt: 1_700_000_000_000, restoredAt: 1_700_000_100_000 });

async function setup(t, identityValue = identity) {
  const root = await mkdtemp(join(tmpdir(), 'ma-recovery-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openStore(root, { identity: identityValue });
  store.setMeta('restore_hold', hold);
  store.setMeta('cursor', JSON.stringify({ initialComplete: true, delta: 'synthetic-cursor' }));
  store.saveRun({ id: 'synthetic-run', messageKey: 'b'.repeat(64), conversationKey: 'c'.repeat(64), sequence: 1,
    status: 'uncertain', createdAt: 1_700_000_100_001, budget: { modelCalls: 1, toolCalls: 0, activeMs: 2 },
    uncertainty: { kind: 'send' } });
  store.close();
  return root;
}

function stateRows(root) {
  const db = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true });
  try {
    return {
      meta: db.prepare('SELECT key,value FROM meta ORDER BY key').all(),
      runs: db.prepare('SELECT id,message_key,conversation_key,status,updated_at,data FROM runs ORDER BY id').all(),
      actions: db.prepare('SELECT key,run_id,state,data FROM actions ORDER BY key').all(),
      audit: db.prepare('SELECT at,event,run_id,actor,target,details FROM audit ORDER BY seq').all()
    };
  } finally { db.close(); }
}

test('holds sole state ownership through awaited inspection callback and returns safe binding metadata', async t => {
  const root = await setup(t);
  let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  let resume;
  const blocked = new Promise(resolve => { resume = resolve; });
  const work = withRecoveryStore({ stateRoot: root, identity, clock: () => 1_800_000_000_000 }, async (store, descriptor) => {
    entered();
    await blocked;
    assert.equal(store.getRun('synthetic-run').status, 'uncertain');
    assert.equal(descriptor.recovery.snapshotId, '00000000-0000-4000-8000-000000000001');
    assert.equal(descriptor.stateSchema, 5);
    assert.equal(typeof descriptor.binding, 'string');
    assert.equal(typeof descriptor.cursorDigest, 'string');
    assert.equal(descriptor.rawCursor.includes('synthetic-cursor'), true);
  });
  await inside;
  assert.throws(() => openStore(root, { identity }), /owned or locked/);
  resume();
  await work;
  const reopened = openStore(root, { identity });
  reopened.close();
});

test('callback failure is sanitized and releases ownership after awaiting', async t => {
  const root = await setup(t);
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {
    await Promise.resolve();
    throw new Error('PRIVATE_RAW_ERROR');
  }), error => error.code === RECOVERY_STATE_ERROR_CODE && error.message === 'Recovery state is unavailable or unsafe.'
    && !error.message.includes('PRIVATE_RAW_ERROR'));
  const reopened = openStore(root, { identity });
  reopened.close();
});

test('absent roots, wrong identity, unsafe roots and missing or malformed holds fail closed without initialization', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'ma-recovery-state-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const absent = join(parent, 'absent');
  await assert.rejects(withRecoveryStore({ stateRoot: absent, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });

  const root = await setup(t);
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity: 'd'.repeat(64) }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
  const store = openStore(root, { identity });
  store.setMeta('restore_hold', '');
  store.close();
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
  await assert.rejects(readFile(join(absent, 'agent.sqlite')));
});

test('canonical schema is checked before opening a database with an altered trigger', async t => {
  const root = await setup(t);
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("DROP TRIGGER runs_projection_update; CREATE TRIGGER runs_projection_update AFTER UPDATE OF data ON runs BEGIN INSERT INTO meta(key,value) VALUES ('tamper_trigger_ran','yes'); END;");
  db.close();
  let opened = false;
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {}, {
    openStoreImpl(...args) { opened = true; return openStore(...args); }
  }), { code: RECOVERY_STATE_ERROR_CODE });
  assert.equal(opened, false);
  const verify = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true });
  try { assert.equal(verify.prepare("SELECT value FROM meta WHERE key='tamper_trigger_ran'").get(), undefined); }
  finally { verify.close(); }
});

test('optional state sidecars must be private regular single-link files', async t => {
  const root = await setup(t);
  const outside = join(root, 'outside');
  await writeFile(outside, 'synthetic sidecar', { mode: 0o600 });
  await symlink(outside, join(root, 'agent.sqlite-shm'));
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
});

test('state root and database must remain private owner-only single-link paths', async t => {
  const publicRoot = await setup(t);
  await chmod(publicRoot, 0o755);
  await assert.rejects(withRecoveryStore({ stateRoot: publicRoot, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
  await chmod(publicRoot, 0o700);

  const linkedRoot = await setup(t);
  await link(join(linkedRoot, 'agent.sqlite'), join(linkedRoot, 'database-copy'));
  await assert.rejects(withRecoveryStore({ stateRoot: linkedRoot, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
});

test('recovery publication markers block held-state access', async t => {
  const root = await setup(t);
  await writeFile(join(root, '.restore-incomplete'), 'synthetic interrupted restore', { mode: 0o600 });
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
});

test('database symlinks are rejected before store opening', async t => {
  const root = await setup(t);
  const database = join(root, 'agent.sqlite');
  const original = join(root, 'saved.sqlite');
  await rename(database, original);
  await symlink(original, database);
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, async () => {}), { code: RECOVERY_STATE_ERROR_CODE });
});

test('successful callback leaves exact application rows unchanged', async t => {
  const root = await setup(t);
  const before = stateRows(root);
  await withRecoveryStore({ stateRoot: root, identity }, async store => {
    assert.equal(store.getRun('synthetic-run').status, 'uncertain');
  });
  assert.deepEqual(stateRows(root), before);
});

test('explicit released-state scope permits acknowledgment only for an absent hold, never malformed holds', async t => {
  const root = await setup(t);
  const store = openStore(root, { identity });
  store.deleteMeta('restore_hold');
  store.close();
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity }, () => {}), { code: RECOVERY_STATE_ERROR_CODE });
  await withRecoveryStore({ stateRoot: root, identity, allowReleased: true }, (current, descriptor) => {
    assert.equal(current.getMeta('restore_hold'), undefined);
    assert.equal(descriptor.recovery, null);
    assert.equal(descriptor.rawHold, null);
  });
  const malformed = openStore(root, { identity });
  malformed.setMeta('restore_hold', '');
  malformed.close();
  await assert.rejects(withRecoveryStore({ stateRoot: root, identity, allowReleased: true }, () => {}), { code: RECOVERY_STATE_ERROR_CODE });
});
