import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';
import { loadConfig } from '../src/config.mjs';
import { mailboxIdentity } from '../src/state-identity.mjs';
import { digest } from '../src/policy.mjs';
import { previewRecoveryRelease, applyRecoveryRelease } from '../src/recovery-release.mjs';

const now = 1_800_000_200_000, clock = () => now;
const snapshotId = '00000000-0000-4000-8000-000000000199';
const hold = JSON.stringify({ snapshotId, snapshotCreatedAt: now - 2000, restoredAt: now - 1000 });
const cursor = JSON.stringify({ url: 'https://graph.microsoft.com/v1.0/users/assistant%40example.org/mailFolders/inbox/messages/delta?$deltatoken=SYNTHETIC_KILL_CURSOR', initialComplete: true });
const actor = 'operator@example.org', reason = 'Synthetic process termination drill';
const configPath = new URL('../examples/text-inbox/agent.yaml', import.meta.url).pathname;

async function baseFixture(t) {
  const stateRoot = await mkdtemp(join(tmpdir(), 'ma-release-process-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const loaded = await loadConfig(configPath, { env: {} });
  const config = { ...loaded.config, state_root: stateRoot }, identity = mailboxIdentity(config), configHash = 'b'.repeat(64);
  const binding = digest([identity, hold, cursor]);
  const store = openStore(stateRoot, { identity, clock });
  store.setMeta('restore_hold', hold); store.setMeta('cursor', cursor); store.close();
  const plan = { format: 1, mode: 'continuity', mailboxIdentity: identity, snapshotId, binding, configHash,
    coverage: { from: now - 2000, through: now, oldOwnerStoppedAt: now - 1500, evidenceHash: 'c'.repeat(64), allSources: true },
    acceptHistoryGap: false };
  return { stateRoot, identity, configHash, config, plan, loaded };
}

function inspect(root, identity) {
  const store = openStore(root, { identity, clock });
  try {
    return { hold: store.getMeta('restore_hold'), cursor: store.getMeta('cursor'),
      stage: store.getMeta(`recovery_release_stage:${digest([identity, hold, cursor])}`),
      receiptKeys: store.listMetaKeys?.('recovery_release_receipt:') };
  } finally { store.close(); }
}

function auditCount(root) {
  const db = new DatabaseSync(join(root, 'agent.sqlite'), { readOnly: true, allowExtension: false });
  try { return db.prepare("SELECT COUNT(*) AS count FROM audit WHERE event='recovery-release'").get().count; }
  finally { db.close(); }
}

function childScript() {
  return new URL(import.meta.url).pathname;
}

async function launchAndKill(t, args) {
  const child = fork(childScript(), ['--child', ...args], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  let killed = false;
  t.after(() => { if (!killed && child.exitCode === null) child.kill('SIGKILL'); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Child did not reach the injected crash point.')), 10_000);
    child.once('message', value => { clearTimeout(timer); value?.ready ? resolve() : reject(new Error('Child reported failure before crash point.')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exited before crash point (${code}).`)); });
  });
  assert.equal(ready, undefined);
  killed = true;
  child.kill('SIGKILL');
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Killed child did not exit promptly.')), 10_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(exit.signal, 'SIGKILL');
}

async function childMain() {
  const [, , , scenario, root, identity, configHash, expectedReviewDigest] = process.argv;
  const loaded = await loadConfig(configPath, { env: {} });
  const config = { ...loaded.config, state_root: root };
  const binding = digest([identity, hold, cursor]);
  const continuity = { format: 1, mode: 'continuity', mailboxIdentity: identity, snapshotId, binding, configHash,
    coverage: { from: now - 2000, through: now, oldOwnerStoppedAt: now - 1500, evidenceHash: 'c'.repeat(64), allSources: true },
    acceptHistoryGap: false };
  if (scenario === 'before-commit') {
    const transactionHold = async (request, callback) => {
      const { withRecoveryStore } = await import('../src/recovery-state.mjs');
      return withRecoveryStore(request, (store, descriptor) => callback(new Proxy(store, { get(target, key) {
        if (key === 'transaction') return transaction => target.transaction(() => {
          const result = transaction();
          process.send({ ready: true });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          return result;
        });
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      } }), descriptor));
    };
    await applyRecoveryRelease({ stateRoot: root, identity, configHash, config, plan: continuity, actor, reason, clock, expectedReviewDigest },
      { withStore: transactionHold });
    return;
  }
  const plan = { ...continuity, mode: 'history-gap', acceptHistoryGap: true };
  await previewRecoveryRelease({ stateRoot: root, identity, configHash, config, plan, actor, reason, clock }, {
    graphFactory: () => ({ poll: () => new Promise(resolve => {
      process.send({ ready: true }, () => { /* remain blocked until the parent terminates this process */ });
      void resolve;
    }) })
  });
}

if (process.argv[2] === '--child') {
  childMain().catch(() => { process.send?.({ ready: false }); process.exitCode = 1; });
} else {
  test('SIGKILL after final release writes but before COMMIT preserves the held checkpoint', async t => {
    const f = await baseFixture(t);
    const config = { ...f.config, state_root: f.stateRoot };
    const preview = await previewRecoveryRelease({ stateRoot: f.stateRoot, identity: f.identity, configHash: f.configHash,
      config, plan: f.plan, actor, reason, clock });
    await launchAndKill(t, ['before-commit', f.stateRoot, f.identity, f.configHash, preview.reviewDigest]);
    assert.equal(inspect(f.stateRoot, f.identity).hold, hold);
    assert.equal(inspect(f.stateRoot, f.identity).cursor, cursor);
    assert.equal(auditCount(f.stateRoot), 0);
    const store = openStore(f.stateRoot, { identity: f.identity, clock });
    try { assert.equal(store.getMeta(`recovery_release_receipt:${preview.reviewDigest}`), undefined); }
    finally { store.close(); }
  });

  test('SIGKILL during history-gap baseline leaves no new cursor or published release stage', async t => {
    const f = await baseFixture(t);
    await launchAndKill(t, ['baseline', f.stateRoot, f.identity, f.configHash, 'unused']);
    const state = inspect(f.stateRoot, f.identity);
    assert.equal(state.hold, hold);
    assert.equal(state.cursor, cursor);
    assert.equal(state.stage, undefined);
    assert.equal(auditCount(f.stateRoot), 0);
  });
}
