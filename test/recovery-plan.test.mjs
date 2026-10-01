import assert from 'node:assert/strict';
import test from 'node:test';
import { RecoveryPlanError, validateRecoveryPlan } from '../src/recovery-plan.mjs';

const hash = character => character.repeat(64);
const snapshotId = '11111111-1111-4111-8111-111111111111';
const context = { identity: hash('a'), binding: hash('b'), snapshotId, configHash: hash('c'), snapshotCreatedAt: 10, now: 30 };
const evidence = (source = 'operator') => ({ source, recordHash: hash('d'), observedAt: 20 });
const run = (outcome = 'resume') => ({ kind: 'run', id: 'run-synthetic', fingerprint: hash('e'), outcome,
  evidence: evidence(outcome === 'sent' ? 'graph' : 'operator') });
const action = (outcome = 'no-effect') => ({ kind: 'action', key: 'action-synthetic', fingerprint: hash('f'), outcome,
  evidence: evidence(outcome === 'no-effect' ? 'adapter' : 'operator') });
const message = (outcome = 'sent') => ({ kind: 'message', messageId: 'immutable-message', conversationId: 'conversation-synthetic', outcome,
  evidence: evidence(outcome === 'sent' ? 'graph' : 'operator') });
const plan = (operations = [run(), action(), message()]) => ({ format: 1, mailboxIdentity: context.identity, snapshotId,
  binding: context.binding, configHash: context.configHash, operations });

function rejects(value, currentContext = context) {
  assert.throws(() => validateRecoveryPlan(value, currentContext), error => {
    assert.ok(error instanceof RecoveryPlanError);
    assert.equal(error.name, 'RecoveryPlanError');
    assert.equal(error.code, 'RECOVERY_PLAN_INVALID');
    assert.equal(error.message, 'Recovery plan is invalid or does not match the held state.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test('valid bounded recovery plans return independent data with every supported outcome', () => {
  const value = plan([run('resume'), { ...run('sent'), id: 'sent-run' }, { ...run('fenced'), id: 'fenced-run' },
    { ...run('skip'), id: 'skip-run' }, action(), { ...action('fenced'), key: 'fenced-action' }, message(),
    { ...message('fenced'), messageId: 'fenced-message' }]);
  const result = validateRecoveryPlan(value, context);
  assert.deepEqual(result, value);
  assert.notEqual(result, value);
  assert.notEqual(result.operations, value.operations);
  assert.notEqual(result.operations[0], value.operations[0]);
  assert.notEqual(result.operations[0].evidence, value.operations[0].evidence);
  result.operations[0].evidence.recordHash = hash('f');
  assert.equal(value.operations[0].evidence.recordHash, hash('d'));
});

test('plan identity, snapshot, binding, configuration and schema must exactly match validated context', () => {
  for (const field of ['mailboxIdentity', 'binding', 'configHash']) {
    for (const value of [null, 1, '', 'x'.repeat(64), hash('a').toUpperCase(), hash('f')]) rejects({ ...plan(), [field]: value });
  }
  for (const value of [null, '', 'private-snapshot', '22222222-2222-4222-8222-222222222222']) rejects({ ...plan(), snapshotId: value });
  for (const value of [0, 2, '1', null]) rejects({ ...plan(), format: value });
  for (const value of [null, [], 'PRIVATE_CONTENT', { ...plan(), body: 'PRIVATE_CONTENT' }]) rejects(value);
  for (const field of Object.keys(plan())) { const value = plan(); delete value[field]; rejects(value); }
  for (const field of ['identity', 'binding', 'configHash']) rejects(plan(), { ...context, [field]: 'invalid' });
  for (const value of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30']) rejects(plan(), { ...context, now: value });
  rejects(plan(), { ...context, snapshotCreatedAt: -1 });
  rejects(plan(), { ...context, snapshotCreatedAt: 31 });
  rejects(plan(), { ...context, snapshotId: 'invalid' });
});

test('operations are a dense nonempty array of at most one hundred exact supported records', () => {
  for (const operations of [[], null, {}, new Array(1), Array.from({ length: 101 }, (_, index) => ({ ...run(), id: `run-${index}` }))]) {
    rejects(plan(operations));
  }
  assert.equal(validateRecoveryPlan(plan(Array.from({ length: 100 }, (_, index) => ({ ...run(), id: `run-${index}` }))), context).operations.length, 100);
  for (const operation of [null, [], 'PRIVATE_CONTENT', { ...run(), kind: 'release' }, { ...run(), kind: 'run', outcome: 'completed' },
    { ...action(), outcome: 'sent' }, { ...message(), outcome: 'resume' }]) rejects(plan([operation]));
  for (const factory of [run, action, message]) {
    for (const field of Object.keys(factory())) { const value = factory(); delete value[field]; rejects(plan([value])); }
    for (const field of ['body', 'toolResult', 'arguments', 'grants', 'approval', 'actor', 'reason']) rejects(plan([{ ...factory(), [field]: 'PRIVATE_CONTENT' }]));
  }
});

test('targets and fingerprints are bounded and do not permit control characters', () => {
  for (const [factory, field, max] of [[run, 'id', 256], [action, 'key', 256], [message, 'messageId', 1024], [message, 'conversationId', 1024]]) {
    for (const value of ['', null, 1, 'x'.repeat(max + 1), 'PRIVATE\nCONTENT', 'PRIVATE\0CONTENT', 'PRIVATE\u007fCONTENT', 'PRIVATE\u0085CONTENT']) {
      rejects(plan([{ ...factory(), [field]: value }]));
    }
    assert.equal(validateRecoveryPlan(plan([{ ...factory(), [field]: 'x'.repeat(max) }]), context).operations[0][field].length, max);
  }
  for (const factory of [run, action]) for (const value of [null, '', 'x'.repeat(64), 'a'.repeat(63), hash('a').toUpperCase()]) {
    rejects(plan([{ ...factory(), fingerprint: value }]));
  }
});

test('duplicate targets reject independent of evidence, outcome or conversation while distinct kinds may share identifiers', () => {
  rejects(plan([run(), { ...run('skip'), evidence: evidence('graph') }]));
  rejects(plan([action(), action('fenced')]));
  rejects(plan([message(), { ...message('fenced'), conversationId: 'different-conversation' }]));
  assert.equal(validateRecoveryPlan(plan([run(), { ...action(), key: 'run-synthetic' }, { ...message(), messageId: 'run-synthetic' }]), context).operations.length, 3);
});

test('evidence requires exact source/hash/time and outcome-appropriate provider assurances', () => {
  for (const source of ['graph', 'adapter', 'operator']) assert.equal(validateRecoveryPlan(plan([{ ...run(), evidence: evidence(source) }]), context).operations[0].evidence.source, source);
  for (const value of [null, [], {}, { ...evidence(), body: 'PRIVATE_CONTENT' }, { ...evidence(), source: 'model' },
    { ...evidence(), recordHash: 'PRIVATE_CONTENT' }]) rejects(plan([{ ...run(), evidence: value }]));
  for (const field of Object.keys(evidence())) { const value = evidence(); delete value[field]; rejects(plan([{ ...run(), evidence: value }])); }
  for (const observedAt of [9, 31, -1, NaN, 1.5, '20', Number.MAX_SAFE_INTEGER + 1]) rejects(plan([{ ...run(), evidence: { ...evidence(), observedAt } }]));
  for (const observedAt of [10, 30]) assert.equal(validateRecoveryPlan(plan([{ ...run(), evidence: { ...evidence(), observedAt } }]), context).operations[0].evidence.observedAt, observedAt);
  for (const source of ['graph', 'operator']) rejects(plan([{ ...action(), evidence: evidence(source) }]));
  for (const factory of [() => run('sent'), message]) for (const source of ['adapter', 'operator']) rejects(plan([{ ...factory(), evidence: evidence(source) }]));
});

test('unknown prototypes, accessors, serialization hooks and symbols are rejected without executing submitted code', () => {
  let executions = 0;
  const accessor = plan();
  Object.defineProperty(accessor, 'binding', { get: () => { executions++; return context.binding; }, enumerable: true });
  rejects(accessor);
  rejects({ ...plan(), toJSON() { executions++; return {}; } });
  rejects(Object.assign(Object.create({ inherited: 'PRIVATE_CONTENT' }), plan()));
  rejects({ ...plan(), [Symbol('PRIVATE_CONTENT')]: true });
  const operations = [run()];
  operations.content = 'PRIVATE_CONTENT';
  rejects(plan(operations));
  const operation = run();
  Object.defineProperty(operation.evidence, 'observedAt', { get: () => { executions++; return 20; }, enumerable: true });
  rejects(plan([operation]));
  assert.equal(executions, 0);
});

test('bounded Unicode plans stay within one MiB and failures never echo content', () => {
  const value = plan(Array.from({ length: 100 }, (_, index) => ({ ...message('fenced'), messageId: `${index}${'漢'.repeat(1000)}`, conversationId: '漢'.repeat(1024) })));
  const result = validateRecoveryPlan(value, context);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_048_576);
  const giant = plan();
  giant.operations[0].id = 'PRIVATE_SENTINEL'.repeat(100_000);
  rejects(giant);
});
