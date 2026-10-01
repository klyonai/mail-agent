const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const planFields = ['format', 'mode', 'mailboxIdentity', 'snapshotId', 'binding', 'configHash', 'coverage', 'acceptHistoryGap'];
const contextFields = ['identity', 'binding', 'snapshotId', 'configHash', 'snapshotCreatedAt', 'restoredAt', 'now'];
const coverageFields = ['from', 'through', 'oldOwnerStoppedAt', 'evidenceHash', 'allSources'];

export class RecoveryReleasePlanError extends Error {
  constructor() {
    super('Recovery release plan is invalid or does not match the held state.');
    this.name = 'RecoveryReleasePlanError';
    this.code = 'RECOVERY_RELEASE_PLAN_INVALID';
  }
}

function invalid() { throw new RecoveryReleasePlanError(); }
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
  requireValid([current.snapshotCreatedAt, current.restoredAt, current.now].every(time));
  requireValid(current.snapshotCreatedAt <= current.restoredAt && current.restoredAt <= current.now);
  return current;
}

function coverageRecord(value, context) {
  const current = exactRecord(value, coverageFields);
  requireValid(time(current.from) && time(current.through) && time(current.oldOwnerStoppedAt));
  requireValid(current.from === context.snapshotCreatedAt);
  requireValid(current.oldOwnerStoppedAt <= current.through);
  requireValid(context.restoredAt <= current.through && current.through <= context.now);
  requireValid(hash(current.evidenceHash) && current.allSources === true);
  return current;
}

function boundPlan(value, context) {
  const current = exactRecord(value, planFields);
  requireValid(current.format === 1 && ['continuity', 'history-gap'].includes(current.mode));
  requireValid([current.mailboxIdentity, current.binding, current.configHash].every(hash) && uuid(current.snapshotId));
  requireValid(current.mailboxIdentity === context.identity && current.snapshotId === context.snapshotId);
  requireValid(current.binding === context.binding && current.configHash === context.configHash);
  requireValid(current.acceptHistoryGap === (current.mode === 'history-gap'));
  return current;
}

/** Validate and clone the local operator's whole-window recovery attestation. */
export function validateRecoveryReleasePlan(plan, context) {
  try {
    const currentContext = contextRecord(context);
    const current = boundPlan(plan, currentContext);
    const result = { format: 1, mode: current.mode, mailboxIdentity: current.mailboxIdentity,
      snapshotId: current.snapshotId, binding: current.binding, configHash: current.configHash,
      coverage: coverageRecord(current.coverage, currentContext), acceptHistoryGap: current.acceptHistoryGap };
    requireValid(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16_384);
    return result;
  } catch { throw new RecoveryReleasePlanError(); }
}
