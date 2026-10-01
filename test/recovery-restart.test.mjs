import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { mailboxIdentity } from '../src/state-identity.mjs';
import { digest } from '../src/policy.mjs';

const config = {
  id: 'recovery-restart-test', state_root: 'state',
  mailbox: { address: 'agent@example.test', tenant_id: 'synthetic-tenant', client_id: 'synthetic-client' },
  model: { capabilities: { tools: false } }, mcp: {},
  policy: { senders: ['sender@example.test'], recipients: ['sender@example.test'], approvers: ['admin@example.test'], tools: {} },
  limits: { model_calls: 6, tool_calls: 10, run_seconds: 120, context_tokens: 16000, output_tokens: 2000, queue_messages: 100 },
  retention: { content_hours: 24, audit_days: 30 }
};
const recovery = outcome => ({ outcome, binding: 'a'.repeat(64), planDigest: 'b'.repeat(64), evidenceHash: 'c'.repeat(64) });
const statuses = { sent: 'completed', skip: 'failed', fenced: 'uncertain' };
const record = (id, outcome, extra = {}) => ({ id, messageKey: digest([config.id, id]), conversationKey: digest(id), sequence: 1,
  createdAt: 10, status: statuses[outcome], recovery: recovery(outcome), budget: { modelCalls: 2, toolCalls: 1, activeMs: 5 }, ...extra });

async function fixture(t, runs, actions = []) {
  const root = await mkdtemp(join(tmpdir(), 'ma-recovery-restart-'));
  const stateRoot = join(root, config.state_root);
  const identity = mailboxIdentity(config);
  const store = openStore(stateRoot, { identity, clock: () => 20 });
  for (const run of runs) store.saveRun(run);
  for (const action of actions) store.saveAction(action);
  store.close();
  const instances = [], calls = { model: 0, mail: 0, mcp: 0 };
  t.after(async () => {
    for (const runtime of instances) await runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { root, stateRoot, calls,
    restart: async () => {
      for (const runtime of instances) await runtime.stop();
      const runtime = await createRuntime({ config, root, instructions: 'Synthetic restart test.', hash: 'synthetic', clock: () => 30,
        model: { step: async () => { calls.model++; throw new Error('Unexpected inference'); } },
        mail: { reply: async () => { calls.mail++; throw new Error('Unexpected delivery'); } },
        mcp: { call: async () => { calls.mcp++; throw new Error('Unexpected tool effect'); } } });
      instances.push(runtime);
      return runtime;
    },
    inspect: () => {
      const current = openStore(stateRoot, { identity, clock: () => 30 });
      try { return Object.fromEntries(runs.map(run => [run.id, current.getRun(run.id)])); } finally { current.close(); }
    }
  };
}

test('released conservative recovery records retain unknown budgets and reservations across repeated restarts', async t => {
  const runs = [
    record('missing-budget', 'skip', { budget: undefined, activeOperation: { reservedMs: 40 } }),
    record('null-budget', 'fenced', { budget: null, activeOperation: { reservedMs: 'unknown' }, uncertainty: { kind: 'restore' } }),
    record('bad-reservation', 'sent', { activeOperation: { reservedMs: -1 } }),
    record('overflow', 'fenced', { budget: { modelCalls: 1, toolCalls: 1, activeMs: Number.MAX_SAFE_INTEGER }, activeOperation: { reservedMs: 1 } })
  ];
  const f = await fixture(t, runs);
  const before = f.inspect();
  for (let attempt = 0; attempt < 2; attempt++) {
    const runtime = await f.restart();
    assert.equal(runtime.status().recovery, null);
    await runtime.stop();
    assert.deepEqual(f.inspect(), before);
  }
  assert.deepEqual(f.calls, { model: 0, mail: 0, mcp: 0 });
});

test('conservative terminal decisions remain unchanged when unresolved write actions are recovered', async t => {
  const runs = [record('accepted', 'sent', { activeOperation: { reservedMs: 'unknown' } }), record('abandoned', 'skip', { budget: undefined })];
  const f = await fixture(t, runs, [
    { key: 'accepted-write', runId: 'accepted', state: 'executing', effect: 'write' },
    { key: 'abandoned-write', runId: 'abandoned', state: 'uncertain', effect: 'write' }
  ]);
  const runtime = await f.restart();
  await runtime.stop();
  const records = f.inspect();
  assert.equal(records.accepted.status, 'completed');
  assert.equal(records.abandoned.status, 'failed');
  assert.equal(records.accepted.uncertainty, undefined);
  assert.equal(records.abandoned.budget, undefined);
  assert.deepEqual(records.accepted.recovery, recovery('sent'));
  assert.deepEqual(f.calls, { model: 0, mail: 0, mcp: 0 });
});

test('valid ordinary reservations retain restart accounting and conservative valid reservations charge only once', async t => {
  const ordinary = { ...record('ordinary', 'skip', { status: 'running', activeOperation: { reservedMs: 40 } }), recovery: undefined };
  const accepted = record('accepted', 'sent', { activeOperation: { reservedMs: 40 } });
  const f = await fixture(t, [ordinary, accepted]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const runtime = await f.restart();
    await runtime.stop();
    const records = f.inspect();
    assert.equal(records.ordinary.status, 'queued');
    assert.equal(records.accepted.status, 'completed');
    for (const record of Object.values(records)) {
      assert.deepEqual(record.budget, { modelCalls: 2, toolCalls: 1, activeMs: 45 });
      assert.equal(record.activeOperation, undefined);
    }
  }
  assert.deepEqual(f.calls, { model: 0, mail: 0, mcp: 0 });
});
