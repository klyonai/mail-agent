import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { mailboxIdentity } from '../src/state-identity.mjs';
import { withRecoveryStore } from '../src/recovery-state.mjs';
import { digest } from '../src/policy.mjs';
import { previewRecoveryRelease, applyRecoveryRelease } from '../src/recovery-release.mjs';

const now = 1_800_000_100_000, clock = () => now;
const snapshotId = '00000000-0000-4000-8000-000000000099';
const hold = JSON.stringify({ snapshotId, snapshotCreatedAt: now - 2000, restoredAt: now - 1000 });
const cursor = JSON.stringify({ url: 'https://graph.microsoft.com/v1.0/users/assistant%40example.org/mailFolders/inbox/messages/delta?$deltatoken=SYNTHETIC_CRASH_CURSOR', initialComplete: true });
const actor = 'operator@example.org', reason = 'Synthetic atomic release fault injection';

async function fixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'ma-release-crash-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const loaded = await loadConfig(new URL('../examples/text-inbox/agent.yaml', import.meta.url).pathname, { env: {} });
  const config = { ...loaded.config, state_root: stateRoot }, identity = mailboxIdentity(config), configHash = 'b'.repeat(64);
  const binding = digest([identity, hold, cursor]);
  const store = openStore(stateRoot, { identity, clock });
  store.setMeta('restore_hold', hold);
  store.setMeta('cursor', cursor);
  store.close();
  const request = { stateRoot, identity, configHash, config, actor, reason, clock,
    plan: { format: 1, mode: 'continuity', mailboxIdentity: identity, snapshotId, binding, configHash,
      coverage: { from: now - 2000, through: now, oldOwnerStoppedAt: now - 1500, evidenceHash: 'c'.repeat(64), allSources: true },
      acceptHistoryGap: false } };
  const inspect = callback => {
    const current = openStore(stateRoot, { identity, clock });
    try { return callback(current); } finally { current.close(); }
  };
  const auditRows = () => {
    const db = new DatabaseSync(join(stateRoot, 'agent.sqlite'), { readOnly: true, allowExtension: false });
    try { return db.prepare("SELECT event,details FROM audit WHERE event='recovery-release'").all(); } finally { db.close(); }
  };
  return { request, inspect, auditRows };
}

function faultStore(kind) {
  return async (request, callback) => withRecoveryStore(request, (store, descriptor) => {
    const proxy = new Proxy(store, { get(target, key) {
      if (key === 'setMeta') return (name, value) => {
        if ((kind === 'cursor' && name === 'cursor') || (kind === 'receipt' && name.startsWith('recovery_release_receipt:'))) throw new Error('injected');
        return target.setMeta(name, value);
      };
      if (key === 'audit') return (event, ...args) => {
        if (kind === 'audit' && event === 'recovery-release') throw new Error('injected');
        return target.audit(event, ...args);
      };
      if (key === 'deleteMeta') return name => {
        if (kind === 'hold' && name === 'restore_hold') throw new Error('injected');
        return target.deleteMeta(name);
      };
      if (key === 'transaction') return callbackInTransaction => target.transaction(() => {
        const result = callbackInTransaction();
        if (kind === 'before-commit') throw new Error('injected');
        return result;
      });
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    return callback(proxy, descriptor);
  });
}

test('cursor, audit, receipt, hold-delete and pre-commit failures roll back the whole release transaction', async t => {
  for (const failure of ['cursor', 'audit', 'receipt', 'hold', 'before-commit']) {
    await t.test(failure, async t2 => {
      const f = await fixture(t2);
      const preview = await previewRecoveryRelease(f.request);
      const request = { ...f.request, expectedReviewDigest: preview.reviewDigest };
      await assert.rejects(applyRecoveryRelease(request, { withStore: faultStore(failure) }), error => error.code === 'RECOVERY_RELEASE_INVALID');
      assert.equal(f.inspect(store => store.getMeta('restore_hold')), hold);
      assert.equal(f.inspect(store => store.getMeta('cursor')), cursor);
      assert.equal(f.inspect(store => store.getMeta(`recovery_release_receipt:${preview.reviewDigest}`)), undefined);
      assert.deepEqual(f.auditRows(), []);
    });
  }
});

test('successful retry after a rolled-back attempt commits cursor, audit, receipt and hold deletion together', async t => {
  const f = await fixture(t);
  const preview = await previewRecoveryRelease(f.request);
  const request = { ...f.request, expectedReviewDigest: preview.reviewDigest };
  await assert.rejects(applyRecoveryRelease(request, { withStore: faultStore('before-commit') }));
  const applied = await applyRecoveryRelease(request);
  assert.equal(applied.released, true);
  assert.equal(applied.idempotent, false);
  assert.equal(f.inspect(store => store.getMeta('restore_hold')), undefined);
  assert.equal(f.inspect(store => store.getMeta('cursor')), cursor);
  assert.equal(typeof f.inspect(store => store.getMeta(`recovery_release_receipt:${preview.reviewDigest}`)), 'string');
  assert.equal(f.auditRows().length, 1);
  const repeated = await applyRecoveryRelease(request);
  assert.equal(repeated.idempotent, true);
  assert.equal(f.auditRows().length, 1);
});
