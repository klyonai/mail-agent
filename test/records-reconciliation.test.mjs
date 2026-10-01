import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordsIntent, validateRecordsIntent, validateRecordsReceipt, parseReceiptFile, bindRecordsReceipt } from '../src/records-reconciliation.mjs';
import { digest } from '../src/policy.mjs';

const now = 1_800_000_000_000;
const call = { name: 'records.apply_approved_update', args: { recordId: 'record-a', expectedRevision: 1,
  expectedRecordHash: 'c'.repeat(64), proposalDigest: 'd'.repeat(64), patch: { title: 'Synthetic title' } } };
const context = { agentId: 'agent', mailbox: 'agent@example.test', tool: call.name,
  argsHash: digest(call.args), operationId: 'a'.repeat(64), policyHash: 'b'.repeat(64),
  actor: 'alice@example.test', issuedAt: now, authorization: 'approval',
  approval: { id: 'a'.repeat(64), actor: 'admin@example.test', reasonHash: 'e'.repeat(64), expiresAt: now + 1000 } };

function fixture() {
  const intent = createRecordsIntent(context, call);
  const { agentId, mailbox, connection, operationId, tool, argsHash, recordId, expectedRevision, expectedRecordHash, proposalDigest } = intent;
  const receipt = { format: 1, source: 'mail-agent-records', agentId, mailbox, connection, operationId,
    tool, argsHash, recordId, expectedRevision, expectedRecordHash, proposalDigest, status: 'committed',
    revision: 2, recordHash: 'f'.repeat(64), inspectedAt: now + 100 };
  return { intent, receipt };
}

test('records intent retains exact content-free bindings and excludes generic tools', () => {
  const { intent } = fixture();
  assert.deepEqual(validateRecordsIntent(intent), intent);
  assert.equal(intent.actorHash, digest(context.actor));
  assert.equal(intent.approverHash, digest(context.approval.actor));
  assert.doesNotMatch(JSON.stringify(intent), /Synthetic title|alice@|admin@/);
  assert.equal(createRecordsIntent(undefined, call), undefined);
  assert.equal(createRecordsIntent(context, { ...call, name: 'other.write' }), undefined);
  assert.throws(() => createRecordsIntent({ ...context, argsHash: '0'.repeat(64) }, call));
});

test('receipts bind every operation and target field without accepting extra content or accessors', () => {
  const { intent, receipt } = fixture();
  assert.deepEqual(bindRecordsReceipt(intent, receipt, now + 100), receipt);
  for (const field of ['agentId', 'mailbox', 'operationId', 'tool', 'argsHash', 'recordId', 'expectedRecordHash', 'proposalDigest']) {
    const modified = { ...receipt, [field]: field.endsWith('Hash') || field === 'operationId' || field === 'proposalDigest' ? '0'.repeat(64) : 'other' };
    assert.throws(() => bindRecordsReceipt(intent, modified, now + 100));
  }
  assert.throws(() => validateRecordsReceipt({ ...receipt, content: 'Private content' }));
  assert.throws(() => validateRecordsReceipt(Object.defineProperty({ ...receipt }, 'tool', { get() { throw new Error('PRIVATE'); } })), /Records reconciliation denied/);
});

test('only exact committed or unchanged not-applied outcomes can resolve an action', () => {
  const { intent, receipt } = fixture();
  for (const status of ['unknown', 'unresolved']) assert.throws(() => bindRecordsReceipt(intent, { ...receipt, status }, now + 100));
  assert.throws(() => bindRecordsReceipt(intent, { ...receipt, revision: 3 }, now + 100));
  assert.throws(() => bindRecordsReceipt(intent, { ...receipt, inspectedAt: now - 1 }, now + 100));
  assert.throws(() => bindRecordsReceipt(intent, { ...receipt, inspectedAt: now + 101 }, now + 100));
  const absent = { ...receipt, status: 'not-applied', revision: 1, recordHash: intent.expectedRecordHash };
  assert.deepEqual(bindRecordsReceipt(intent, absent, now + 100), absent);
  assert.throws(() => bindRecordsReceipt(intent, { ...absent, recordHash: 'f'.repeat(64) }, now + 100));
  assert.throws(() => bindRecordsReceipt(intent, absent, now + 300_101));
});

test('receipt file reader uses owner-only bounded JSON and sanitizes unsafe input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'records-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = join(root, 'receipt.json');
  const { receipt } = fixture();
  await writeFile(filename, JSON.stringify(receipt), { mode: 0o600 });
  assert.deepEqual(await parseReceiptFile(filename), receipt);
  await chmod(filename, 0o644);
  await assert.rejects(parseReceiptFile(filename), /Records reconciliation denied/);
  await chmod(filename, 0o600);
  await symlink(filename, join(root, 'link.json'));
  await assert.rejects(parseReceiptFile(join(root, 'link.json')), /Records reconciliation denied/);
  await writeFile(filename, 'PRIVATE' + 'x'.repeat(8192));
  await assert.rejects(parseReceiptFile(filename), error => error.message === 'Records reconciliation denied.' && !error.cause);
});
