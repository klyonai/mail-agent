import assert from 'node:assert/strict';
import test from 'node:test';
import { constants } from 'node:fs';
import { appendFile, chmod, link, mkdtemp, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRecoveryPlanFile } from '../src/recovery-io.mjs';

async function fixture(t, text = '{"decision":"hold"}') {
  const root = await mkdtemp(join(tmpdir(), 'ma-recovery-io-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'plan.json');
  await writeFile(filename, text, { mode: 0o600 });
  await chmod(filename, 0o600);
  return { root, filename };
}

test('reads bounded owner-only JSON without applying a schema', async t => {
  const { filename } = await fixture(t, '["synthetic", 17, null]');
  assert.deepEqual(await readRecoveryPlanFile(filename), ['synthetic', 17, null]);
});

test('rejects paths that are missing, invalid or too long', async t => {
  const { filename } = await fixture(t);
  for (const path of ['', ` ${'x'.repeat(4096)}`, `x\0y`, null]) {
    await assert.rejects(readRecoveryPlanFile(path), error => error.code === 'RECOVERY_INPUT_INVALID' && error.message === 'Recovery plan input is invalid.');
  }
  for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(readRecoveryPlanFile(filename, { maxBytes }), { code: 'RECOVERY_INPUT_INVALID' });
  }
  await assert.rejects(readRecoveryPlanFile(join(filename, 'missing')), { code: 'RECOVERY_INPUT_UNSAFE' });
});

test('rejects symlinks, hardlinks, non-regular files and shared permissions', async t => {
  const value = await fixture(t);
  const symbolic = join(value.root, 'symbolic.json');
  await symlink(value.filename, symbolic);
  await assert.rejects(readRecoveryPlanFile(symbolic), { code: 'RECOVERY_INPUT_UNSAFE' });
  const hardlink = join(value.root, 'hardlink.json');
  await link(value.filename, hardlink);
  await assert.rejects(readRecoveryPlanFile(value.filename), { code: 'RECOVERY_INPUT_UNSAFE' });
  await rm(hardlink);
  await chmod(value.filename, 0o640);
  await assert.rejects(readRecoveryPlanFile(value.filename), { code: 'RECOVERY_INPUT_UNSAFE' });
  await chmod(value.filename, 0o600);
  await assert.rejects(readRecoveryPlanFile(value.root), { code: 'RECOVERY_INPUT_UNSAFE' });
});

test('rejects oversized and malformed JSON with fixed safe errors', async t => {
  const oversized = await fixture(t, '{"payload":"123456789"}');
  await assert.rejects(readRecoveryPlanFile(oversized.filename, { maxBytes: 8 }), error => error.code === 'RECOVERY_INPUT_TOO_LARGE' && !error.message.includes('payload'));
  const malformed = await fixture(t, '{invalid json');
  await assert.rejects(readRecoveryPlanFile(malformed.filename), error => error.code === 'RECOVERY_INPUT_JSON' && !error.message.includes('invalid'));
});

test('rejects invalid UTF-8 rather than parsing replacement characters', async t => {
  const { filename } = await fixture(t);
  await writeFile(filename, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), { mode: 0o600 });
  await chmod(filename, 0o600);
  await assert.rejects(readRecoveryPlanFile(filename), { code: 'RECOVERY_INPUT_ENCODING' });
});

test('honors caller cancellation before opening a file', async t => {
  const { filename } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  await assert.rejects(readRecoveryPlanFile(filename, { signal: controller.signal }, { openImpl: async () => { opened = true; } }), { code: 'RECOVERY_INPUT_ABORTED' });
  assert.equal(opened, false);
});

test('handles short reads and closes the descriptor', async t => {
  const { filename } = await fixture(t, '{"answer":42}');
  let reads = 0;
  let closed = false;
  const openImpl = async (path, flags) => {
    const handle = await open(path, flags);
    return {
      stat: (...args) => handle.stat(...args),
      read: (buffer, offset, length, position) => { reads++; return handle.read(buffer, offset, Math.min(length, 2), position); },
      close: async () => { closed = true; await handle.close(); }
    };
  };
  assert.deepEqual(await readRecoveryPlanFile(filename, {}, { openImpl }), { answer: 42 });
  assert.ok(reads > 1);
  assert.equal(closed, true);
});

test('rejects replacement, growth and truncation between checks and reads', async t => {
  const replacement = await fixture(t, '{"safe":true}');
  const next = join(replacement.root, 'replacement.json');
  await writeFile(next, '{"safe":false}', { mode: 0o600 });
  await chmod(next, 0o600);
  const replaceOpen = async (path, flags) => {
    await rename(next, path);
    return open(path, flags | constants.O_NOFOLLOW);
  };
  await assert.rejects(readRecoveryPlanFile(replacement.filename, {}, { openImpl: replaceOpen }), { code: 'RECOVERY_INPUT_UNSAFE' });

  const growing = await fixture(t, '{"safe":true}');
  let grew = false;
  const growOpen = async (path, flags) => wrapRead(await open(path, flags), async () => {
    if (!grew) { grew = true; await appendFile(path, ' '); }
  });
  await assert.rejects(readRecoveryPlanFile(growing.filename, {}, { openImpl: growOpen }), { code: 'RECOVERY_INPUT_CHANGED' });

  const shrinking = await fixture(t, '{"safe":true}');
  let shrunk = false;
  const shrinkOpen = async (path, flags) => wrapRead(await open(path, flags), async () => {
    if (!shrunk) { shrunk = true; await truncate(path, 1); }
  });
  await assert.rejects(readRecoveryPlanFile(shrinking.filename, {}, { openImpl: shrinkOpen }), { code: 'RECOVERY_INPUT_CHANGED' });
});

function wrapRead(handle, afterFirstRead) {
  let first = true;
  return {
    stat: (...args) => handle.stat(...args),
    read: async (...args) => {
      const result = await handle.read(...args);
      if (first) { first = false; await afterFirstRead(); }
      return result;
    },
    close: () => handle.close()
  };
}
