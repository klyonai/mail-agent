import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { runCli } from '../src/cli.mjs';
import { connectControl, listenControl } from '../src/control.mjs';

const actionKey = 'a'.repeat(64);
const receipt = {
  format: 1, source: 'mail-agent-records', agentId: 'assistant', mailbox: 'bot@example.org', connection: 'records',
  operationId: actionKey, tool: 'records.apply_approved_update', argsHash: 'b'.repeat(64), recordId: 'case-1',
  expectedRevision: 1, expectedRecordHash: 'c'.repeat(64), proposalDigest: 'd'.repeat(64),
  status: 'committed', revision: 2, recordHash: 'e'.repeat(64), inspectedAt: 1_800_000_000_000,
};
const operator = { actor: 'operator@example.org', reason: 'Inspected the exact durable adapter operation.' };
const intent = {
  format: 1, agentId: receipt.agentId, mailbox: receipt.mailbox, connection: receipt.connection,
  operationId: actionKey, tool: receipt.tool, argsHash: receipt.argsHash, recordId: receipt.recordId,
  expectedRevision: receipt.expectedRevision, expectedRecordHash: receipt.expectedRecordHash, proposalDigest: receipt.proposalDigest,
  policyHash: 'f'.repeat(64), actorHash: 'a'.repeat(64), approverHash: 'b'.repeat(64), approvalReasonHash: 'c'.repeat(64),
  approvalExpiresAt: 1_800_000_300_000, issuedAt: 1_800_000_000_000,
};

function output() {
  let value = '';
  return { write(text) { value += text; }, value() { return value; } };
}

async function bundle(t) {
  const root = await mkdtemp(join(tmpdir(), 'ma-records-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'bundle');
  assert.equal(await runCli(['init', '--directory', directory, '--recipe', 'text-inbox'], { stdout: output() }), 0);
  return { root, config: join(directory, 'agent.yaml'), filename: join(root, 'receipt.json') };
}

function command(config, filename) {
  return ['reconcile-records', '--config', config, '--action', actionKey, '--receipt', filename,
    '--actor', operator.actor, '--reason', operator.reason];
}

test('records reconciliation help documents the explicit receipt command', async () => {
  const stdout = output();
  assert.equal(await runCli(['--help'], { stdout }), 0);
  assert.match(stdout.value(), /reconcile-records --config FILE --action HASH --receipt FILE --actor ADDRESS --reason TEXT/);
  assert.match(stdout.value(), /records-intent --config FILE --action HASH --actor ADDRESS --reason TEXT/);
});

function intentCommand(config) {
  return ['records-intent', '--config', config, '--action', actionKey, '--actor', operator.actor, '--reason', operator.reason];
}

test('intent command emits exact content-free JSON through operator runtime without receipt access', async t => {
  const { config } = await bundle(t);
  const seen = [], stdout = output(), stderr = output();
  assert.equal(await runCli(intentCommand(config), { env: {}, stdout, stderr,
    parseReceiptFile: async () => { throw new Error('Intent must not read receipt files.'); },
    createRuntime: async settings => {
      seen.push(['runtime', settings.mode]);
      return { recordsIntent: async params => { seen.push(['intent', params]); return intent; },
        stop: async () => { seen.push(['stop']); } };
    },
  }), 0);
  assert.deepEqual(seen, [['runtime', 'operator'], ['intent', { actionKey, ...operator }], ['stop']]);
  assert.deepEqual(JSON.parse(stdout.value()), intent);
  assert.equal(stderr.value(), '');
});

test('intent command rejects malformed inputs and receipt options before runtime access', async () => {
  let runtimes = 0;
  const services = { stdout: output(), stderr: output(), createRuntime: async () => { runtimes += 1; } };
  const valid = intentCommand('unused');
  for (const argv of [valid.slice(0, 7), [...valid, '--receipt', 'private.json'],
    valid.map((value, index) => index === 4 ? 'wrong' : value),
    valid.map((value, index) => index === 6 ? 'wrong' : value),
    valid.map((value, index) => index === 8 ? 'x'.repeat(2049) : value)]) {
    assert.equal(await runCli(argv, services), 1);
  }
  assert.equal(runtimes, 0);
});

test('intent lookup failure stops runtime and hides private diagnostics without a receipt hint', async t => {
  const { config } = await bundle(t);
  let stops = 0;
  const stdout = output(), stderr = output();
  assert.equal(await runCli(intentCommand(config), { stdout, stderr,
    createRuntime: async () => ({ recordsIntent: async () => { throw new Error('PRIVATE_INTENT_DETAIL'); },
      stop: async () => { stops += 1; } }),
  }), 1);
  assert.equal(stops, 1);
  assert.equal(stdout.value(), '');
  assert.doesNotMatch(stderr.value(), /PRIVATE_INTENT_DETAIL|receipt/);
});

test('CLI validates options before receipt reads or runtime construction', async () => {
  let reads = 0, runtimes = 0;
  const stderr = output();
  const services = { stdout: output(), stderr, parseReceiptFile: async () => { reads += 1; },
    createRuntime: async () => { runtimes += 1; } };
  const valid = command('unused', 'PRIVATE_RECEIPT_PATH');
  const cases = [valid.filter((_, index) => ![4, 5].includes(index)),
    [...valid, '--extra', 'PRIVATE_SENTINEL'], [...valid, '--action', actionKey],
    valid.map((value, index) => index === 4 ? 'A'.repeat(64) : value),
    valid.map((value, index) => index === 8 ? 'invalid-actor' : value),
    valid.map((value, index) => index === 10 ? ' ' : value),
    valid.map((value, index) => index === 10 ? 'x'.repeat(2049) : value)];
  for (const argv of cases) assert.equal(await runCli(argv, services), 1);
  assert.equal(reads, 0);
  assert.equal(runtimes, 0);
  assert.doesNotMatch(stderr.value(), /PRIVATE_/);
});

test('CLI privately reads receipt before operator runtime and forwards exact reconciliation once', async t => {
  const { config, filename } = await bundle(t);
  const seen = [];
  const stdout = output(), stderr = output();
  assert.equal(await runCli(command(config, filename), { env: {}, stdout, stderr,
    parseReceiptFile: async path => { seen.push(['read', path]); return receipt; },
    createRuntime: async settings => {
      seen.push(['runtime', settings.mode]);
      return { reconcileRecords: async params => { seen.push(['reconcile', params]); return { status: 'committed', actionKey }; },
        stop: async () => { seen.push(['stop']); } };
    },
  }), 0);
  assert.deepEqual(seen, [['read', resolve(filename)], ['runtime', 'operator'],
    ['reconcile', { actionKey, receipt, ...operator }], ['stop']]);
  assert.equal(stderr.value(), '');
  assert.deepEqual(JSON.parse(stdout.value()), { status: 'committed', actionKey });
  assert.doesNotMatch(stdout.value(), /case-1|bot@example/);
});

test('receipt reader failure prevents runtime access and hides private diagnostics', async t => {
  const { config, filename } = await bundle(t);
  let runtimes = 0;
  const stdout = output(), stderr = output();
  assert.equal(await runCli(command(config, filename), { stdout, stderr,
    parseReceiptFile: async () => { throw new Error('PRIVATE_RECEIPT_CONTENT'); },
    createRuntime: async () => { runtimes += 1; },
  }), 1);
  assert.equal(runtimes, 0);
  assert.equal(stdout.value(), '');
  assert.doesNotMatch(stderr.value(), /PRIVATE_RECEIPT_CONTENT/);
});

test('runtime reconciliation failure closes the operator scope and omits private diagnostics', async t => {
  const { config, filename } = await bundle(t);
  let stops = 0;
  const stdout = output(), stderr = output();
  assert.equal(await runCli(command(config, filename), { stdout, stderr,
    parseReceiptFile: async () => receipt,
    createRuntime: async () => ({ reconcileRecords: async () => { throw new Error('PRIVATE_LEDGER_DETAIL'); },
      stop: async () => { stops += 1; } }),
  }), 1);
  assert.equal(stops, 1);
  assert.equal(stdout.value(), '');
  assert.doesNotMatch(stderr.value(), /PRIVATE_LEDGER_DETAIL/);
});

test('default receipt reader rejects unsafe input before runtime access', async t => {
  const { config, filename } = await bundle(t);
  await writeFile(filename, JSON.stringify(receipt), { mode: 0o644 });
  await chmod(filename, 0o644);
  let runtimes = 0;
  assert.equal(await runCli(command(config, filename), { stdout: output(), stderr: output(), env: {},
    createRuntime: async () => { runtimes += 1; },
  }), 1);
  assert.equal(runtimes, 0);
});

test('default private receipt reader forwards the inspected content-free receipt', async t => {
  const { config, filename } = await bundle(t);
  await writeFile(filename, JSON.stringify(receipt), { mode: 0o600 });
  let received;
  assert.equal(await runCli(command(config, filename), { stdout: output(), stderr: output(), env: {},
    createRuntime: async () => ({ reconcileRecords: async params => { received = params; return { status: 'committed' }; } }),
  }), 0);
  assert.deepEqual(received, { actionKey, receipt, ...operator });
});

async function controlFixture(t, handlers) {
  const root = await mkdtemp(join(tmpdir(), 'ma-rr-'));
  await chmod(root, 0o700);
  await writeFile(join(root, 'owner.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await listenControl(root, handlers);
  t.after(() => server.close());
  return connectControl(root);
}

test('private control forwards only exact validated reconciliation and leaves send resolve unchanged', async t => {
  const calls = [];
  const proxy = await controlFixture(t, {
    reconcileRecords: async params => { calls.push(params); return { status: 'committed', actionKey }; },
    resolve: async params => ({ resolved: params.runId, outcome: params.outcome }),
  });
  assert.deepEqual(await proxy.reconcileRecords({ actionKey, receipt, ...operator }), { status: 'committed', actionKey });
  assert.deepEqual(calls, [{ actionKey, receipt, ...operator }]);
  for (const params of [{ actionKey: 'wrong', receipt, ...operator }, { actionKey, receipt, ...operator, extra: true },
    { actionKey, receipt: { ...receipt, body: 'PRIVATE' }, ...operator },
    { actionKey, receipt: { ...receipt, revision: -1 }, ...operator },
    { actionKey, receipt, ...operator, reason: 'x'.repeat(2049) }]) {
    await assert.rejects(proxy.reconcileRecords(params), /Invalid control request/);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(await proxy.resolve({ runId: 'run-1', outcome: 'sent', ...operator }), { resolved: 'run-1', outcome: 'sent' });
});

test('private control retains safe reconciliation denial and suppresses unexpected details', async t => {
  let calls = 0;
  const proxy = await controlFixture(t, { reconcileRecords: async () => {
    calls += 1;
    throw new Error(calls === 1 ? 'Records reconciliation denied.' : 'PRIVATE_ADAPTER_DETAIL');
  } });
  await assert.rejects(proxy.reconcileRecords({ actionKey, receipt, ...operator }), /^Error: Records reconciliation denied\.$/);
  await assert.rejects(proxy.reconcileRecords({ actionKey, receipt, ...operator }), /^Error: Control operation failed$/);
});

test('private control intent lookup validates exact attribution and returns the unchanged intent', async t => {
  const calls = [];
  const proxy = await controlFixture(t, { recordsIntent: async params => { calls.push(params); return intent; } });
  assert.deepEqual(await proxy.recordsIntent({ actionKey, ...operator }), intent);
  assert.deepEqual(calls, [{ actionKey, ...operator }]);
  for (const params of [{ actionKey: 'wrong', ...operator }, { actionKey, ...operator, receipt },
    { actionKey, ...operator, actor: 'wrong' }, { actionKey, ...operator, reason: '' },
    { actionKey, ...operator, reason: 'x'.repeat(2049) }]) {
    await assert.rejects(proxy.recordsIntent(params), /Invalid control request/);
  }
  assert.equal(calls.length, 1);
});

test('control server independently rejects receipt injection from a raw socket client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ma-rr-raw-'));
  await chmod(root, 0o700);
  await writeFile(join(root, 'owner.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const server = await listenControl(root, { reconcileRecords: async () => { calls += 1; return {}; } });
  t.after(() => server.close());
  const response = await new Promise((resolveResponse, reject) => {
    const socket = createConnection(join(root, 'control.sock'));
    let reply = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ method: 'reconcileRecords', params: {
      actionKey, receipt: { ...receipt, privateBody: 'PRIVATE_RECEIPT_CONTENT' }, ...operator,
    } })}\n`));
    socket.on('data', chunk => { reply += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolveResponse(JSON.parse(reply)));
  });
  assert.deepEqual(response, { ok: false, error: 'Invalid control request' });
  assert.equal(calls, 0);
});
