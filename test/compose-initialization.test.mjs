import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const composePath = new URL('../compose.yaml', import.meta.url);

async function initializer() {
  const source = await readFile(composePath, 'utf8');
  const config = parse(source);
  const service = config.services['state-init'];
  assert.deepEqual(service.entrypoint, ['node', '-e']);
  assert.equal(service.command.length, 1);
  return { config, service, code: service.command[0] };
}

function fakeFilesystem({ directory = true, symlink = false, uid = 0, gid = 0, mode = 0o755,
  failAt, final = {} } = {}) {
  const calls = [];
  let state = { directory, symlink, uid, gid, mode, dev: 1, ino: 42 };
  let statCount = 0;
  const fs = {
    lstatSync(path) {
      calls.push(['lstatSync', path]);
      statCount += 1;
      if (failAt === 'lstat') throw new Error('lstat failed');
      if (path !== '/state') throw new Error('unsafe state path');
      const snapshot = statCount > 1 ? { ...state, ...final } : state;
      return {
        uid: snapshot.uid, gid: snapshot.gid, mode: snapshot.mode, dev: snapshot.dev, ino: snapshot.ino,
        isDirectory: () => snapshot.directory,
        isSymbolicLink: () => snapshot.symlink,
      };
    },
    lchownSync(path, nextUid, nextGid) {
      calls.push(['lchownSync', path, nextUid, nextGid]);
      if (failAt === 'chown') throw new Error('chown failed');
      state = { ...state, uid: nextUid, gid: nextGid };
    },
    chmodSync(path, nextMode) {
      calls.push(['chmodSync', path, nextMode]);
      if (failAt === 'chmod') throw new Error('chmod failed');
      state = { ...state, mode: nextMode };
    },
  };
  return { fs, calls };
}

async function runInitializer(options) {
  const { config, service, code } = await initializer();
  const fake = fakeFilesystem(options);
  assert.equal(config.services['mail-agent'].user, '1000:1000');
  assert.equal(service.user, '0:0');
  assert.equal(service.network_mode, 'none');
  assert.equal(service.read_only, true);
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.deepEqual(service.cap_add, ['CHOWN', 'FOWNER']);
  assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(service.volumes, ['agent-state:/state']);
  assert.equal(service.restart, 'no');
  runInNewContext(code, { require: name => {
    assert.equal(name, 'node:fs');
    return fake.fs;
  } });
  return fake.calls;
}

test('state initializer uses Node and applies owner and private mode to the real state directory', async () => {
  const calls = await runInitializer({ uid: 1000, gid: 1000, mode: 0o700 });
  assert.deepEqual(calls, [
    ['lstatSync', '/state'],
    ['lchownSync', '/state', 1000, 1000],
    ['chmodSync', '/state', 0o700],
    ['lstatSync', '/state'],
  ]);
});

test('state initializer rejects a symlink or non-directory without changing it', async () => {
  for (const options of [{ symlink: true }, { directory: false }]) {
    const { code } = await initializer();
    const fake = fakeFilesystem(options);
    assert.throws(() => runInNewContext(code, { require: () => fake.fs }));
    assert.equal(fake.calls.some(([name]) => name === 'lchownSync' || name === 'chmodSync'), false);
  }
});

test('state initializer fails closed when ownership or mode changes fail', async () => {
  for (const failAt of ['lstat', 'chown', 'chmod']) {
    const { code } = await initializer();
    const fake = fakeFilesystem({ failAt });
    assert.throws(() => runInNewContext(code, { require: () => fake.fs }), failAt);
  }
});

test('state initializer verifies resulting owner, group, mode, and directory type', async () => {
  for (const final of [{ uid: 1 }, { gid: 2 }, { mode: 0o750 }, { directory: false }, { symlink: true }, { dev: 2 }, { ino: 43 }]) {
    const { code } = await initializer();
    const fake = fakeFilesystem({ final });
    assert.throws(() => runInNewContext(code, { require: () => fake.fs }));
  }
});

// /state is a fixed mounted volume path on a read-only container root, so an unprivileged volume user cannot rename the mountpoint during this one-shot initializer.
