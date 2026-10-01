import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/policy.mjs';
import { inspectRecovery } from '../src/recovery-inspect.mjs';
import { openStore } from '../src/store.mjs';

const identity = 'a'.repeat(64);
const hold = JSON.stringify({ snapshotId: '00000000-0000-4000-8000-000000000001', snapshotCreatedAt: 1_700_000_000_000, restoredAt: 1_700_000_100_000 });
const cursor = JSON.stringify({ initialComplete: true, delta: 'https://graph.example.test/private-token' });

async function privateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'ma-recovery-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openStore(root, { identity });
  store.setMeta('restore_hold', hold);
  store.setMeta('cursor', cursor);
  store.saveRun({ id: 'run-synthetic', messageKey: 'd'.repeat(64), conversationKey: 'e'.repeat(64), status: 'uncertain',
    sequence: 7, createdAt: 1_700_000_100_007, budget: { modelCalls: 1, toolCalls: 0, activeMs: 10 },
    uncertainty: { kind: 'tool', key: 'action-synthetic' }, mail: { body: 'MUST_NOT_ESCAPE' }, reply: 'MUST_NOT_ESCAPE' });
  store.saveAction({ key: 'action-synthetic', runId: 'run-synthetic', state: 'uncertain', effect: 'write', tool: 'records.append',
    args: { private: 'MUST_NOT_ESCAPE' }, result: 'MUST_NOT_ESCAPE' });
  store.close();
  return root;
}

function wrapStore(root, extra = {}) {
  const store = openStore(root, { identity, ...extra.openOptions });
  return new Proxy(store, {
    get(target, property) {
      if (property === 'close' && extra.close) return extra.close.bind(null, target.close.bind(target));
      if (extra[property]) return extra[property].bind(null, target[property].bind(target));
      return target[property];
    }
  });
}

test('recovery inspection returns a snapshot-bound safe descriptor and bounded run page', async t => {
  const root = await privateRoot(t);
  const result = await inspectRecovery({ stateRoot: root, identity, limit: 5, clock: () => 1_800_000_000_000 });
  assert.equal(result.stateSchema, 5);
  assert.deepEqual(result.recovery, { required: true, snapshotId: '00000000-0000-4000-8000-000000000001',
    snapshotCreatedAt: 1_700_000_000_000, restoredAt: 1_700_000_100_000, reason: 'restore-reconciliation' });
  assert.equal(result.binding, digest([identity, hold, cursor]));
  assert.equal(result.cursorDigest, digest(cursor));
  assert.equal(result.counts.uncertain, 1);
  assert.equal(result.kind, 'runs');
  assert.equal(result.items[0].id, 'run-synthetic');
  assert.equal(JSON.stringify(result).includes('MUST_NOT_ESCAPE'), false);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('recovery inspection validates page bounds and typed cursor before opening state', async t => {
  const root = await privateRoot(t);
  let opened = false;
  const openStoreImpl = (...args) => { opened = true; return openStore(...args); };
  for (const input of [
    { limit: 0 }, { limit: 101 }, { after: 'not-base64-json' },
    { after: Buffer.from(JSON.stringify({ kind: 'runs', position: { sequence: -1, id: 'x' } })).toString('base64url') },
    { kind: 'runs', after: Buffer.from(JSON.stringify({ kind: 'actions', position: 'action-key' })).toString('base64url') }
  ]) {
    await assert.rejects(inspectRecovery({ stateRoot: root, identity, ...input }, { openStoreImpl }));
  }
  assert.equal(opened, false);
});

test('action inspection uses its own opaque key cursor and returns only safe action metadata', async t => {
  const root = await privateRoot(t);
  const after = Buffer.from(JSON.stringify({ kind: 'actions', position: 'action-before' })).toString('base64url');
  const result = await inspectRecovery({ stateRoot: root, identity, kind: 'actions', after });
  assert.equal(result.kind, 'actions');
  assert.equal(result.items[0].key, 'action-synthetic');
  assert.equal(JSON.stringify(result).includes('MUST_NOT_ESCAPE'), false);
});

test('recovery inspection rejects absent or malformed holds before reading run/action pages', async t => {
  for (const raw of [undefined, '', '{not-json}', JSON.stringify({ snapshotId: 'bad', snapshotCreatedAt: 1, restoredAt: 2 })]) {
    const root = await privateRoot(t);
    const store = openStore(root, { identity });
    if (raw === undefined) store.transaction(() => store.setMeta('restore_hold', ''));
    else store.setMeta('restore_hold', raw);
    store.close();
    await assert.rejects(inspectRecovery({ stateRoot: root, identity }));
  }
});

test('recovery inspection fails safely when mailbox identity is invalid or mismatched', async t => {
  const root = await privateRoot(t);
  let opened = false;
  await assert.rejects(inspectRecovery({ stateRoot: root, identity: 'not-an-identity' }, {
    openStoreImpl(...args) { opened = true; return openStore(...args); }
  }));
  await assert.rejects(inspectRecovery({ stateRoot: root, identity: 'f'.repeat(64) }, {
    openStoreImpl(...args) { opened = true; return openStore(...args); }
  }));
  assert.equal(opened, false);
});

test('schema preflight rejects unsafe SQLite sidecars before opening the database', async t => {
  const root = await privateRoot(t);
  const external = join(root, 'external');
  await writeFile(external, 'synthetic sidecar target', { mode: 0o600 });
  await symlink(external, join(root, 'agent.sqlite-wal'));
  await assert.rejects(inspectRecovery({ stateRoot: root, identity }));
});

test('inspection of an absent state root does not initialize it', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'ma-recovery-inspect-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const absent = join(parent, 'not-created');
  await assert.rejects(inspectRecovery({ stateRoot: absent, identity }));
  await assert.rejects(access(absent));
});

test('request clock is passed to the owner store and close failures use a fixed safe diagnostic', async t => {
  const root = await privateRoot(t);
  const requestClock = () => 1234;
  let passedClock;
  await assert.rejects(inspectRecovery({ stateRoot: root, identity, clock: requestClock }, {
    openStoreImpl(path, options) {
      passedClock = options.clock;
      return wrapStore(path, { close(close) { close(); throw new Error('PRIVATE_RAW_ERROR'); } });
    }
  }), error => error.message === 'Recovery state is unavailable or unsafe.' && !error.message.includes('PRIVATE_RAW_ERROR'));
  assert.equal(passedClock, requestClock);
});

test('missing legacy budget is represented as null without inventing values', async t => {
  const root = await privateRoot(t);
  const result = await inspectRecovery({ stateRoot: root, identity }, {
    openStoreImpl(path) { return wrapStore(path, { recoveryPage(read) { return { ...read(), items: read().items.map(item => ({ ...item, budget: null })) }; } }); }
  });
  assert.equal(result.items[0].budget, null);
});
