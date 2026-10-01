import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ma-release-store-'));
  const store = openStore(root, { identity: 'synthetic', clock: () => 100 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return store;
}

test('bounded metadata reads distinguish absent and excess UTF-8 bytes; deletion rolls back atomically', async t => {
  const store = await fixture(t);
  assert.equal(store.getMetaBounded('absent', 10), undefined);
  store.setMeta('private', 'é'.repeat(10));
  assert.equal(store.getMetaBounded('private', 20), 'é'.repeat(10));
  assert.equal(store.getMetaBounded('private', 19), null);
  assert.throws(() => store.getMetaBounded('private', 0));
  assert.throws(() => store.transaction(() => { store.deleteMeta('private'); throw new Error('Synthetic rollback'); }));
  assert.equal(store.getMeta('private'), 'é'.repeat(10));
  store.deleteMeta('private');
  assert.equal(store.getMeta('private'), undefined);
});

test('active recovery metadata pages exclude permanent history and provide exact fingerprints', async t => {
  const store = await fixture(t);
  const statuses = ['completed', 'queued', 'ignored', 'awaiting_approval', 'uncertain', 'ready_to_send', 'running', 'sending'];
  for (const [sequence, status] of statuses.entries()) store.saveRun({ id: `run-${sequence}`, sequence, status,
    messageKey: `message-${sequence}`, conversationKey: `conversation-${sequence}`, createdAt: 10,
    mail: { body: 'SYNTHETIC_PRIVATE_BODY' } });
  const first = store.activeRecoveryPage({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['run-1', 'run-3']);
  assert.equal(first.items[0].fingerprint, store.runFingerprint('run-1'));
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['fingerprint', 'id', 'sequence']);
  const second = store.activeRecoveryPage({ limit: 2, after: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.id), ['run-5', 'run-6']);
  const third = store.activeRecoveryPage({ limit: 2, after: second.nextCursor });
  assert.deepEqual(third.items.map(item => item.id), ['run-7']);
  assert.equal(third.nextCursor, null);
  assert.ok(store.activeRecoveryPage({ limit: 101 }).items.length<=100);
});
