import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createMcp } from '../src/mcp.mjs';
import { classifyDiagnostic } from '../src/diagnostics-errors.mjs';

const inputSchema = {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
};
function fakeClient(overrides = {}) {
  return {
    listTools: async () => ({ tools: [{ name: 'search', description: 'Search', inputSchema }] }),
    callTool: async ({ name, arguments: args }) => ({ content: [{ type: 'text', text: `${name}: ${args.query}` }] }),
    close: async () => {}, ...overrides,
  };
}
function registry(client, settings = {}) {
  return createMcp({ documents: {
    transport: 'stdio', command: './server.mjs', args: [], env: ['DOCUMENT_TOKEN'], ...settings,
  } }, { root: '/tmp/mail-agent-fixture', env: { DOCUMENT_TOKEN: 'synthetic', OTHER_SECRET: 'never' }, clientFactory: async () => client });
}

test('MCP lists namespaced tools and validates arguments before execution', async () => {
  let calls = 0;
  const mcp = registry(fakeClient({ callTool: async () => { calls += 1; return { content: [{ type: 'text', text: 'Found' }] }; } }));
  const listed = await mcp.listTools();
  assert.deepEqual([...listed.keys()], ['documents.search']);
  assert.deepEqual(await mcp.call('documents.search', { query: 'manual' }), { content: [{ type: 'text', text: 'Found' }] });
  await assert.rejects(mcp.call('documents.search', { query: 1 }), /Invalid MCP tool arguments/);
  await assert.rejects(mcp.call('documents.search', { query: 'manual', extra: true }), /Invalid MCP tool arguments/);
  assert.equal(calls, 1);
  await mcp.close();
});

test('MCP denies unknown connections and tools', async () => {
  let calls = 0;
  const mcp = registry(fakeClient({ callTool: async () => { calls += 1; return {}; } }));
  await assert.rejects(mcp.call('other.search', { query: 'a' }), /Unknown MCP tool/);
  await assert.rejects(mcp.call('documents.erase', {}), /Unknown MCP tool/);
  assert.equal(calls, 0);
  await mcp.close();
});

test('stdio factory receives only the explicitly scoped environment', async () => {
  let options;
  const mcp = createMcp({ documents: { transport: 'stdio', command: './server.mjs', args: ['--fixture'], env: ['DOCUMENT_TOKEN'] } }, {
    root: '/tmp/mail-agent-fixture', env: { DOCUMENT_TOKEN: 'synthetic', OTHER_SECRET: 'never', PATH: '/private' },
    clientFactory: async (value) => { options = value; return fakeClient(); },
  });
  await mcp.listTools();
  assert.deepEqual(options.env, { DOCUMENT_TOKEN: 'synthetic' });
  assert.equal(options.command, '/tmp/mail-agent-fixture/server.mjs');
  assert.deepEqual(options.args, ['--fixture']);
  await mcp.close();
});

test('MCP errors and oversize results are safely rejected', async () => {
  const failure = registry(fakeClient({ callTool: async () => ({ isError: true, content: [{ type: 'text', text: 'secret detail' }] }) }));
  await assert.rejects(failure.call('documents.search', { query: 'manual' }), error => {
    assert.equal(error.message, 'MCP tool failed');
    assert.equal(classifyDiagnostic(error), 'tool-unavailable');
    return true;
  });
  await failure.close();
  const oversize = registry(fakeClient({ callTool: async () => ({ content: [{ type: 'text', text: 'x'.repeat(300) }] }) }), { max_response_bytes: 100 });
  await assert.rejects(oversize.call('documents.search', { query: 'manual' }), /MCP response exceeded limit/);
  await oversize.close();
});

test('MCP preserves safe timeout and dependency diagnostics across SDK error handling', async () => {
  const timeout = registry(fakeClient({ callTool: async () => { throw Object.assign(new Error('private token detail'), { code: 'ETIMEDOUT' }); } }));
  await assert.rejects(timeout.call('documents.search', { query: 'manual' }), error => {
    assert.equal(error.message, 'MCP request timed out');
    assert.equal(classifyDiagnostic(error), 'timeout');
    assert.doesNotMatch(String(error), /private token detail/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await timeout.close();
});

test('MCP request timeout bounds a client that ignores cancellation', async () => {
  const mcp = registry(fakeClient({ callTool: async () => new Promise(() => {}) }), { timeout_ms: 10 });
  await assert.rejects(mcp.call('documents.search', { query: 'manual' }), /MCP request timed out/);
  await mcp.close();
});

test('caller cancellation aborts the MCP request', async () => {
  const mcp = registry(fakeClient({ callTool: async () => new Promise(() => {}) }));
  await mcp.listTools();
  const controller = new AbortController();
  const pending = mcp.call('documents.search', { query: 'manual' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /MCP request cancelled/);
  await mcp.close();
});

test('HTTP credentials and request endpoint are constrained', async () => {
  let options;
  const mcp = createMcp({ documents: { transport: 'streamable-http', url: 'https://documents.example.test/mcp', token_env: 'DOCUMENT_TOKEN' } }, {
    env: { DOCUMENT_TOKEN: 'synthetic', OTHER_SECRET: 'never' },
    clientFactory: async (value) => { options = value; return fakeClient(); },
  });
  await mcp.listTools();
  assert.equal(options.url, 'https://documents.example.test/mcp');
  assert.deepEqual(options.headers, { Authorization: 'Bearer synthetic' });
  await assert.rejects(options.fetch('https://evil.example.test/mcp', {}), /Unconfigured MCP endpoint/);
  await mcp.close();
});

test('Streamable HTTP preserves GET 405 fallback and sanitizes HTTP auth errors', async () => {
  async function withServer(handler, operation) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    try { await operation(`http://127.0.0.1:${address.port}/mcp`); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }

  let sawGet = false;
  await withServer((request, response) => {
    if (request.method === 'GET') {
      sawGet = true;
      response.writeHead(405).end('private get diagnostic');
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      response.setHeader('content-type', 'application/json');
      if (message.method === 'initialize') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
        } }));
      } else if (message.method === 'notifications/initialized') response.writeHead(202).end();
      else if (message.method === 'tools/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
      else response.writeHead(400).end('private request detail');
    });
  }, async url => {
    const mcp = createMcp({ documents: { transport: 'streamable-http', url, allow_insecure: true } });
    assert.deepEqual([...await mcp.listTools()], []);
    assert.equal(sawGet, true);
    await mcp.close();
  });

  for (const [status, expected] of [[401, 'credential'], [403, 'access-denied']]) {
    await withServer((_request, response) => response.writeHead(status).end('private authorization body'), async url => {
      const mcp = createMcp({ documents: { transport: 'streamable-http', url, allow_insecure: true } });
      await assert.rejects(mcp.listTools(), error => {
        assert.equal(classifyDiagnostic(error), expected);
        assert.doesNotMatch(String(error), /private authorization body/);
        assert.equal(error.cause, undefined);
        return true;
      });
      await mcp.close();
    });
  }
});

test('official stdio transport does not inherit ambient variables', async () => {
  const inheritedName = 'MAIL_AGENT_UNSCOPED_TEST';
  const previous = process.env[inheritedName];
  process.env[inheritedName] = 'synthetic-unscoped';
  const source = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result;
      if (message.method === 'initialize') result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' }
      };
      if (message.method === 'tools/list') result = { tools: [
        { name: 'environment', inputSchema: { type: 'object' } }
      ] };
      if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({
        allowed: process.env.DOCUMENT_TOKEN ?? null,
        unscoped: process.env.MAIL_AGENT_UNSCOPED_TEST ?? null,
        home: process.env.HOME ?? null, path: process.env.PATH ?? null
      }) }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `;
  const mcp = createMcp({ synthetic: {
    transport: 'stdio', command: 'node', args: ['-e', source], env: ['DOCUMENT_TOKEN'],
  } }, { env: { DOCUMENT_TOKEN: 'synthetic' } });
  try {
    const result = await mcp.call('synthetic.environment', {});
    assert.deepEqual(JSON.parse(result.content[0].text), {
      allowed: 'synthetic', unscoped: null, home: null, path: null,
    });
  } finally {
    await mcp.close();
    if (previous === undefined) delete process.env[inheritedName];
    else process.env[inheritedName] = previous;
  }
});

test('HTTP response body bounds and redirects are enforced', async () => {
  const originalFetch = globalThis.fetch;
  let options;
  const mcp = createMcp({ documents: {
    transport: 'streamable-http', url: 'https://documents.example.test/mcp', max_response_bytes: 100,
  } }, { clientFactory: async (value) => { options = value; return fakeClient({ listTools: async () => ({ tools: [] }) }); } });
  try {
    await mcp.listTools();
    globalThis.fetch = async (_input, init) => {
      assert.equal(init.redirect, 'error');
      return new Response('x'.repeat(101));
    };
    const response = await options.fetch(options.url);
    await assert.rejects(response.text(), /MCP response exceeded limit/);
    globalThis.fetch = async () => new Response('x', { headers: { 'content-length': '101' } });
    await assert.rejects(options.fetch(options.url), /MCP response exceeded limit/);
  } finally {
    globalThis.fetch = originalFetch;
    await mcp.close();
  }
});

test('only explicitly enabled local HTTP MCP is permitted', () => {
  assert.throws(() => createMcp({ documents: {
    transport: 'streamable-http', url: 'http://external.example.test/mcp', allow_insecure: true,
  } }), /Invalid MCP endpoint/);
  assert.doesNotThrow(() => createMcp({ documents: {
    transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', allow_insecure: true,
  } }));
});

test('cancellation while MCP discovery is pending prevents tool execution', async () => {
  let calls = 0;
  const mcp = registry(fakeClient({
    listTools: async () => new Promise(() => {}),
    callTool: async () => { calls += 1; return {}; },
  }), { timeout_ms: 25 });
  const controller = new AbortController();
  const pending = mcp.call('documents.search', { query: 'a' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /MCP request cancelled/);
  assert.equal(calls, 0);
  await mcp.close();
});

test('transient discovery failure closes partial clients and allows a fresh attempt', async () => {
  let attempts = 0;
  let closes = 0;
  const mcp = createMcp({ documents: {
    transport: 'stdio', command: 'node', args: [], env: [],
  } }, { clientFactory: async () => {
    attempts += 1;
    return fakeClient({
      listTools: async () => {
        if (attempts === 1) throw new Error('private discovery failure');
        return { tools: [{ name: 'search', inputSchema }] };
      },
      close: async () => { closes += 1; },
    });
  } });
  await assert.rejects(mcp.listTools(), /^Error: MCP request failed$/);
  assert.equal(closes, 1);
  assert.deepEqual([...await mcp.listTools()].map(([name]) => name), ['documents.search']);
  assert.equal(attempts, 2);
  await mcp.close();
  assert.equal(closes, 2);
});

test('discovery caller cancellation preserves the shared connection and completed cache', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let complete;
  const listing = new Promise(resolve => { complete = resolve; });
  let factories = 0;
  let closes = 0;
  const mcp = createMcp({ documents: { transport: 'stdio', command: 'node', env: [] } }, {
    clientFactory: async () => {
      factories += 1;
      return fakeClient({ listTools: async () => { started(); return listing; }, close: async () => { closes += 1; } });
    },
  });
  const controller = new AbortController();
  const pending = mcp.listTools({ signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(pending, /MCP request cancelled/);
  assert.equal(closes, 0);
  complete({ tools: [{ name: 'search', inputSchema }] });
  assert.ok((await mcp.listTools()).has('documents.search'));
  assert.equal(factories, 1);
  await mcp.close();
  assert.equal(closes, 1);
});

test('registry close aborts discovery and closes a factory client that resolves later', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let complete;
  const connecting = new Promise(resolve => { complete = resolve; });
  let disposed;
  const disposal = new Promise(resolve => { disposed = resolve; });
  const mcp = createMcp({ documents: { transport: 'stdio', command: 'node', env: [] } }, {
    clientFactory: async () => { started(); return connecting; },
  });
  const pending = mcp.listTools();
  await entered;
  const rejected = assert.rejects(pending, /cancelled|closed/);
  await mcp.close();
  await rejected;
  complete(fakeClient({ close: async () => { disposed(); } }));
  await disposal;
  await assert.rejects(mcp.listTools(), /registry closed/);
});
