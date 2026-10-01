import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { createMcp } from '../src/mcp.mjs';

const now = 1_800_000_000_000;
const serverPath = fileURLToPath(new URL('../mcp/records/server.mjs', import.meta.url));
const seed = { format: 1, id: 'record-a', revision: 1, type: 'note', title: 'Current title',
  content: 'Synthetic current content', tags: ['alpha'], source: { kind: 'operator', referenceHash: 'a'.repeat(64) },
  createdAt: now - 1000, updatedAt: now - 1000, updatedByHash: 'b'.repeat(64), deleted: false };

function configFor(root, recordsRoot, policyFile, clockFile) {
  return {
    id: 'records-agent', state_root: './state',
    mailbox: { address: 'agent@example.test', tenant_id: 'synthetic-tenant', client_id: 'synthetic-client',
      sender_authentication: { mode: 'exchange-authenticated', transport_headers_verified: true }, poll_seconds: 30 },
    model: { name: 'synthetic-model', capabilities: { tools: true } },
    instructions: {}, mcp: { records: { transport: 'stdio', command: process.execPath, pinned_version: 'synthetic-1',
      authorization_scope: 'sender-group', actor_context: 'mail-agent-v1', env: [], timeout_ms: 5000,
      args: ['--import', clockFile, serverPath, '--root', recordsRoot, '--policy', policyFile] } },
    policy: { senders: ['alice@example.test'], recipients: ['alice@example.test'], approvers: ['operator@example.test'], reply: 'sender',
      tools: {
        'records.get': { effect: 'read', authorization: 'automatic' },
        'records.propose_update': { effect: 'read', authorization: 'automatic' },
        'records.apply_approved_update': { effect: 'write', authorization: 'approval' },
      } },
    limits: { model_calls: 6, tool_calls: 10, run_seconds: 120, context_tokens: 16000, output_tokens: 2000, queue_messages: 100 },
    retention: { content_hours: 24, audit_days: 30 },
  };
}

function actorPolicy() {
  return { version: 1, agentId: 'records-agent', mailbox: 'agent@example.test', connection: 'records',
    members: { 'alice@example.test': { read: ['record-a'], edit: ['record-a'], delete: [] } },
    approvers: ['operator@example.test'] };
}

async function fixture(t, { loseWriteResponse = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'records-email-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordsRoot = join(root, 'records-store');
  const recordDirectory = join(recordsRoot, 'records', seed.id);
  await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(recordsRoot, 0o700);
  await chmod(join(recordsRoot, 'records'), 0o700);
  await chmod(recordDirectory, 0o700);
  await writeFile(join(recordDirectory, 'record.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  const policyFile = join(root, 'records-policy.json');
  await writeFile(policyFile, `${JSON.stringify(actorPolicy())}\n`, { mode: 0o600 });
  const clockFile = join(root, 'fixed-clock.mjs');
  await writeFile(clockFile, `Date.now = () => ${now};\n`, { mode: 0o600 });
  const config = configFor(root, recordsRoot, policyFile, clockFile);
  const modelState = { calls: 0 };
  const model = { async step({ messages }) {
    modelState.calls++;
    if (modelState.calls === 1) return { text: '', toolCalls: [{ id: 'proposal-call', name: 'records.propose_update',
      args: { recordId: seed.id, expectedRevision: 1, patch: { title: 'Approved title', content: 'Approved synthetic content' } } }] };
    if (modelState.calls === 2) {
      const proposal = proposalFrom(messages);
      return { text: '', toolCalls: [{ id: 'apply-call', name: 'records.apply_approved_update', args: {
        recordId: proposal.recordId, expectedRevision: proposal.expectedRevision, expectedRecordHash: proposal.expectedRecordHash,
        patch: proposal.patch, proposalDigest: proposal.proposalDigest,
      } }] };
    }
    return { text: 'The approved record update is complete.', toolCalls: [] };
  } };
  const mail = { async reply() { return { status: 'accepted' }; } };
  const makeMcp = () => {
    const real = createMcp(config.mcp, { root, env: {}, clock: () => now });
    let lose = loseWriteResponse;
    return {
      listTools: options => real.listTools(options),
      async call(name, args, options) {
        const result = await real.call(name, args, options);
        if (lose && name === 'records.apply_approved_update') {
          lose = false;
          throw new Error('Synthetic response lost after the records adapter committed.');
        }
        return result;
      },
      close: () => real.close(),
    };
  };
  let currentMcp;
  const create = async () => {
    currentMcp = makeMcp();
    const runtime = await createRuntime({ config, root, instructions: 'Only make the approved record update.', hash: 'synthetic-config',
      clock: () => now, env: {}, model, mail, mcp: currentMcp });
    runtimes.push(runtime);
    return runtime;
  };
  const runtimes = [];
  const runtime = await create();
  t.after(async () => { for (const instance of [...runtimes].reverse()) await instance.stop().catch(() => {}); });
  return { root, recordsRoot, recordDirectory, policyFile, config, modelState, runtime, create, makeMcp, getMcp: () => currentMcp };
}

function proposalFrom(messages) {
  for (const message of [...messages].reverse()) {
    for (const part of [...(message.content ?? [])].reverse()) {
      if (part.type !== 'tool-result' || part.toolName !== 'records.propose_update') continue;
      const value = part.output?.value;
      const text = value?.content?.find(item => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('Expected the first-party proposal result.');
      return JSON.parse(text);
    }
  }
  throw new Error('The model did not receive a records proposal.');
}

function email() {
  return { id: 'message-1', conversationId: 'conversation-1', sender: 'alice@example.test', replyTo: 'alice@example.test',
    to: ['agent@example.test'], cc: [], subject: 'Update this record', body: 'Set the record title to Approved title.',
    receivedAt: '2026-10-01T00:00:00Z', authenticated: true, autoGenerated: false, attachments: false };
}

async function currentRecord(value) { return JSON.parse(await readFile(join(value.recordDirectory, 'record.json'), 'utf8')); }
async function operationFiles(value) { return readdir(join(value.recordsRoot, 'operations')).catch(() => []); }

test('email approval commits one first-party record revision and restart deduplicates the write', async t => {
  const value = await fixture(t);
  assert.equal((await value.runtime.processMessage(email())).status, 'awaiting_approval');
  const [approval] = await value.runtime.approvals();
  assert.ok(approval.id);
  await value.runtime.approve({ id: approval.id, actor: 'operator@example.test', reason: 'Approve the exact synthetic update.' });
  assert.equal((await value.runtime.processMessage(email())).status, 'completed');
  const updated = await currentRecord(value);
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'Approved title');
  assert.equal(updated.content, 'Approved synthetic content');
  const files = await operationFiles(value);
  assert.equal(files.filter(file => file.endsWith('.receipt.json')).length, 1);
  assert.equal(files.filter(file => file.endsWith('.intent.json')).length, 1);
  const firstModelCallCount = value.modelState.calls;
  await value.runtime.stop();
  const restarted = await value.create();
  assert.equal((await restarted.processMessage(email())).status, 'completed');
  assert.equal((await currentRecord(value)).revision, 2);
  assert.equal(value.modelState.calls, firstModelCallCount);
  assert.equal((await operationFiles(value)).filter(file => file.endsWith('.receipt.json')).length, 1);
});

test('lost MCP response is reconciled from the stopped first-party receipt without a second write', async t => {
  const value = await fixture(t, { loseWriteResponse: true });
  assert.equal((await value.runtime.processMessage(email())).status, 'awaiting_approval');
  const [approval] = await value.runtime.approvals();
  await value.runtime.approve({ id: approval.id, actor: 'operator@example.test', reason: 'Approve exact synthetic update.' });
  assert.equal((await value.runtime.processMessage(email())).status, 'uncertain');
  assert.equal((await currentRecord(value)).revision, 2);

  await value.getMcp().close();
  const receiptPath = join(value.recordsRoot, 'operations', `${approval.id}.receipt.json`);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const operator = { actor: 'operator@example.test', reason: 'Inspected the authoritative synthetic record and operation receipt.' };
  const result = await value.runtime.reconcileRecords({ actionKey: approval.id, receipt, ...operator });
  assert.equal(result.status, 'queued');
  await value.runtime.stop();
  const restarted = await value.create();
  assert.equal((await restarted.processMessage(email())).status, 'completed');
  assert.equal((await currentRecord(value)).revision, 2);
  assert.equal((await operationFiles(value)).filter(file => file.endsWith('.receipt.json')).length, 1);
});

test('stale proposal base revision is rejected after restart without overwriting the newer record', async t => {
  const value = await fixture(t);
  assert.equal((await value.runtime.processMessage(email())).status, 'awaiting_approval');
  const [approval] = await value.runtime.approvals();
  await value.runtime.stop();
  const changed = { ...seed, revision: 2, title: 'Concurrent operator title', updatedAt: now, updatedByHash: 'c'.repeat(64) };
  await writeFile(join(value.recordDirectory, 'record.json'), `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
  const restarted = await value.create();
  await restarted.approve({ id: approval.id, actor: 'operator@example.test', reason: 'Review stale proposal.' });
  assert.equal((await restarted.processMessage(email())).status, 'uncertain');
  assert.equal((await currentRecord(value)).revision, 2);
  assert.equal((await currentRecord(value)).title, 'Concurrent operator title');
  assert.deepEqual(await operationFiles(value), []);
});
