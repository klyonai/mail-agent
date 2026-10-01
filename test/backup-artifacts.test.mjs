import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { backupState, inspectSnapshot } from '../src/backup.mjs';
import { restoreState } from '../src/restore.mjs';
import { openStore } from '../src/store.mjs';
import { createImageArtifacts } from '../src/image-artifacts.mjs';
import {DatabaseSync} from 'node:sqlite';
import { createTextArtifacts } from '../src/text-artifacts.mjs';

const identity = 'a'.repeat(64);
const runId = '11111111-1111-4111-8111-111111111111';
const snapshotId = '22222222-2222-4222-8222-222222222222';
const source = { messageId: 'synthetic-message', attachmentId: 'synthetic-attachment' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mail-backup-artifacts-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  const store = openStore(stateRoot, { identity, clock: () => 1_000 });
  const bytes = await readFile(new URL('./fixtures/images/synthetic-note.png', import.meta.url));
  const handle = await createImageArtifacts({ stateRoot, runId, expiresAt: 100_000, clock: () => 1_000 })
    .put(bytes, { mediaType: 'image/png', source });
  const outputText = 'Synthetic transcript.\n';
  const outputArtifact = await createTextArtifacts({ stateRoot, runId, expiresAt: 100_000, clock: () => 1_000 })
    .put(outputText, { source: { messageId: 'synthetic-message', attachmentId: 'generated-transcript' }, maxBytes: 1024 });
  const reply = 'The transcript is attached.';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const deliveryIntent = { messageId: 'synthetic-message', conversationId: 'synthetic-thread', recipient: 'owner@example.test',
    bodySha256: hash(reply), artifactId: outputArtifact.id, artifactSha256: outputArtifact.sha256, filename: outputArtifact.name,
    mediaType: outputArtifact.mediaType, size: outputArtifact.size, expiresAt: outputArtifact.expiresAt, payloadSha256: 'b'.repeat(64) };
  store.saveRun({ id: runId, messageKey: 'message-key', conversationKey: 'conversation-key', status: 'queued',
    sequence: 1, createdAt: 1_000, budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, mail: { id: 'synthetic-message',
      conversationId: 'synthetic-thread', sender: 'owner@example.test' }, reply, replyKind: 'transcript', imageArtifacts: [handle],
    outputArtifact, deliveryIntent, messages: [{ role: 'user', content: [{ type: 'image-reference', artifact: handle }] }] });
  store.saveArtifact({ purpose: 'image-input', handle, createdAt: 1_000 });
  store.saveArtifact({ purpose: 'text-output', handle: outputArtifact, createdAt: 1_000 });
  store.close();
  return { root, stateRoot, bytes, handle, outputArtifact, outputText, snapshot: join(root, 'snapshot'), target: join(root, 'restored') };
}

test('format-two snapshot copies verified live artifacts and restores them with their held run handles', async t => {
  const value = await fixture(t);
  await backupState({ stateRoot: value.stateRoot, directory: value.snapshot, identity, snapshotId, clock: () => 2_000 });
  const manifest = JSON.parse(await readFile(join(value.snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 2);
  assert.equal(manifest.stateSchema, 5);
  assert.deepEqual(manifest.artifacts, [
    { purpose: 'image-input', createdAt: 1_000, handle: value.handle },
    { purpose: 'text-output', createdAt: 1_000, handle: value.outputArtifact },
  ].sort((left, right) => left.handle.id.localeCompare(right.handle.id)));
  assert.deepEqual(await inspectSnapshot({ directory: value.snapshot, identity }), { manifest, databasePath: join(value.snapshot, 'snapshot.sqlite') });

  const restored = await restoreState({ snapshot: value.snapshot, stateRoot: value.target, identity,
    actor: 'operator@example.test', reason: 'Synthetic recovery drill.', clock: () => 3_000 });
  assert.equal(restored.stateSchema, 5);
  assert.equal(restored.recoveryRequired, true);
  const store = openStore(value.target, { identity, clock: () => 3_000 });
  try {
    assert.deepEqual(store.artifactsForRun(runId), [
      { purpose: 'image-input', createdAt: 1_000, handle: value.handle },
      { purpose: 'text-output', createdAt: 1_000, handle: value.outputArtifact },
    ].sort((left, right) => left.createdAt - right.createdAt || left.handle.id.localeCompare(right.handle.id)));
    assert.equal(store.getRun(runId).imageArtifacts[0].id, value.handle.id);
    assert.equal(store.getRun(runId).deliveryIntent.artifactId, value.outputArtifact.id);
  } finally { store.close(); }
  const reopened = createImageArtifacts({ stateRoot: value.target, runId, expiresAt: value.handle.expiresAt, clock: () => 3_000 });
  assert.deepEqual(await reopened.read(value.handle), value.bytes);
  const text = createTextArtifacts({ stateRoot: value.target, runId, expiresAt: value.outputArtifact.expiresAt, clock: () => 3_000 });
  assert.equal((await text.read(value.outputArtifact)).toString('utf8'), value.outputText);
});

test('format-two inspection rejects missing, changed, or unreferenced artifact files', async t => {
  for (const corruption of ['missing', 'changed', 'extra']) {
    const value = await fixture(t);
    await backupState({ stateRoot: value.stateRoot, directory: value.snapshot, identity, snapshotId, clock: () => 2_000 });
    const artifactDirectory = join(value.snapshot, 'artifacts', runId, value.handle.id);
    if (corruption === 'missing') await rm(join(artifactDirectory, 'bytes'));
    if (corruption === 'changed') await (await import('node:fs/promises')).writeFile(join(artifactDirectory, 'bytes'), Buffer.from('tampered'), { mode: 0o600 });
    if (corruption === 'extra') await (await import('node:fs/promises')).writeFile(join(artifactDirectory, 'extra'), 'unexpected', { mode: 0o600 });
    await assert.rejects(inspectSnapshot({ directory: value.snapshot, identity }), { code: 'BACKUP_INVALID_STATE' });
  }
});

test('canonical legacy schema4 format1 snapshot restores to schema5 without reinterpreting it as an artifact inventory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mail-legacy-artifact-backup-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const stateRoot=join(root,'state'),directory=join(root,'snapshot'),target=join(root,'restored');
  const original={id:'legacy-run',messageKey:'legacy-message',conversationKey:'legacy-thread',status:'queued',
    sequence:1,createdAt:1000,budget:{modelCalls:2,toolCalls:1,activeMs:37}};
  const seed=openStore(stateRoot,{identity,clock:()=>1000});seed.saveRun(original);seed.close();
  const db=new DatabaseSync(join(stateRoot,'agent.sqlite'));
  try {db.exec("DROP TABLE artifact_refs; UPDATE meta SET value='4' WHERE key='schema_version'");}
  finally {db.close();}
  await backupState({stateRoot,directory,identity,snapshotId,clock:()=>2000});
  const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.format,1);assert.equal(manifest.stateSchema,4);assert.equal(manifest.artifacts,undefined);
  const restored=await restoreState({snapshot:directory,stateRoot:target,identity,actor:'operator@example.test',
    reason:'Synthetic legacy restore',clock:()=>3000});
  assert.equal(restored.stateSchema,5);
  const store=openStore(target,{identity,clock:()=>3000});
  try {assert.deepEqual(store.getRun(original.id).budget,original.budget);assert.equal(store.getRun(original.id).status,'queued');}
  finally {store.close();}
});
