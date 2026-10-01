import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { classifyDiagnostic } from '../src/diagnostics-errors.mjs';

async function bundle() {
  const root = await mkdtemp(join(tmpdir(), 'mail-config-'));
  await cp(new URL('../examples/text-inbox/', import.meta.url), root, { recursive: true });
  return { root, filename: join(root, 'agent.yaml') };
}
async function edit(filename, transform) {
  await writeFile(filename, transform(await readFile(filename, 'utf8')));
}

test('loads an offline bundle, defaults limits, and hashes without secrets', async () => {
  const { root, filename } = await bundle();
  const first = await loadConfig(filename, { env: { INBOX_MODEL_API_KEY: 'first' } });
  const second = await loadConfig(filename, { env: { INBOX_MODEL_API_KEY: 'second' } });
  assert.equal(first.root, await realpath(root));
  assert.equal(first.filename, filename);
  assert.equal(first.config.state_root, join(await realpath(root), 'state'));
  assert.equal(first.config.limits.model_calls, 6);
  assert.equal(first.hash, second.hash);
  assert.match(first.instructions, /Text inbox/);
  assert.ok(!JSON.stringify(first).includes('first'));
});

test('requires configured secrets only for live operation', async () => {
  const { filename } = await bundle();
  await assert.rejects(loadConfig(filename, { env: {}, requireSecrets: true }), /INBOX_GRAPH_CLIENT_SECRET/);
  await loadConfig(filename, { env: { INBOX_GRAPH_CLIENT_SECRET: 'secret', INBOX_MODEL_API_KEY: 'key' }, requireSecrets: true });
});

test('configuration and instruction failures carry safe diagnostic classifications', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('https://models.example.org/v1', 'http://models.example.org/v1'));
  await assert.rejects(loadConfig(filename), error => classifyDiagnostic(error) === 'endpoint-policy');
  await edit(filename, s => s.replace('http://models.example.org/v1', 'https://models.example.org/v1'));
  await edit(filename, s => s.replace('agent: AGENT.md', 'agent: absent-private-file.md'));
  await assert.rejects(loadConfig(filename), error => {
    assert.equal(classifyDiagnostic(error), 'instruction-files');
    assert.equal(error.cause, undefined);
    return true;
  });
});

for (const [name, transform, expected] of [
  ['unknown fields', s => s + '\nundocumented: true\n', /additional|unknown/i],
  ['unsupported images', s => s.replace('images: false', 'images: true'), /images.*unsupported/i],
  ['unsupported PDF', s => s.replace('pdf: false', 'pdf: true'), /pdf.*unsupported/i],
  ['unsupported draft delivery', s => s.replace('direct-reply', 'draft'), /delivery|draft/i],
  ['unsupported reply-all', s => s.replace('reply: sender', 'reply: all'), /reply/i],
  ['insecure endpoint', s => s.replace('https://models', 'http://models'), /HTTPS/i],
  ['absent sender authentication', s => s.replace(/ {2}sender_authentication:\n {4}mode: exchange-authenticated\n {4}trusted_authserv_ids: \[example.org\]\n {4}transport_headers_verified: false\n/, ''), /sender_authentication/],
  ['empty sender allowlist', s => s.replace('senders: [alice@example.org]', 'senders: []'), /senders|fewer/i],
  ['invalid sender address', s => s.replace('senders: [alice@example.org]', 'senders: [not-mail]'), /email|sender/i],
  ['excessive model budget', s => s + '\nlimits:\n  model_calls: 99999\n', /model_calls|maximum/i],
]) {
  test(`rejects ${name}`, async () => {
    const { filename } = await bundle();
    await edit(filename, transform);
    await assert.rejects(loadConfig(filename), expected);
  });
}

test('rejects instructions escaping the bundle via a symlink', async () => {
  const { root, filename } = await bundle();
  const external = await mkdtemp(join(tmpdir(), 'mail-external-'));
  await writeFile(join(external, 'secret.md'), 'outside instructions');
  await symlink(join(external, 'secret.md'), join(root, 'outside.md'));
  await edit(filename, s => s.replace('agent: AGENT.md', 'agent: outside.md'));
  await assert.rejects(loadConfig(filename), /within.*bundle/i);
});

test('requires tools capability and explicit policy for configured MCP tools', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('mcp: {}', 'mcp:\n  documents:\n    transport: streamable-http\n    url: https://documents.example.org/mcp\n    token_env: DOCUMENTS_TOKEN\n    authorization_scope: sender-group'));
  await assert.rejects(loadConfig(filename), /tools capability/i);
});

test('HTTP fixtures require explicit local opt-in', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('https://models.example.org/v1', 'http://127.0.0.1:1234/v1').replace('  api: chat-completions', '  api: chat-completions\n  allow_insecure: true'));
  assert.equal((await loadConfig(filename)).config.model.allow_insecure, true);
  await edit(filename, s => s.replace('127.0.0.1', 'models.example.org'));
  await assert.rejects(loadConfig(filename), /HTTPS/);
});

test('MCP defaults have bounded deadlines and only explicitly listed environment names', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('tools: false', 'tools: true').replace('mcp: {}', 'mcp:\n  documents:\n    transport: stdio\n    command: node\n    pinned_version: 1.0.0\n    authorization_scope: sender-group'));
  const loaded = await loadConfig(filename);
  assert.deepEqual(loaded.config.mcp.documents.env, []);
  assert.equal(loaded.config.mcp.documents.timeout_ms, 30000);
  assert.equal(loaded.config.mcp.documents.max_response_bytes, 1048576);
  await edit(filename, s => s.replace('    command: node', '    command: arbitrary-from-path'));
  await assert.rejects(loadConfig(filename), /explicit path/);
});

test('instruction changes alter the approval snapshot hash', async () => {
  const { root, filename } = await bundle();
  const before = await loadConfig(filename);
  await writeFile(join(root, 'AGENT.md'), 'A different authorized procedure.');
  assert.notEqual((await loadConfig(filename)).hash, before.hash);
});

async function toolBundle(policy) {
  const result = await bundle();
  await edit(result.filename, s => s.replace('tools: false', 'tools: true')
    .replace('  tools: {}', `  tools:\n    documents.update: ${JSON.stringify(policy)}`)
    .replace('mcp: {}', 'mcp:\n  documents:\n    transport: stdio\n    command: node\n    pinned_version: 1.0.0\n    authorization_scope: sender-group'));
  return result;
}

test('automatic writes require actual bounds on tool arguments', async () => {
  for (const constraints of [undefined, {}, { type: 'object' }, {
    type: 'object', properties: { optional: { type: 'string', maxLength: 5 } },
  }]) {
    const policy = { effect: 'write', authorization: 'automatic', ...(constraints ? { constraints } : {}) };
    const { filename } = await toolBundle(policy);
    await assert.rejects(loadConfig(filename), /bounded constraints/i);
  }
  const { filename } = await toolBundle({ effect: 'write', authorization: 'automatic', constraints: {
    type: 'object', properties: { status: { type: 'string', enum: ['reviewed'] } }, required: ['status'], additionalProperties: false,
  } });
  await loadConfig(filename);
});

test('unknown policy constraint keywords fail closed', async () => {
  const { filename } = await toolBundle({ effect: 'read', authorization: 'automatic', constraints: { type: 'object', misspelledRestriction: true } });
  await assert.rejects(loadConfig(filename), /constraints JSON Schema/i);
});

test('domain actor context is an explicit stdio opt-in and rejects automatic writes', async () => {
  const { filename } = await toolBundle({ effect: 'read', authorization: 'automatic' });
  await edit(filename, s => s.replace('    authorization_scope: sender-group', '    authorization_scope: sender-group\n    actor_context: mail-agent-v1'));
  assert.equal((await loadConfig(filename)).config.mcp.documents.actor_context, 'mail-agent-v1');

  const write = await toolBundle({ effect: 'write', authorization: 'automatic', constraints: {
    type: 'object', properties: { status: { enum: ['reviewed'] } }, required: ['status'], additionalProperties: false,
  } });
  await edit(write.filename, s => s.replace('    authorization_scope: sender-group', '    authorization_scope: sender-group\n    actor_context: mail-agent-v1'));
  await assert.rejects(loadConfig(write.filename), /automatic writes/i);
});

test('HTTP MCP cannot opt into trusted actor context', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('mcp: {}', 'mcp:\n  documents:\n    transport: streamable-http\n    url: https://documents.example.org/mcp\n    token_env: DOCUMENTS_TOKEN\n    authorization_scope: sender-group\n    actor_context: mail-agent-v1'));
  await assert.rejects(loadConfig(filename), /additional|actor_context|configuration/i);
});

test('same-tenant internal mail requires an explicit profile, sender domains and GUID tenant', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('mode: exchange-authenticated', 'mode: exchange-internal')
    .replace('trusted_authserv_ids: [example.org]', 'sender_domains: [example.org]')
    .replace('tenant_id: example-tenant', 'tenant_id: 11111111-1111-1111-1111-111111111111'));
  assert.equal((await loadConfig(filename)).config.mailbox.sender_authentication.mode, 'exchange-internal');
  await edit(filename, s => s.replace('sender_domains: [example.org]', 'sender_domains: []'));
  await assert.rejects(loadConfig(filename), /sender_domains|fewer/i);
});

test('internal authentication rejects tenant aliases and mixed-profile declarations', async () => {
  const { filename } = await bundle();
  await edit(filename, s => s.replace('mode: exchange-authenticated', 'mode: exchange-internal')
    .replace('trusted_authserv_ids: [example.org]', 'sender_domains: [example.org]'));
  await assert.rejects(loadConfig(filename), /GUID tenant/i);
  await edit(filename, s => s.replace('tenant_id: example-tenant', 'tenant_id: 11111111-1111-1111-1111-111111111111')
    .replace('sender_domains: [example.org]', 'sender_domains: [example.org]\n    trusted_authserv_ids: [example.org]'));
  await assert.rejects(loadConfig(filename), /configuration/i);
});
