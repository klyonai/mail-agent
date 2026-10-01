import { address, digest } from './policy.mjs';
import { readRecoveryPlanFile } from './recovery-io.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const emailPattern = /^[^\s@<>]{1,128}@[a-z0-9.-]{1,253}$/;
const applyTools = new Set(['records.apply_approved_update', 'records.apply_approved_delete']);
const bindingKeys = ['agentId', 'mailbox', 'connection', 'operationId', 'tool', 'argsHash',
  'recordId', 'expectedRevision', 'expectedRecordHash', 'proposalDigest'];
const intentKeys = ['format', ...bindingKeys, 'policyHash', 'actorHash', 'approverHash',
  'approvalReasonHash', 'approvalExpiresAt', 'issuedAt'];
const receiptKeys = ['format', 'source', ...bindingKeys, 'status', 'revision', 'recordHash', 'inspectedAt'];

export class RecordsReconciliationError extends Error {
  constructor() { super('Records reconciliation denied.'); this.name = 'RecordsReconciliationError'; this.code = 'RECORDS_RECONCILIATION_DENIED'; }
}
function fail() { throw new RecordsReconciliationError(); }
function hash(value) { return typeof value === 'string' && hashPattern.test(value); }
function epoch(value) { return Number.isSafeInteger(value) && value >= 0; }
function revision(value) { return Number.isSafeInteger(value) && value > 0; }
function email(value) { return typeof value === 'string' && emailPattern.test(value) && value === address(value); }

function exact(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) fail();
  const clone = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
    clone[key] = descriptor.value;
  }
  return clone;
}

function validateBindings(value) {
  const identity = typeof value.agentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.agentId)
    && email(value.mailbox) && value.connection === 'records';
  const target = typeof value.recordId === 'string' && idPattern.test(value.recordId) && revision(value.expectedRevision);
  if (value.format !== 1 || !identity || !target || !applyTools.has(value.tool)) fail();
  if (['operationId', 'argsHash', 'expectedRecordHash', 'proposalDigest'].some(key => !hash(value[key]))) fail();
}

export function validateRecordsIntent(value) {
  const intent = exact(value, intentKeys);
  validateBindings(intent);
  if (['policyHash', 'actorHash', 'approverHash', 'approvalReasonHash'].some(key => !hash(intent[key]))) fail();
  if (!epoch(intent.issuedAt) || !epoch(intent.approvalExpiresAt) || intent.approvalExpiresAt <= intent.issuedAt) fail();
  return Object.freeze(intent);
}

export function createRecordsIntent(context, call) {
  if (!context || !applyTools.has(call?.name)) return undefined;
  const approval = context.approval;
  if (context.authorization !== 'approval' || !approval || approval.id !== context.operationId
    || context.tool !== call.name || context.argsHash !== digest(call.args)) fail();
  if (!email(context.actor) || !email(approval.actor)) fail();
  return validateRecordsIntent({ format: 1, agentId: context.agentId, mailbox: context.mailbox,
    connection: 'records', operationId: context.operationId, tool: call.name, argsHash: context.argsHash,
    recordId: call.args.recordId, expectedRevision: call.args.expectedRevision,
    expectedRecordHash: call.args.expectedRecordHash, proposalDigest: call.args.proposalDigest,
    policyHash: context.policyHash, actorHash: digest(context.actor), approverHash: digest(approval.actor),
    approvalReasonHash: approval.reasonHash, approvalExpiresAt: approval.expiresAt, issuedAt: context.issuedAt });
}

export function validateRecordsReceipt(value) {
  const receipt = exact(value, receiptKeys);
  validateBindings(receipt);
  if (receipt.source !== 'mail-agent-records' || !epoch(receipt.inspectedAt)
    || !['committed', 'not-applied', 'unresolved', 'unknown'].includes(receipt.status)) fail();
  if ((receipt.revision !== null && !revision(receipt.revision))
    || (receipt.recordHash !== null && !hash(receipt.recordHash))) fail();
  if (['committed', 'not-applied'].includes(receipt.status) && (!revision(receipt.revision) || !hash(receipt.recordHash))) fail();
  return Object.freeze(receipt);
}

export function bindRecordsReceipt(value, observed, now = Date.now()) {
  const intent = validateRecordsIntent(value), receipt = validateRecordsReceipt(observed);
  if (bindingKeys.some(key => intent[key] !== receipt[key]) || !epoch(now)
    || receipt.inspectedAt < intent.issuedAt || receipt.inspectedAt > now) fail();
  if (receipt.status === 'committed') {
    if (receipt.revision !== intent.expectedRevision + 1 || !revision(receipt.revision)) fail();
  } else if (receipt.status === 'not-applied') {
    requireUnchangedRecord(intent, receipt, now);
  } else fail();
  return receipt;
}

function requireUnchangedRecord(intent, receipt, now) {
  if (receipt.revision !== intent.expectedRevision || receipt.recordHash !== intent.expectedRecordHash
    || now - receipt.inspectedAt > 300_000) fail();
}

export async function parseReceiptFile(filename) {
  try { return validateRecordsReceipt(await readRecoveryPlanFile(filename, { maxBytes: 8192 })); }
  catch { fail(); }
}
