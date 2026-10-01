import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createGraph } from '../src/graph.mjs';

const server = `
  const lines = require('node:readline').createInterface({ input: process.stdin });
  const fs = require('node:fs');
  lines.on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }
    };
    if (request.method === 'tools/list') result = { tools: [
      { name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object', additionalProperties: false } },
      { name: 'append', description: 'Fixture append', inputSchema: {
        type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false
      } }
    ] };
    if (request.method === 'tools/call') {
      if (request.params.name === 'append') fs.appendFileSync(process.env.SYNTHETIC_WRITE_LOG, 'write\\n');
      result = { content: [{ type: 'text', text: 'Confirmed fixture result' }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  });
`;

function graphMessage() {
  const actor = { emailAddress: { address: 'alice@example.org' } };
  return {
    id: 'immutable-1', conversationId: 'conversation-1', from: actor, sender: actor,
    toRecipients: [{ emailAddress: { address: 'assistant@example.org' } }], ccRecipients: [],
    subject: 'Synthetic request', uniqueBody: { contentType: 'text', content: 'Look up a record and propose a note.' },
    receivedDateTime: '2026-01-01T00:00:00Z', hasAttachments: false,
    internetMessageHeaders: [{ name: 'Authentication-Results', value: 'mx.example.org; dmarc=pass header.from=example.org' }]
  };
}

function completion(message) {
  return new Response(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 10 }
  }), { headers: { 'content-type': 'application/json' } });
}

test('configured SDK, real stdio MCP, durable approval and Graph reply compose without repeated writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ma-acceptance-'));
  const runtimes = [];
  t.after(async () => { for (const runtime of runtimes.reverse()) await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  const config = parse(await readFile(new URL('../examples/text-inbox/agent.yaml', import.meta.url), 'utf8'));
  config.mailbox.sender_authentication = { mode: 'exchange-authenticated', trusted_authserv_ids: ['mx.example.org'], transport_headers_verified: true };
  config.model.capabilities.tools = true;
  config.policy.approvers = ['operator@example.org'];
  config.mcp = { fixture: { transport: 'stdio', command: 'node', args: ['-e', server], env: ['SYNTHETIC_WRITE_LOG'], pinned_version: 'fixture-1', authorization_scope: 'sender-group' } };
  config.policy.tools = {
    'fixture.lookup': { effect: 'read', authorization: 'automatic' },
    'fixture.append': { effect: 'write', authorization: 'approval' }
  };
  await writeFile(join(root, 'agent.yaml'), stringify(config));
  await writeFile(join(root, 'AGENT.md'), 'Use the configured tools and report confirmed results.');
  const loaded = await loadConfig(join(root, 'agent.yaml'));
  const env = { INBOX_GRAPH_CLIENT_SECRET: 'synthetic-secret', INBOX_MODEL_API_KEY: 'synthetic-key', SYNTHETIC_WRITE_LOG: join(root, 'writes.txt') };
  let modelCalls = 0, sends = 0, sentText;
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) return new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600 }));
    if (url.startsWith('https://graph.microsoft.com/')) {
      if (init.method === 'POST') { sends++; sentText = JSON.parse(init.body).message.body.content; assert.equal(JSON.parse(init.body).message.body.contentType, 'Text'); return new Response(null, { status: 202 }); }
      if (url.includes('/attachments?')) return new Response(JSON.stringify({ value: [] }));
      return new Response(JSON.stringify(graphMessage()));
    }
    assert.equal(url, 'https://models.example.org/v1/chat/completions');
    const body = JSON.parse(init.body);
    modelCalls++;
    if (modelCalls === 4) return completion({ role: 'assistant', content: 'The note was confirmed.' });
    const description = modelCalls === 1 ? 'Fixture lookup' : 'Fixture append';
    const name = body.tools.find(tool => tool.function.description === description).function.name;
    return completion({ role: 'assistant', content: null, tool_calls: [{ id: `call-${modelCalls}`, type: 'function', function: { name, arguments: modelCalls === 1 ? '{}' : '{"text":"Synthetic note"}' } }] });
  };
  const mail = createGraph(loaded.config.mailbox, { env, fetchImpl });
  const message = await mail.getMessage('immutable-1');
  const settings = { ...loaded, mode: 'live', env, fetchImpl };
  const first = await createRuntime(settings); runtimes.push(first);
  assert.equal((await first.processMessage(message)).status, 'awaiting_approval', JSON.stringify({ modelCalls, sentText }));
  assert.equal(modelCalls, 2);
  await assert.rejects(readFile(env.SYNTHETIC_WRITE_LOG), { code: 'ENOENT' });
  const [approval] = first.approvals();
  await first.stop();
  const resumed = await createRuntime(settings); runtimes.push(resumed);
  await resumed.approve({ id: approval.id, actor: 'operator@example.org', reason: 'Approve this exact fixture note.' });
  assert.equal((await resumed.processMessage(message)).status, 'completed');
  assert.equal(await readFile(env.SYNTHETIC_WRITE_LOG, 'utf8'), 'write\n');
  assert.equal(modelCalls, 4);
  assert.equal(sends, 1);
  assert.equal((await resumed.processMessage(message)).status, 'completed');
  assert.equal(modelCalls, 4);
  assert.equal(sends, 1);
});
