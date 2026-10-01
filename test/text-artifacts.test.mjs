import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, chmod, readFile, rm, symlink, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTextArtifacts } from '../src/text-artifacts.mjs';
import { createImageArtifacts } from '../src/image-artifacts.mjs';
import { validateArtifactHandle, removeArtifactReferences, cleanExpiredRunOrphans } from '../src/artifact-files.mjs';
import { ImageError } from '../src/image-validation.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const source = { messageId: 'synthetic-message', attachmentId: 'generated-transcript' };
async function setup(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'text-artifact-')); await chmod(stateRoot, 0o700);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  return { stateRoot, artifacts: createTextArtifacts({ stateRoot, runId, expiresAt: 2000, clock: () => 1000 }) };
}

test('generated transcript has fixed name, strict UTF8 bytes and immutable hash-bound provenance', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const handle = await artifacts.put('SCAN 123\nÜberprüfung ✓', { source, maxBytes: 1024 });
  assert.equal(handle.mediaType, 'text/plain'); assert.equal(handle.name, 'transcription.txt');
  assert.equal(Object.isFrozen(handle), true); assert.equal(Object.isFrozen(handle.source), true);
  assert.deepEqual(await artifacts.read(handle), Buffer.from('SCAN 123\nÜberprüfung ✓'));
  const stored = JSON.parse(await readFile(join(stateRoot, 'artifacts', runId, handle.id, 'manifest.json'), 'utf8'));
  assert.deepEqual(validateArtifactHandle(stored), handle);
  const clone = validateArtifactHandle(handle); clone.source.messageId = 'changed'; assert.equal(handle.source.messageId, 'synthetic-message');
});

test('empty, invalid Unicode, null, excess bytes, unsafe source and unsupported names fail before publication', async t => {
  const { stateRoot, artifacts } = await setup(t);
  for (const [text, options] of [
    ['', { source }], ['  ', { source }], ['\ud800', { source }], ['bad\0text', { source }],
    ['éé', { source, maxBytes: 3 }], ['text', { source, maxBytes: 2000001 }],
    ['text', { source: { ...source, attachmentId: 'foreign-file' } }],
  ]) await assert.rejects(artifacts.put(text, options), ImageError);
  assert.deepEqual(await readdir(stateRoot), []);
  const handle = await artifacts.put('valid', { source });
  assert.throws(() => validateArtifactHandle({ ...handle, name: '../secret.txt' }), ImageError);
  assert.throws(() => validateArtifactHandle({ ...handle, injectedContents: 'private' }), ImageError);
});

test('bounded retired-reference collection is idempotent and does not remove current artifacts', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const current = await artifacts.put('current', { source }), retired = await artifacts.put('retired', { source });
  assert.equal(await removeArtifactReferences({ stateRoot, references: [{ handle: current, retired: false }, { handle: retired, retired: true }], clock: () => 1000 }), 1);
  assert.deepEqual(await artifacts.read(current), Buffer.from('current'));
  await assert.rejects(artifacts.read(retired), ImageError);
  assert.equal(await removeArtifactReferences({ stateRoot, references: [{ handle: retired, retired: true }], clock: () => 1000 }), 0);
  assert.equal(await removeArtifactReferences({ stateRoot, references: [{ handle: current }], clock: () => 2001 }), 1);
  await assert.rejects(removeArtifactReferences({ stateRoot, references: Array(101).fill({ handle: current }), clock: () => 2001 }), ImageError);
});

test('untrusted symlink or writable ancestors reject artifact writes before changing state', async t => {
  const { stateRoot } = await setup(t), bytes = await readFile(new URL('./fixtures/images/synthetic-note.png', import.meta.url));
  const target = join(stateRoot, 'target'); await mkdir(target, { mode: 0o700 }); await mkdir(join(target, 'state'), { mode: 0o700 });
  const alias = join(stateRoot, 'alias'); await symlink(target, alias);
  const symlinked = createImageArtifacts({ stateRoot: join(alias, 'state'), runId, expiresAt: 2000, clock: () => 1000 });
  await assert.rejects(symlinked.put(bytes, { mediaType: 'image/png', source: { messageId: 'synthetic', attachmentId: 'file' } }), ImageError);
  assert.deepEqual(await readdir(join(target, 'state')), []);
  await chmod(target, 0o777);
  const writable = createTextArtifacts({ stateRoot: join(target, 'state'), runId, expiresAt: 2000, clock: () => 1000 });
  await assert.rejects(writable.put('text', { source }), ImageError);
  assert.deepEqual(await readdir(join(target, 'state')), []);
});

test('known retired cleanup resumes partial unlink boundaries but rejects extra entries and unsafe parents', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const first = await artifacts.put('first', { source }), second = await artifacts.put('second', { source });
  const firstDir = join(stateRoot, 'artifacts', runId, first.id), secondDir = join(stateRoot, 'artifacts', runId, second.id);
  await unlink(join(firstDir, 'bytes'));
  assert.equal(await removeArtifactReferences({ stateRoot, references: [{ handle: first, retired: true }], clock: () => 1000 }), 1);
  await unlink(join(secondDir, 'bytes')); await unlink(join(secondDir, 'manifest.json'));
  assert.equal(await removeArtifactReferences({ stateRoot, references: [{ handle: second, retired: true }], clock: () => 1000 }), 1);
  const extra = await artifacts.put('extra', { source });
  await writeFile(join(stateRoot, 'artifacts', runId, extra.id, 'unexpected'), 'private', { mode: 0o600 });
  await assert.rejects(removeArtifactReferences({ stateRoot, references: [{ handle: extra, retired: true }], clock: () => 1000 }), ImageError);
  await chmod(join(stateRoot, 'artifacts'), 0o777);
  await assert.rejects(removeArtifactReferences({ stateRoot, references: [{ handle: first, retired: true }], clock: () => 1000 }), ImageError);
});

test('bounded known-run expiry cleans unreferenced complete and partial crash artifacts while keeping refs', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const referenced = await artifacts.put('referenced', { source }), complete = await artifacts.put('orphan', { source });
  const partial = await artifacts.put('partial', { source });
  const partialDir = join(stateRoot, 'artifacts', runId, partial.id); await unlink(join(partialDir, 'manifest.json'));
  const emptyId = '33333333-3333-4333-8333-333333333333'; await mkdir(join(stateRoot, 'artifacts', runId, emptyId), { mode: 0o700 });
  const input = { stateRoot, runId, expiresAt: 2000, references: [referenced.id], clock: () => 2001, maxEntries: 100 };
  assert.deepEqual(await cleanExpiredRunOrphans({ ...input, clock: () => 1000 }), { removed: 0, complete: true });
  assert.deepEqual(await cleanExpiredRunOrphans(input), { removed: 3, complete: true });
  assert.deepEqual(await readdir(join(stateRoot, 'artifacts', runId)), [referenced.id]);
  assert.deepEqual(await cleanExpiredRunOrphans(input), { removed: 0, complete: true });
  await assert.rejects(readFile(join(stateRoot, 'artifacts', runId, complete.id, 'bytes')), { code: 'ENOENT' });
});

test('known-run orphan preflight rejects entry cap and unexpected paths before any deletion', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const first = await artifacts.put('first', { source }), second = await artifacts.put('second', { source });
  const input = { stateRoot, runId, expiresAt: 2000, references: [], clock: () => 2001 };
  await assert.rejects(cleanExpiredRunOrphans({ ...input, maxEntries: 1 }), ImageError);
  assert.deepEqual(await artifacts.read(first), Buffer.from('first'));
  await writeFile(join(stateRoot, 'artifacts', runId, second.id, 'unexpected'), 'private', { mode: 0o600 });
  await assert.rejects(cleanExpiredRunOrphans(input), ImageError);
  assert.deepEqual(await artifacts.read(first), Buffer.from('first'));
  await assert.rejects(cleanExpiredRunOrphans({ ...input, signal: AbortSignal.abort() }), ImageError);
  await assert.rejects(cleanExpiredRunOrphans({ ...input, runId: '../outside' }), ImageError);
});

test('partial manifest writes expire by known run authority while newer private artifact expiry is protected', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const partial = await artifacts.put('partial', { source });
  await writeFile(join(stateRoot, 'artifacts', runId, partial.id, 'manifest.json'), '{"id":');
  const newer = createTextArtifacts({ stateRoot, runId, expiresAt: 3000, clock: () => 1000 });
  const protectedHandle = await newer.put('protected', { source });
  const result = await cleanExpiredRunOrphans({ stateRoot, runId, expiresAt: 2000, references: [], clock: () => 2001 });
  assert.equal(result.removed, 1); assert.deepEqual(await newer.read(protectedHandle), Buffer.from('protected'));
});
