import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainContext, validateDomainContext, DOMAIN_CONTEXT_KEY, DOMAIN_CONTEXT_CAPABILITY } from '../src/domain-context.mjs';
import { digest } from '../src/policy.mjs';

const now = 1_800_000_000_000;
const config = {
  id: 'assistant', mailbox: { address: 'bot@example.org', sender_authentication: { mode: 'exchange-authenticated' } },
  policy: { approvers: ['operator@example.org'], tools: { 'records.lookup': { effect: 'read', authorization: 'automatic' } } },
  retention: { content_hours: 24 },
  mcp: { records: { transport: 'stdio', actor_context: 'mail-agent-v1' } },
};
const run = { id: 'run-1', createdAt: now - 1000, mail: {
  id: 'message-1', conversationId: 'conversation-1', sender: 'Alice@Example.org', authenticated: true,
} };
const call = { name: 'records.lookup', args: { key: 'case-1' } };
const key = 'a'.repeat(64);

test('domain actor context is explicit opt-in and validates protocol negotiation', async () => {
  const { domainContextEnabled } = await import('../src/domain-context.mjs');
  assert.equal(DOMAIN_CONTEXT_KEY, 'mail-agent/actor-context');
  assert.deepEqual(DOMAIN_CONTEXT_CAPABILITY, { version: 1 });
  assert.equal(domainContextEnabled(config, 'records.lookup'), true);
  assert.equal(domainContextEnabled({ ...config, mcp: { records: { transport: 'streamable-http', actor_context: 'mail-agent-v1' } } }, 'records.lookup'), false);
  assert.equal(domainContextEnabled(config, 'other.lookup'), false);
});

test('creates a frozen bounded context from verified envelope and exact tool arguments', () => {
  const context = createDomainContext({ run, call, actionKey: key, config, authorization: 'automatic', clock: () => now });
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.actor, 'alice@example.org');
  assert.equal(context.mailbox, 'bot@example.org');
  assert.equal(context.provenance.source, 'verified-mail-envelope');
  assert.equal(context.provenance.authProfile, 'exchange-authenticated');
  assert.equal(context.provenance.messageIdHash, digest('message-1'));
  assert.equal(context.tool, call.name);
  assert.equal(context.argsHash, digest(call.args));
  assert.equal(context.operationId, key);
  assert.equal(context.issuedAt, now);
  assert.equal(context.expiresAt, now + 300_000);
  assert.equal(validateDomainContext(context, { now, agentId: config.id, mailbox: config.mailbox.address,
    tool: call.name, args: call.args, connection: 'records' }).actor, 'alice@example.org');
});

test('approved context binds a locally attributed operator approval', () => {
  const approval = { id: key, actor: 'operator@example.org', origin: 'local-operator', reasonHash: 'b'.repeat(64), expiresAt: now + 60_000 };
  const approvedConfig = structuredClone(config);
  approvedConfig.policy.tools['records.lookup'].authorization = 'approval';
  const context = createDomainContext({ run, call, actionKey: key, config: approvedConfig, authorization: 'approval', approval, clock: () => now });
  assert.deepEqual(context.approval, approval);
  assert.equal(context.expiresAt, approval.expiresAt);
  assert.equal(validateDomainContext(context, { now, tool: call.name, args: call.args }).approval.actor, approval.actor);
});

test('rejects unverified or incomplete envelopes, unapproved approvers and excessive lifetimes', () => {
  assert.throws(() => createDomainContext({ run: { ...run, mail: { ...run.mail, authenticated: false } }, call, actionKey: key, config, authorization: 'automatic', clock: () => now }), { code: 'DOMAIN_CONTEXT_INVALID' });
  assert.throws(() => createDomainContext({ run: { ...run, mail: { ...run.mail, id: '' } }, call, actionKey: key, config, authorization: 'automatic', clock: () => now }), { code: 'DOMAIN_CONTEXT_INVALID' });
  assert.throws(() => createDomainContext({ run, call, actionKey: key, config, authorization: 'approval', approval: { id: key, actor: 'outsider@example.org', origin: 'local-operator', reasonHash: 'b'.repeat(64), expiresAt: now + 60_000 }, clock: () => now }), { code: 'DOMAIN_CONTEXT_INVALID' });
  assert.throws(() => createDomainContext({ run, call, actionKey: key, config, authorization: 'approval', approval: { id: key, actor: 'operator@example.org', origin: 'local-operator', reasonHash: 'b'.repeat(64), expiresAt: now + 400_000 }, clock: () => now }), { code: 'DOMAIN_CONTEXT_INVALID' });
});

test('validation rejects altered, stale, mismatched and accessor-bearing context without leaking input', () => {
  const context = createDomainContext({ run, call, actionKey: key, config, authorization: 'automatic', clock: () => now });
  for (const [value, expected] of [
    [{ ...context, actor: 'forged@example.org' }, {}],
    [context, { now: now + 300_001 }],
    [context, { tool: 'records.update' }],
    [context, { args: { key: 'other' } }],
    [context, { connection: 'other' }],
  ]) assert.throws(() => validateDomainContext(value, expected), { code: 'DOMAIN_CONTEXT_INVALID' });
  const hostile = Object.defineProperty({ ...context }, 'actor', { get() { throw new Error('PRIVATE VALUE'); } });
  assert.throws(() => validateDomainContext(hostile), error => error.code === 'DOMAIN_CONTEXT_INVALID' && !error.message.includes('PRIVATE'));
  assert.throws(() => validateDomainContext({ ...context, extra: 'unexpected' }), { code: 'DOMAIN_CONTEXT_INVALID' });
  const hostileArgs = Object.defineProperty({}, 'key', { get() { throw new Error('PRIVATE ARGUMENT'); } });
  assert.throws(() => createDomainContext({ run, call: { ...call, args: hostileArgs }, actionKey: key, config,
    authorization: 'automatic', clock: () => now }), error => error.code === 'DOMAIN_CONTEXT_INVALID' && !error.message.includes('PRIVATE'));
});
