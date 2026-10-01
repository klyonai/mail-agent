import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection, createServer } from 'node:net';
import { chmod, lstat, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectControl, listenControl, readHealth } from '../src/control.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ma-ctl-'));
  await chmod(root, 0o700);
  await writeFile(join(root, 'owner.lock'), JSON.stringify({ pid: process.pid, token: 'synthetic' }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function handlers(overrides = {}) {
  return {
    status: async () => ({ ready: true }), approvals: async () => [],
    approve: async (input) => ({ approved: input.id }),
    resolve: async (input) => ({ resolved: input.runId }),
    liveCheck: async () => ({ live: true }), ...overrides,
  };
}

test('stopped health is read-only and distinguishes unsafe control paths', async t => {
  const root=await fixture(t);
  const before=await readdir(root);
  assert.deepEqual(await readHealth(root),{live:false,ready:false,reason:'not-running'});
  assert.deepEqual(await readdir(root),before);
  assert.deepEqual(await readHealth(join(root,'missing')),{live:false,ready:false,reason:'not-running'});
  await assert.rejects(lstat(join(root,'missing')),{code:'ENOENT'});
  await symlink('/tmp/unsafe-health-target',join(root,'control.sock'));
  assert.deepEqual(await readHealth(root),{live:false,ready:false,reason:'control-unavailable'});
});

socketTest('health and bounded metadata options use the private socket',async t=>{
  const root=await fixture(t);
  let received;
  const server=await listenControl(root,handlers({health:()=>({live:true,ready:true}),status:params=>{received=params;return {runs:[]};}}));
  t.after(()=>server.close());
  assert.deepEqual(await readHealth(root),{live:true,ready:true});
  const proxy=await connectControl(root);
  await proxy.status({limit:10,after:'cursor-1',status:'uncertain'});
  assert.deepEqual(received,{limit:10,after:'cursor-1',status:'uncertain'});
  for(const params of [{limit:101},{limit:0},{status:'unknown'},{after:'x'.repeat(1025)},{extra:true}]) {
    await assert.rejects(proxy.status(params),/Invalid control request/);
  }
});

function socketTest(name, callback) {
  test(name, async (t) => {
    try { await callback(t); }
    catch (error) {
      if (error.code === 'EPERM') t.skip('This environment blocks local Unix socket binding');
      else throw error;
    }
  });
}

async function raw(root, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(root, 'control.sock'));
    let reply = '';
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => { reply += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve(JSON.parse(reply)));
  });
}

socketTest('private control proxy supports only operator methods and cleanup keeps daemon running', async (t) => {
  const root = await fixture(t);
  const server = await listenControl(root, handlers());
  t.after(() => server.close());
  const proxy = await connectControl(root);
  assert.deepEqual(await proxy.status(), { ready: true });
  assert.deepEqual(await proxy.approvals(), []);
  assert.deepEqual(await proxy.approve({ id: 'action-1', actor: 'operator@example.test', reason: 'Reviewed' }), { approved: 'action-1' });
  assert.deepEqual(await proxy.resolve({ runId: 'run-1', outcome: 'sent', actor: 'operator@example.test', reason: 'Verified' }), { resolved: 'run-1' });
  assert.deepEqual(await proxy.liveCheck(), { live: true });
  await proxy.stop();
  assert.deepEqual(await proxy.status(), { ready: true });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'control.sock'))).mode & 0o777, 0o600);
});

socketTest('unknown methods and invalid arguments never reach handlers', async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const server = await listenControl(root, handlers({ approve: async () => { calls += 1; return {}; } }));
  t.after(() => server.close());
  assert.equal((await raw(root, '{"method":"constructor","params":{}}\n')).ok, false);
  assert.equal((await raw(root, '{"method":"stop"}\n')).ok, false);
  assert.equal((await raw(root, '{"method":"approve","params":{"id":"action-1","actor":"operator@example.test","reason":"ok","extra":"unexpected"}}\n')).ok, false);
  const proxy = await connectControl(root);
  await assert.rejects(proxy.approve({ id: 'action-1', actor: 'operator@example.test', reason: '' }), /Invalid control request/);
  assert.equal(calls, 0);
});

socketTest('request/response size limits and handler failures omit private details', async (t) => {
  const root = await fixture(t);
  const server = await listenControl(root, handlers({
    status: async () => { throw new Error('private synthetic secret'); },
    approvals: async () => ['x'.repeat(1_048_576)],
  }));
  t.after(() => server.close());
  const oversize = await raw(root, `${'x'.repeat(65_537)}\n`);
  assert.equal(oversize.ok, false);
  const proxy = await connectControl(root);
  await assert.rejects(proxy.status(), /^Error: Control operation failed$/);
  await assert.rejects(proxy.approvals(), /Control response exceeded limit/);
});

socketTest('control startup rejects symlinks, live sockets, and absent state ownership', async (t) => {
  const root = await fixture(t);
  await symlink('/tmp/untrusted-control-target', join(root, 'control.sock'));
  await assert.rejects(listenControl(root, handlers()), /Unsafe control socket/);
  await rm(join(root, 'control.sock'));
  const server = await listenControl(root, handlers());
  t.after(() => server.close());
  await assert.rejects(listenControl(root, handlers()), /Control socket already active/);
  await rm(join(root, 'owner.lock'));
  await assert.rejects(listenControl(root, handlers()), /State ownership is required/);
});

socketTest('closing the server removes its socket and stale sockets can be recovered by the owner', async (t) => {
  const root = await fixture(t);
  const server = await listenControl(root, handlers());
  await server.close();
  await assert.rejects(lstat(join(root, 'control.sock')), { code: 'ENOENT' });
  // A crashed local process leaves a socket node with no listening endpoint.
  const stale = createServer();
  await new Promise((resolve, reject) => { stale.once('error', reject); stale.listen(join(root, 'stale.sock'), resolve); });
  const socketInfo = await lstat(join(root, 'stale.sock'));
  assert.equal(socketInfo.isSocket(), true);
  await rename(join(root, 'stale.sock'), join(root, 'control.sock'));
  await new Promise((resolve) => stale.close(resolve));
  const recovered = await listenControl(root, handlers());
  await recovered.close();
});

test('control socket path length fails explicitly without an outside fallback', async () => {
  await assert.rejects(listenControl(`/tmp/${'x'.repeat(100)}`, handlers()), /shorter state_root/);
});

socketTest('known authorization failures remain useful and permissive sockets are rejected', async (t) => {
  const root = await fixture(t);
  const server = await listenControl(root, handlers({
    approve: async () => { throw new Error('Approval authority expired or is not permitted.'); },
  }));
  t.after(() => server.close());
  const proxy = await connectControl(root);
  await assert.rejects(proxy.approve({ id: 'a', actor: 'operator@example.test', reason: 'Reviewed' }), /Approval authority expired or is not permitted/);
  await chmod(join(root, 'control.sock'), 0o666);
  await assert.rejects(proxy.status(), /Unsafe control socket/);
});

socketTest('control deadlines bound a handler that never settles', async (t) => {
  const root = await fixture(t);
  const server = await listenControl(root, handlers({ status: async () => new Promise(() => {}) }));
  t.after(() => server.close());
  const proxy = await connectControl(root);
  await assert.rejects(proxy.status(), /Control request timed out|Control response unavailable/);
});
