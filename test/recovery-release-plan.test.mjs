import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryReleasePlanError, validateRecoveryReleasePlan } from '../src/recovery-release-plan.mjs';

const hash = character => character.repeat(64);
const snapshotId = '11111111-1111-4111-8111-111111111111';
const context = { identity: hash('a'), binding: hash('b'), snapshotId, configHash: hash('c'),
  snapshotCreatedAt: 10, restoredAt: 20, now: 40 };
const plan = (mode = 'continuity') => ({ format: 1, mode, mailboxIdentity: context.identity, snapshotId,
  binding: context.binding, configHash: context.configHash,
  coverage: { from: 10, through: 30, oldOwnerStoppedAt: 15, evidenceHash: hash('d'), allSources: true },
  acceptHistoryGap: mode === 'history-gap' });

function rejects(value, currentContext = context) {
  assert.throws(() => validateRecoveryReleasePlan(value, currentContext), error => {
    assert.ok(error instanceof RecoveryReleasePlanError);
    assert.equal(error.name, 'RecoveryReleasePlanError');
    assert.equal(error.code, 'RECOVERY_RELEASE_PLAN_INVALID');
    assert.equal(error.message, 'Recovery release plan is invalid or does not match the held state.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test('valid continuity and history-gap manifests return independent strict clones', () => {
  for (const mode of ['continuity', 'history-gap']) {
    const value = plan(mode), result = validateRecoveryReleasePlan(value, context);
    assert.deepEqual(result, value);
    assert.notEqual(result, value);
    assert.notEqual(result.coverage, value.coverage);
    result.coverage.from = 99;
    assert.equal(value.coverage.from, 10);
  }
});

test('identity, snapshot, binding, configuration and context must match exactly', () => {
  for (const field of ['mailboxIdentity', 'binding', 'configHash']) {
    for (const value of [null, 1, '', 'x'.repeat(64), hash('a').toUpperCase(), hash('f')]) rejects({ ...plan(), [field]: value });
  }
  for (const snapshot of ['', 'bad', '22222222-2222-4222-8222-222222222222']) rejects({ ...plan(), snapshotId: snapshot });
  for (const field of ['identity', 'binding', 'configHash']) rejects(plan(), { ...context, [field]: hash('f') });
  rejects(plan(), { ...context, snapshotId: '22222222-2222-4222-8222-222222222222' });
  for (const field of Object.keys(context)) rejects(plan(), { ...context, [field]: undefined });
});

test('coverage spans the complete safe snapshot, old-owner, restore and current-time window', () => {
  for (const coverage of [
    { from: 9 }, { from: 11 }, { through: 19 }, { through: 41 }, { through: 14 },
    { oldOwnerStoppedAt: 31 },
    { from: -1 }, { through: 1.5 }, { oldOwnerStoppedAt: Number.MAX_SAFE_INTEGER + 1 },
    { evidenceHash: 'PRIVATE_EVIDENCE' }, { evidenceHash: hash('D') }, { allSources: false },
  ]) rejects({ ...plan(), coverage: { ...plan().coverage, ...coverage } });
  const stoppedBeforeSnapshot = { ...plan(), coverage: { ...plan().coverage, oldOwnerStoppedAt: 5 } };
  assert.equal(validateRecoveryReleasePlan(stoppedBeforeSnapshot, context).coverage.oldOwnerStoppedAt, 5);
  for (const currentContext of [
    { ...context, snapshotCreatedAt: -1 }, { ...context, snapshotCreatedAt: 31 },
    { ...context, restoredAt: -1 }, { ...context, restoredAt: 31 },
    { ...context, now: 19 }, { ...context, now: Number.MAX_SAFE_INTEGER + 1 },
  ]) rejects(plan(), currentContext);
  assert.equal(validateRecoveryReleasePlan(plan(), context).coverage.through, 30);
});

test('mode and explicit history-gap acknowledgment must agree', () => {
  for (const value of ['other', null, 1]) {
    rejects({ ...plan(), mode: value });
  }
  rejects({ ...plan('continuity'), acceptHistoryGap: true });
  rejects({ ...plan('history-gap'), acceptHistoryGap: false });
  rejects({ ...plan(), acceptHistoryGap: 1 });
});

test('exact own fields, plain records and data properties reject hooks and unknown content', () => {
  for (const value of [null, [], 'PRIVATE_CONTENT', { ...plan(), body: 'PRIVATE_CONTENT' }]) rejects(value);
  for (const field of Object.keys(plan())) { const value = plan(); delete value[field]; rejects(value); }
  for (const value of [null, [], {}, { ...plan().coverage, secret: 'PRIVATE_CONTENT' }]) rejects({ ...plan(), coverage: value });
  rejects(Object.assign(Object.create({ inherited: true }), plan()));
  assert.deepEqual(validateRecoveryReleasePlan(Object.assign(Object.create(null), plan()), context), plan());
  rejects({ ...plan(), [Symbol('private')]: true });

  let executions = 0;
  const accessor = plan();
  Object.defineProperty(accessor, 'binding', { enumerable: true, get() { executions++; return context.binding; } });
  rejects(accessor);
  rejects({ ...plan(), toJSON() { executions++; return {}; } });
  const coverage = plan().coverage;
  Object.defineProperty(coverage, 'through', { enumerable: true, get() { executions++; return 30; } });
  rejects({ ...plan(), coverage });
  assert.equal(executions, 0);
});

test('oversized manifests and malformed contexts fail with the fixed safe error', () => {
  const oversized = plan();
  oversized.coverage.evidenceHash = 'd'.repeat(20_000);
  rejects(oversized);
  for (const value of [null, [], 'PRIVATE_CONTENT']) rejects(plan(), value);
});
