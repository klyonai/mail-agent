import assert from 'node:assert/strict';
import test from 'node:test';
import { domainInvocationContext, invocationOptions, requireDomainApproval } from '../src/runtime-domain.mjs';
import { validateDomainContext } from '../src/domain-context.mjs';
import { digest, policyDigest } from '../src/policy.mjs';

const now = 1_800_000_000_000;
const key = 'a'.repeat(64);
const reasonHash = 'b'.repeat(64);

function setup() {
  const call = { name: 'records.update', args: { recordId: 'item-1', state: 'reviewed' } };
  const config = {
    id: 'agent-a', mailbox: { address: 'mailbox@example.org', sender_authentication: { mode: 'exchange-authenticated' } },
    retention: { content_hours: 24 },
    policy: { approvers: ['operator@example.org'], tools: {
      'records.update': { effect: 'write', authorization: 'approval', constraints: {} },
    } },
    mcp: { records: { transport: 'stdio', actor_context: 'mail-agent-v1' } },
  };
  const run = { id: 'run-a', createdAt: now - 100, mail: { id: 'message-a', conversationId: 'conversation-a',
    sender: 'alice@example.org', authenticated: true }, grants: { [key]: {
      id: key, tool: call.name, args: structuredClone(call.args), policyHash: policyDigest(config),
      expiresAt: now + 60_000, actor: 'operator@example.org', reasonHash,
    } } };
  return { call, config, run };
}

test('domain invocation binds each exact stored grant field before creating context', () => {
  const value = setup();
  const context = domainInvocationContext(value.run, value.call, key, value.config,
    value.config.policy.tools[value.call.name], () => now);
  const clean = validateDomainContext(context, { now, tool: value.call.name, args: value.call.args,
    agentId: value.config.id, mailbox: value.config.mailbox.address, connection: 'records' });
  assert.equal(clean.operationId, key);
  assert.equal(clean.approval.actor, 'operator@example.org');
  assert.equal(clean.approval.reasonHash, reasonHash);
});

for (const [field, value] of [
  ['id', 'c'.repeat(64)], ['tool', 'records.delete'], ['args', { recordId: 'other', state: 'reviewed' }],
  ['policyHash', 'd'.repeat(64)], ['reasonHash', 'invalid'],
]) {
  test(`rejects a stored grant with mismatched ${field}`, () => {
    const setupValue = setup();
    setupValue.run.grants[key][field] = value;
    assert.throws(() => domainInvocationContext(setupValue.run, setupValue.call, key, setupValue.config,
      setupValue.config.policy.tools[setupValue.call.name], () => now), field === 'reasonHash'
      ? { code: 'DOMAIN_CONTEXT_INVALID' } : /approval does not match/i);
  });
}

test('rejects expired grant and actor removed from current approver policy', () => {
  const expired = setup();
  expired.run.grants[key].expiresAt = now;
  assert.throws(() => domainInvocationContext(expired.run, expired.call, key, expired.config,
    expired.config.policy.tools[expired.call.name], () => now), { code: 'DOMAIN_CONTEXT_INVALID' });

  const removed = setup();
  removed.config.policy.approvers = [];
  removed.run.grants[key].policyHash = policyDigest(removed.config);
  assert.throws(() => domainInvocationContext(removed.run, removed.call, key, removed.config,
    removed.config.policy.tools[removed.call.name], () => now), { code: 'DOMAIN_CONTEXT_INVALID' });
});

test('model-supplied actor fields remain arguments and cannot replace the verified sender', () => {
  const value = setup();
  value.call.args.actor = 'forged@example.org';
  value.run.grants[key].args = structuredClone(value.call.args);
  const context = domainInvocationContext(value.run, value.call, key, value.config,
    value.config.policy.tools[value.call.name], () => now);
  assert.equal(context.actor, 'alice@example.org');
  assert.equal(context.argsHash, digest(value.call.args));
  assert.equal(context.actor === value.call.args.actor, false);
});

test('generic connections preserve existing invocation options and approval behavior', () => {
  const value = setup();
  value.config.mcp.records.actor_context = undefined;
  value.config.policy.tools[value.call.name] = { effect: 'write', authorization: 'approval' };
  const policy = value.config.policy.tools[value.call.name];
  assert.equal(domainInvocationContext(value.run, value.call, key, value.config, policy, () => now), undefined);
  assert.deepEqual(invocationOptions('signal-token', undefined), { signal: 'signal-token' });
  assert.equal(requireDomainApproval(value.config, value.call, policy), undefined);
});
