import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const handleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha = 'a'.repeat(64);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mail-agent-artifacts-'));
  return root;
}

function artifact(purpose, overrides = {}) {
  const base = purpose === 'image-input'
    ? { id: handleId, runId, mediaType: 'image/png', size: 8, width: 1, height: 1, sha256: sha,
      expiresAt: 20_000, source: { messageId: 'provider-message', attachmentId: 'provider-attachment' } }
    : { id: handleId, runId, mediaType: 'text/plain', name: 'transcription.txt', size: 13, sha256: sha,
      expiresAt: 20_000, source: { messageId: 'provider-message', attachmentId: 'generated-transcript' } };
  return { ...base, ...overrides };
}

function queuedRun() {
  return { id: runId, messageKey: 'message-key', conversationKey: 'conversation-key', status: 'queued',
    sequence: 1, createdAt: 1_000, budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 } };
}

test('schema five migration creates artifact references and preserves existing run state', async t => {
  const root = await fixture();
  let store = openStore(root, { identity: 'synthetic' });
  t.after(async () => rm(root, { recursive: true, force: true }));
  store.saveRun(queuedRun());
  store.close();

  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("UPDATE meta SET value='4' WHERE key='schema_version'");
  db.close();

  store = openStore(root, { identity: 'synthetic' });
  try {
    assert.equal(store.getMeta('schema_version'), '5');
    assert.equal(store.getRun(runId).status, 'queued');
    assert.deepEqual(store.artifactsForRun(runId), []);
  } finally { store.close(); }
});

test('artifact references are run-scoped, immutable metadata pages and reject invalid references', async t => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 9_000 });
  t.after(() => store.close());
  t.after(async () => rm(root, { recursive: true, force: true }));
  store.saveRun(queuedRun());
  const image = artifact('image-input');
  const text = artifact('text-output', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  store.saveArtifact({ purpose: 'image-input', handle: image, createdAt: 2_000 });
  store.saveArtifact({ purpose: 'text-output', handle: text, createdAt: 3_000 });

  assert.deepEqual(store.artifactsForRun(runId).map(item => item.purpose), ['image-input', 'text-output']);
  assert.deepEqual(store.artifactsBatch({ limit: 1 }).items.map(item => item.handle.id), [handleId]);
  const page = store.artifactsBatch({ limit: 1 });
  assert.deepEqual(store.artifactsBatch({ limit: 1, after: page.nextCursor }).items.map(item => item.handle.id), [text.id]);
  assert.throws(() => store.saveArtifact({ purpose: 'image-input', handle: { ...image, size: -1 }, createdAt: 2_000 }), /artifact/i);
  assert.throws(() => store.saveArtifact({ purpose: 'image-input', handle: image, createdAt: -1 }), /artifact/i);
  assert.throws(() => store.saveArtifact({ purpose: 'pdf-input', handle: image, createdAt: 2_000 }), /artifact/i);
  assert.throws(() => store.saveArtifact({ purpose: 'text-output', handle: { ...text, runId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, createdAt: 2_000 }), /artifact/i);
  assert.equal(store.getMeta('schema_version'), '5');
});

test('retention retires references atomically and leaves a bounded durable post-commit GC queue', async t => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 5_000_000 });
  t.after(() => store.close());
  t.after(async () => rm(root, { recursive: true, force: true }));
  store.saveRun(queuedRun());
  const handle = artifact('image-input');
  store.saveArtifact({ purpose: 'image-input', handle, createdAt: 1_000 });
  const result = store.expireRunById(runId, { contentHours: 1 });
  assert.deepEqual(result.artifactsToCollect.map(item => item.handle.id), [handle.id]);
  assert.deepEqual(store.artifactsForRun(runId), []);
  assert.deepEqual(store.artifactIdsForRun(runId), [handle.id]);
  const gc = store.artifactGcBatch({ limit: 1 });
  assert.equal(gc.items[0].retiredAt, 5_000_000);
  assert.equal(store.deleteRetiredArtifact(handle.id), 1);
  assert.deepEqual(store.artifactGcBatch().items, []);
});
