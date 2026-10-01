import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, chmod, readFile, rm, stat, writeFile, unlink, symlink, link, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageArtifacts } from '../src/image-artifacts.mjs';
import { ImageError } from '../src/image-validation.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const source = { messageId: 'synthetic-message', attachmentId: 'synthetic-attachment' };
const image = () => readFile(new URL('./fixtures/images/synthetic-note.png', import.meta.url));
async function setup(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'mail-image-')); await chmod(stateRoot, 0o700);
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let now = 1000;
  const artifacts = createImageArtifacts({ stateRoot, runId, expiresAt: 2000, clock: () => now });
  return { stateRoot, artifacts, advance: () => { now = 2001; } };
}
const path = (root, handle, file) => join(root, 'artifacts', runId, handle.id, file);

test('private artifact roundtrip preserves verified bytes and source provenance without paths', async t => {
  const { stateRoot, artifacts } = await setup(t), bytes = await image();
  const handle = await artifacts.put(bytes, { mediaType: 'image/png', source });
  assert.equal(Object.isFrozen(handle), true); assert.equal(Object.isFrozen(handle.source), true);
  assert.deepEqual(handle.source, source); assert.equal(handle.runId, runId); assert.equal(handle.expiresAt, 2000);
  assert.equal(handle.path, undefined); assert.equal(handle.name, undefined);
  assert.deepEqual(await artifacts.read(handle), bytes);
  assert.equal((await stat(path(stateRoot, handle, 'bytes'))).mode & 0o777, 0o600);
  assert.equal((await stat(path(stateRoot, handle, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateRoot, 'artifacts', runId, handle.id))).mode & 0o777, 0o700);
  const reopened = createImageArtifacts({ stateRoot, runId, expiresAt: 2000, clock: () => 1000 });
  assert.deepEqual(await reopened.read(handle), bytes);
});

test('hash drift, forged provenance, scope traversal, hardlinks, symlinks and public modes fail closed', async t => {
  const { stateRoot, artifacts } = await setup(t), bytes = await image();
  const handle = await artifacts.put(bytes, { mediaType: 'image/png', source });
  for (const changed of [{ ...handle, runId: '../outside' }, { ...handle, id: '../outside' }, { ...handle, source: { ...source, messageId: 'changed' } }]) {
    await assert.rejects(artifacts.read(changed), ImageError);
  }
  await writeFile(path(stateRoot, handle, 'bytes'), Buffer.from('private corrupted content'));
  await assert.rejects(artifacts.read(handle), error => error instanceof ImageError && error.code === 'IMAGE_ARTIFACT_INVALID' && !String(error).includes('private'));
  await writeFile(path(stateRoot, handle, 'bytes'), bytes); await chmod(path(stateRoot, handle, 'bytes'), 0o644);
  await assert.rejects(artifacts.read(handle), ImageError); await chmod(path(stateRoot, handle, 'bytes'), 0o600);
  const outside = join(stateRoot, 'outside'); await link(path(stateRoot, handle, 'bytes'), outside);
  await assert.rejects(artifacts.read(handle), ImageError); await unlink(outside);
  await unlink(path(stateRoot, handle, 'bytes')); await symlink(join(stateRoot, 'missing'), path(stateRoot, handle, 'bytes'));
  await assert.rejects(artifacts.read(handle), ImageError);
});

test('expiry prevents reuse and bounded purge removes bytes without inference or renewal', async t => {
  const { stateRoot, artifacts, advance } = await setup(t);
  const handle = await artifacts.put(await image(), { mediaType: 'image/png', source }); advance();
  await assert.rejects(artifacts.read(handle), error => error.code === 'IMAGE_EXPIRED');
  assert.equal(await artifacts.purgeExpired([handle]), 1);
  await assert.rejects(stat(path(stateRoot, handle, 'bytes')), { code: 'ENOENT' });
  await assert.rejects(artifacts.put(await image(), { mediaType: 'image/png', source }), ImageError);
});

test('unsafe root, unsafe provenance, pre-cancellation and extra files never authorize reads', async t => {
  const { stateRoot, artifacts } = await setup(t), bytes = await image();
  await assert.rejects(artifacts.put(bytes, { mediaType: 'image/png', source, signal: AbortSignal.abort() }), ImageError);
  await assert.rejects(artifacts.put(bytes, { mediaType: 'image/png', source: { ...source, attachmentId: '../\nprivate' } }), ImageError);
  const handle = await artifacts.put(bytes, { mediaType: 'image/png', source });
  await writeFile(path(stateRoot, handle, 'extra'), 'unexpected', { mode: 0o600 });
  await assert.rejects(artifacts.read(handle), ImageError);
  await chmod(stateRoot, 0o755);
  await assert.rejects(artifacts.put(bytes, { mediaType: 'image/png', source }), ImageError);
});

test('cancellation after private byte publication closes files and removes exclusively owned partial artifacts', async t => {
  const { stateRoot } = await setup(t), controller = new AbortController(); let checks = 0;
  const artifacts = createImageArtifacts({ stateRoot, runId, expiresAt: 2000, clock: () => {
    if (++checks === 2) controller.abort(); return 1000;
  } });
  await assert.rejects(artifacts.put(await image(), { mediaType: 'image/png', source, signal: controller.signal }), error => error.code === 'IMAGE_CANCELLED');
  assert.deepEqual(await readdir(join(stateRoot, 'artifacts', runId)), []);
});

test('missing completion manifest and public artifact parent never authorize reopening', async t => {
  const { stateRoot, artifacts } = await setup(t);
  const handle = await artifacts.put(await image(), { mediaType: 'image/png', source });
  await unlink(path(stateRoot, handle, 'manifest.json'));
  await assert.rejects(artifacts.read(handle), ImageError);
  const second = await artifacts.put(await image(), { mediaType: 'image/png', source });
  await chmod(join(stateRoot, 'artifacts'), 0o755);
  await assert.rejects(artifacts.read(second), ImageError);
});
