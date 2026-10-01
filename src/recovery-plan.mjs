const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const controls = /[\p{Cc}\p{Cf}]/u;
const planFields = ['format', 'mailboxIdentity', 'snapshotId', 'binding', 'configHash', 'operations'];
const contextFields = ['identity', 'binding', 'snapshotId', 'configHash', 'snapshotCreatedAt', 'now'];
const operationFields = {
  run: ['kind', 'id', 'fingerprint', 'outcome', 'evidence'],
  action: ['kind', 'key', 'fingerprint', 'outcome', 'evidence'],
  message: ['kind', 'messageId', 'conversationId', 'outcome', 'evidence']
};
const outcomes = { run: ['resume', 'sent', 'fenced', 'skip'], action: ['no-effect', 'fenced'], message: ['sent', 'fenced'] };
const evidenceFields = ['source', 'recordHash', 'observedAt'];

export class RecoveryPlanError extends Error {
  constructor() {
    super('Recovery plan is invalid or does not match the held state.');
    this.name = 'RecoveryPlanError';
    this.code = 'RECOVERY_PLAN_INVALID';
  }
}

function invalid() { throw new RecoveryPlanError(); }
function requireValid(condition) { if (!condition) invalid(); }
function hash(value) { return typeof value === 'string' && hashPattern.test(value); }
function uuid(value) { return typeof value === 'string' && uuidPattern.test(value); }
function time(value) { return Number.isSafeInteger(value) && value >= 0; }

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function data(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  requireValid(descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable);
  return descriptor.value;
}

function exactRecord(value, fields) {
  requireValid(plainRecord(value));
  requireValid(Object.getOwnPropertySymbols(value).length === 0);
  const names = Object.getOwnPropertyNames(value);
  requireValid(names.length === fields.length && names.every(name => fields.includes(name)));
  return Object.fromEntries(fields.map(field => [field, data(value, field)]));
}

function contextRecord(value) {
  const current = exactRecord(value, contextFields);
  requireValid([current.identity, current.binding, current.configHash].every(hash) && uuid(current.snapshotId));
  requireValid(time(current.snapshotCreatedAt) && time(current.now) && current.snapshotCreatedAt <= current.now);
  return current;
}

function boundPlan(value, context) {
  const current = exactRecord(value, planFields);
  requireValid(current.format === 1 && uuid(current.snapshotId));
  requireValid([current.mailboxIdentity, current.binding, current.configHash].every(hash));
  requireValid(current.mailboxIdentity === context.identity && current.snapshotId === context.snapshotId);
  requireValid(current.binding === context.binding && current.configHash === context.configHash);
  return current;
}

function identifier(value, maximum) {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= maximum && !controls.test(value));
  return value;
}

function evidenceRecord(value, context) {
  const current = exactRecord(value, evidenceFields);
  requireValid(['graph', 'adapter', 'operator'].includes(current.source) && hash(current.recordHash));
  requireValid(time(current.observedAt) && current.observedAt >= context.snapshotCreatedAt && current.observedAt <= context.now);
  return current;
}

function requireAssurance(kind, outcome, source) {
  if (kind === 'action' && outcome === 'no-effect') requireValid(source === 'adapter');
  if ((kind === 'run' || kind === 'message') && outcome === 'sent') requireValid(source === 'graph');
}

function operationRecord(value, context) {
  requireValid(plainRecord(value));
  const kind = data(value, 'kind');
  requireValid(typeof kind === 'string' && Object.hasOwn(operationFields, kind));
  const current = exactRecord(value, operationFields[kind]);
  requireValid(outcomes[kind].includes(current.outcome));
  const evidence = evidenceRecord(current.evidence, context);
  requireAssurance(kind, current.outcome, evidence.source);
  if (kind === 'message') return { kind, messageId: identifier(current.messageId, 1024),
    conversationId: identifier(current.conversationId, 1024), outcome: current.outcome, evidence };
  requireValid(hash(current.fingerprint));
  const field = kind === 'run' ? 'id' : 'key';
  return { kind, [field]: identifier(current[field], 256), fingerprint: current.fingerprint, outcome: current.outcome, evidence };
}

function operationArray(value, context) {
  requireValid(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  requireValid(value.length > 0 && value.length <= 100);
  requireValid(Object.getOwnPropertySymbols(value).length === 0 && Object.getOwnPropertyNames(value).length === value.length + 1);
  const result = [], targets = new Set();
  for (let index = 0; index < value.length; index++) {
    const operation = operationRecord(data(value, String(index)), context);
    const target = `${operation.kind}\0${operation.id ?? operation.key ?? operation.messageId}`;
    requireValid(!targets.has(target));
    targets.add(target);
    result.push(operation);
  }
  return result;
}

/** Parse local attestations only. State-specific authority and fingerprint checks belong to application. */
export function validateRecoveryPlan(plan, context) {
  try {
    const currentContext = contextRecord(context);
    const current = boundPlan(plan, currentContext);
    const result = { format: 1, mailboxIdentity: current.mailboxIdentity, snapshotId: current.snapshotId,
      binding: current.binding, configHash: current.configHash, operations: operationArray(current.operations, currentContext) };
    // Serialize only the validated bounded clone, never submitted hooks or unknown content.
    requireValid(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 1_048_576);
    return result;
  } catch { throw new RecoveryPlanError(); }
}
