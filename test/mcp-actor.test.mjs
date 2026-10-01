import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcp } from '../src/mcp.mjs';
import { DOMAIN_CONTEXT_KEY, validateDomainContext } from '../src/domain-context.mjs';
import { digest } from '../src/policy.mjs';

const now = 1_800_000_000_000;
const args = { query: 'synthetic' };
const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false };
const context = {
  version: 1, agentId: 'assistant', mailbox: 'bot@example.org', actor: 'alice@example.org',
  provenance: { source: 'verified-mail-envelope', messageIdHash: digest('synthetic-message'),
    conversationIdHash: digest('synthetic-conversation'), authProfile: 'exchange-authenticated' },
  tool: 'records.lookup', argsHash: digest(args), operationId: 'a'.repeat(64), policyHash: 'b'.repeat(64),
  issuedAt: now, expiresAt: now + 1000, authorization: 'automatic', approval: null,
};

function fixture({ capabilities = { experimental: { [DOMAIN_CONTEXT_KEY]: { version: 1 } } },
  actorContext = 'mail-agent-v1', transport = 'stdio', clock = () => now } = {}) {
  const seen = { listings: 0, calls: [], closes: 0, factories: 0 };
  const settings = transport === 'stdio' ? { transport, command: 'node', args: [], env: [] }
    : { transport, url: 'https://records.example.test/mcp' };
  if (actorContext !== 'absent') settings.actor_context = actorContext;
  const mcp = createMcp({ records: settings }, { clock, clientFactory: async () => {
    seen.factories += 1;
    return {
      getServerCapabilities: () => capabilities,
      listTools: async () => { seen.listings += 1; return { tools: [{ name: 'lookup', inputSchema }] }; },
      callTool: async value => { seen.calls.push(value); return { content: [{ type: 'text', text: 'synthetic-result' }] }; },
      close: async () => { seen.closes += 1; },
    };
  } });
  return { mcp, seen };
}

test('opted-in actor context requires exact negotiated capability before discovery', async () => {
  const getter = Object.defineProperty({}, 'version', { get() { throw new Error('PRIVATE'); } });
  for (const capabilities of [undefined, {}, { experimental: {} }, ...[
    null, 1, { version: 2 }, { version: '1' }, { version: 1, extra: true }, getter,
  ].map(value => ({ experimental: { [DOMAIN_CONTEXT_KEY]: value } }))]) {
    const { mcp, seen } = fixture({ capabilities: capabilities ?? {} });
    await assert.rejects(mcp.listTools(), error => {
      assert.equal(error.diagnosticCode, 'configuration');
      assert.doesNotMatch(String(error), /PRIVATE/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(seen.listings, 0);
    assert.equal(seen.closes, 1);
    await mcp.close();
  }
});

test('opted-in calls transmit a validated context outside model arguments', async () => {
  const { mcp, seen } = fixture();
  try {
    await mcp.call('records.lookup', args, { context });
    assert.deepEqual(seen.calls, [{ name: 'lookup', arguments: args, _meta: {
      [DOMAIN_CONTEXT_KEY]: validateDomainContext(context, { now, tool: 'records.lookup', args, connection: 'records' }),
    } }]);
    assert.notEqual(seen.calls[0]._meta[DOMAIN_CONTEXT_KEY], context);
    assert.equal(Object.isFrozen(seen.calls[0]._meta[DOMAIN_CONTEXT_KEY]), true);
  } finally { await mcp.close(); }
});

test('opted-in calls reject missing, expired, altered or argument-mismatched context before dispatch', async () => {
  const { mcp, seen } = fixture();
  try {
    for (const value of [undefined, null, { ...context, expiresAt: now }, { ...context, issuedAt: now + 1 },
      { ...context, tool: 'other.lookup' }, { ...context, argsHash: digest({ query: 'other' }) },
      { ...context, extra: 'PRIVATE' }]) {
      await assert.rejects(mcp.call('records.lookup', args, { context: value }), error => {
        assert.equal(error.diagnosticCode, 'access-denied');
        assert.doesNotMatch(String(error), /PRIVATE|alice|synthetic/);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.equal(seen.calls.length, 0);
  } finally { await mcp.close(); }
});

test('actor context is revalidated after discovery using the injected dispatch clock', async () => {
  let clockValue = now;
  const { mcp, seen } = fixture({ clock: () => clockValue });
  try {
    await mcp.listTools();
    clockValue = now + 1000;
    await assert.rejects(mcp.call('records.lookup', args, { context }), { diagnosticCode: 'access-denied' });
    assert.equal(seen.calls.length, 0);
  } finally { await mcp.close(); }
});

test('generic stdio and HTTP calls ignore context and never transmit actor metadata', async () => {
  for (const transport of ['stdio', 'streamable-http']) {
    const { mcp, seen } = fixture({ actorContext: 'absent', transport });
    try {
      await mcp.call('records.lookup', args, { context });
      await mcp.call('records.lookup', args, { context: { malformed: true } });
      assert.deepEqual(seen.calls, Array(2).fill({ name: 'lookup', arguments: args }));
    } finally { await mcp.close(); }
  }
});

test('direct MCP configuration rejects HTTP actor context and incompatible opt-ins without connecting', () => {
  let factories = 0;
  const deps = { clientFactory: async () => { factories += 1; } };
  for (const actor_context of ['mail-agent-v1', '', 'other', null, false]) {
    assert.throws(() => createMcp({ records: { transport: 'streamable-http',
      url: 'https://records.example.test/mcp', actor_context } }, deps), { diagnosticCode: 'configuration' });
  }
  for (const actor_context of ['other', '', null, false]) {
    assert.throws(() => createMcp({ records: { transport: 'stdio', command: 'node', actor_context } }, deps),
      { diagnosticCode: 'configuration' });
  }
  const inherited = Object.assign(Object.create({ actor_context: 'mail-agent-v1' }), {
    transport: 'streamable-http', url: 'https://records.example.test/mcp',
  });
  assert.throws(() => createMcp({ records: inherited }, deps), { diagnosticCode: 'configuration' });
  assert.equal(factories, 0);
});

test('actual SDK stdio handshake carries the negotiated context in tools/call metadata', async () => {
  const source = `
    const lines = require('node:readline').createInterface({ input: process.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, experimental: { '${DOMAIN_CONTEXT_KEY}': { version: 1 } } },
        serverInfo: { name: 'synthetic', version: '1' } };
      if (message.method === 'tools/list') result = { tools: [{ name: 'lookup', inputSchema: ${JSON.stringify(inputSchema)} }] };
      if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(message.params) }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `;
  const mcp = createMcp({ records: { transport: 'stdio', command: 'node', args: ['-e', source],
    env: [], actor_context: 'mail-agent-v1' } }, { env: {}, clock: () => now });
  try {
    const result = await mcp.call('records.lookup', args, { context });
    assert.deepEqual(JSON.parse(result.content[0].text), { name: 'lookup', arguments: args,
      _meta: { [DOMAIN_CONTEXT_KEY]: context } });
  } finally { await mcp.close(); }
});
