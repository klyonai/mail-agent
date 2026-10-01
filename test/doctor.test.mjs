import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDoctor, runDoctor } from '../src/doctor.mjs';

async function bundle({ tools = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mail-doctor-'));
  await mkdir(join(root, 'state'));
  await chmod(join(root, 'state'), 0o700);
  await writeFile(join(root, 'AGENT.md'), 'Answer simple text questions.');
  let yaml = await readFile(new URL('../examples/text-inbox/agent.yaml', import.meta.url), 'utf8');
  yaml = yaml.replace('state_root: ./state', 'state_root: ./state')
    .replace('example-tenant', 'tenant-123')
    .replace('example-application', 'app-123')
    .replace('assistant@example.org', 'assistant@tenant.test')
    .replace('trusted_authserv_ids: [example.org]', 'trusted_authserv_ids: [mx.tenant.test]')
    .replace('transport_headers_verified: false', 'transport_headers_verified: true')
    .replace('https://models.example.org/v1', 'https://models.tenant.test/v1')
    .replace('example-model', 'model-v1')
    .replaceAll('alice@example.org', 'alice@tenant.test')
    .replace('INBOX_GRAPH_CLIENT_SECRET', 'DOCTOR_GRAPH_SECRET')
    .replace('INBOX_MODEL_API_KEY', 'DOCTOR_MODEL_KEY');
  if (tools) {
    yaml = yaml.replace('tools: false', 'tools: true')
      .replace('  tools: {}', '  tools:\n    documents.lookup: { effect: read, authorization: automatic }\nmcp:\n  documents:\n    transport: streamable-http\n    url: https://mcp.tenant.test/mcp\n    token_env: DOCTOR_MCP_TOKEN\n    authorization_scope: sender-group')
      .replace('mcp: {}', '');
  }
  const filename = join(root, 'agent.yaml');
  await writeFile(filename, yaml);
  return { root, filename, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const env = { DOCTOR_GRAPH_SECRET: 'synthetic-graph', DOCTOR_MODEL_KEY: 'synthetic-model' };

test('model probes reserve a bounded final-answer budget for reasoning models', async () => {
  const fixture = await bundle({ tools: true });
  try {
    const budgets = [];
    const report = await runDoctor(fixture.filename, {
      live: true, env: { ...env, DOCTOR_MCP_TOKEN: 'synthetic-mcp' },
      createMail: async () => ({ check: async () => ({ status: 'ready' }) }),
      createModel: async () => ({ step: async ({ tools, maxOutputTokens }) => {
        budgets.push(maxOutputTokens);
        if (maxOutputTokens < 512) return { text: '', toolCalls: [] };
        return tools.has('doctor.probe')
          ? { text: '', toolCalls: [{ name: 'doctor.probe', args: { marker: 'probe' } }] }
          : { text: 'OK', toolCalls: [] };
      } }),
      createMcp: async () => ({ listTools: async () => new Map([['documents.lookup', {}]]), close: async () => {} }),
    });
    assert.equal(report.checks.find(check => check.id === 'model').status, 'pass');
    assert.deepEqual(budgets, [512, 512]);
  } finally { await fixture.cleanup(); }
});

test('model probes respect configured output limits and accept text with an exact tool call', async () => {
  const fixture = await bundle({ tools: true });
  try {
    await writeFile(fixture.filename, `${await readFile(fixture.filename, 'utf8')}\nlimits:\n  output_tokens: 64\n`);
    const budgets = [];
    const report = await runDoctor(fixture.filename, {
      live: true, env: { ...env, DOCTOR_MCP_TOKEN: 'synthetic-mcp' },
      createMail: async () => ({ check: async () => ({ status: 'ready' }) }),
      createModel: async () => ({ step: async ({ tools, maxOutputTokens }) => {
        budgets.push(maxOutputTokens);
        return tools.has('doctor.probe')
          ? { text: 'Generating the synthetic probe call.', toolCalls: [{ name: 'doctor.probe', args: { marker: 'probe' } }] }
          : { text: 'OK', toolCalls: [] };
      } }),
      createMcp: async () => ({ listTools: async () => new Map([['documents.lookup', {}]]), close: async () => {} }),
    });
    assert.equal(report.checks.find(check => check.id === 'model').status, 'pass');
    assert.deepEqual(budgets, [64, 64]);
  } finally { await fixture.cleanup(); }
});

test('offline doctor checks bundle safely and constructs no external adapters', async () => {
  const fixture = await bundle();
  try {
    let constructed = 0;
    const report = await runDoctor(fixture.filename, {
      env,
      createMail: () => { constructed += 1; throw new Error('must not run'); },
      createModel: () => { constructed += 1; throw new Error('must not run'); },
      createMcp: () => { constructed += 1; throw new Error('must not run'); },
    });
    assert.equal(constructed, 0);
    assert.equal(report.command, 'doctor');
    assert.equal(report.mode, 'offline');
    assert.equal(report.externalMutations, false);
    assert.equal(report.ready, true);
    assert.equal(report.checks.find(check => check.id === 'model').status, 'not-checked');
    assert.equal(report.checks.find(check => check.id === 'state').status, 'pass');
  } finally { await fixture.cleanup(); }
});

test('offline doctor reports missing secret names and never displays values', async () => {
  const fixture = await bundle();
  try {
    const report = await runDoctor(fixture.filename, { env: { DOCTOR_GRAPH_SECRET: 'private-secret' } });
    const secrets = report.checks.find(check => check.id === 'secrets');
    assert.equal(secrets.status, 'fail');
    assert.match(secrets.message, /DOCTOR_MODEL_KEY/);
    assert.doesNotMatch(JSON.stringify(report), /private-secret/);
    assert.equal(report.ready, false);
  } finally { await fixture.cleanup(); }
});

test('invalid configuration returns fixed diagnostics and marks dependencies not checked', async () => {
  const report = await runDoctor('/unused/config.yaml', {
    live: true,
    load: async () => { throw new Error('private body and token: SECRET'); },
  });
  assert.equal(report.mode, 'live');
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'configuration').status, 'fail');
  assert.ok(report.checks.filter(check => ['mailbox', 'model', 'mcp'].includes(check.id)).every(check => check.status === 'not-checked'));
  assert.doesNotMatch(JSON.stringify(report), /private body|SECRET/);
});

test('live doctor continues independent probes and never invokes MCP tools', async () => {
  const fixture = await bundle({ tools: true });
  try {
    const calls = { graph: 0, model: 0, mcp: 0, mcpClose: 0, toolCalls: 0 };
    const report = await runDoctor(fixture.filename, {
      live: true,
      env: { ...env, DOCTOR_MCP_TOKEN: 'synthetic-mcp' },
      createMail: async () => ({ check: async () => { calls.graph += 1; throw Object.assign(new Error('private provider detail'), { diagnosticCode: 'access-denied' }); } }),
      createModel: async () => ({ step: async ({ tools: available }) => {
        calls.model += 1;
        return available.has('doctor.probe')
          ? { text: '', toolCalls: [{ name: 'doctor.probe', args: { marker: 'probe' } }] }
          : { text: 'OK', toolCalls: [] };
      } }),
      createMcp: async () => ({
        listTools: async () => { calls.mcp += 1; return new Map([['documents.lookup', { inputSchema: {} }]]); },
        call: async () => { calls.toolCalls += 1; throw new Error('must not execute'); },
        close: async () => { calls.mcpClose += 1; },
      }),
    });
    assert.equal(report.mode, 'live');
    assert.equal(report.externalMutations, false);
    assert.equal(report.ready, false);
    assert.equal(report.checks.find(check => check.id === 'mailbox').code, 'access-denied');
    assert.equal(report.checks.find(check => check.id === 'model').status, 'pass');
    assert.equal(report.checks.find(check => check.id === 'mcp').status, 'pass');
    assert.deepEqual(calls, { graph: 1, model: 2, mcp: 1, mcpClose: 1, toolCalls: 0 });
    assert.doesNotMatch(JSON.stringify(report), /private provider detail|synthetic-mcp/);
  } finally { await fixture.cleanup(); }
});

test('state diagnostics do not create or chmod a missing directory', async () => {
  const fixture = await bundle();
  try {
    const missing = join(fixture.root, 'new-state');
    const config = (await readFile(fixture.filename, 'utf8')).replace('state_root: ./state', 'state_root: ./new-state');
    await writeFile(fixture.filename, config);
    const report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'pass');
    await assert.rejects(readFile(join(missing, 'anything')));
  } finally { await fixture.cleanup(); }
});

test('live doctor skips every service when placeholders remain', async () => {
  const fixture = await bundle();
  try {
    const config = (await readFile(fixture.filename, 'utf8')).replace('https://models.tenant.test/v1', 'https://models.example.org/v1');
    await writeFile(fixture.filename, config);
    let constructed = 0;
    const report = await runDoctor(fixture.filename, {
      live: true, env,
      createMail: () => { constructed += 1; throw new Error('must not run'); },
      createModel: () => { constructed += 1; throw new Error('must not run'); },
      createMcp: () => { constructed += 1; throw new Error('must not run'); },
    });
    assert.equal(report.mode, 'live');
    assert.equal(report.ready, false);
    assert.equal(constructed, 0);
    assert.ok(report.checks.filter(check => ['mailbox', 'model', 'mcp'].includes(check.id)).every(check => check.status === 'not-checked'));
  } finally { await fixture.cleanup(); }
});

test('live doctor does not send configured MCP credentials to placeholder hosts', async () => {
  const fixture = await bundle({ tools: true });
  try {
    const config = (await readFile(fixture.filename, 'utf8')).replace('https://mcp.tenant.test/mcp', 'https://documents.example.org/mcp');
    await writeFile(fixture.filename, config);
    let constructed = 0;
    const report = await runDoctor(fixture.filename, {
      live: true, env: { ...env, DOCTOR_MCP_TOKEN: 'private-mcp-token' },
      createMail: () => { constructed += 1; throw new Error('must not run'); },
      createModel: () => { constructed += 1; throw new Error('must not run'); },
      createMcp: () => { constructed += 1; throw new Error('must not run'); },
    });
    assert.equal(constructed, 0);
    assert.equal(report.checks.find(check => check.id === 'placeholders').status, 'fail');
    assert.equal(report.checks.find(check => check.id === 'mcp').status, 'not-checked');
    assert.doesNotMatch(JSON.stringify(report), /private-mcp-token/);
  } finally { await fixture.cleanup(); }
});

test('state diagnostics reject unsafe permissions, a different owner, and symlink roots', async () => {
  const fixture = await bundle();
  try {
    const state = join(fixture.root, 'state');
    await chmod(state, 0o755);
    let report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
    await chmod(state, 0o700);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (currentUid !== undefined) {
      report = await runDoctor(fixture.filename, { env, uid: currentUid + 1 });
      assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
    }
    const alias = join(fixture.root, 'state-alias');
    await symlink(state, alias);
    const config = (await readFile(fixture.filename, 'utf8')).replace('state_root: ./state', 'state_root: ./state-alias');
    await writeFile(fixture.filename, config);
    report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
  } finally { await fixture.cleanup(); }
});

test('state diagnostics reject unsafe writable ancestors and database sidecar symlinks', async () => {
  const fixture = await bundle();
  try {
    const shared = join(fixture.root, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o777);
    const state = join(shared, 'state');
    await mkdir(state);
    await chmod(state, 0o700);
    const config = (await readFile(fixture.filename, 'utf8')).replace('state_root: ./state', 'state_root: ./shared/state');
    await writeFile(fixture.filename, config);
    let report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
    await rm(shared, { recursive: true, force: true });

    const outside = join(fixture.root, 'outside-lock-target');
    await writeFile(outside, 'not opened');
    await symlink(outside, join(fixture.root, 'state', 'owner.lock'));
    await writeFile(fixture.filename, config.replace('./shared/state', './state'));
    report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
  } finally { await fixture.cleanup(); }
});

test('state diagnostics reject user-owned ancestor symlinks', async () => {
  const fixture = await bundle();
  try {
    const alias = join(fixture.root, 'state-parent-alias');
    await symlink(fixture.root, alias);
    const config = (await readFile(fixture.filename, 'utf8')).replace('state_root: ./state', 'state_root: ./state-parent-alias/state');
    await writeFile(fixture.filename, config);
    const report = await runDoctor(fixture.filename, { env });
    assert.equal(report.checks.find(check => check.id === 'state').status, 'fail');
  } finally { await fixture.cleanup(); }
});

test('live dependency reports preserve safe classified error categories', async () => {
  const fixture = await bundle();
  try {
    const errors = [
      'credential', 'access-denied', 'mailbox-unavailable', 'dns', 'connection', 'tls', 'timeout',
      'cancelled', 'throttled', 'invalid-response', 'endpoint-policy', 'configuration',
      'instruction-files', 'model-unsupported', 'tool-unavailable', 'dependency-failed',
    ].map(code => [code, code]);
    for (const [category, expected] of errors) {
      const report = await runDoctor(fixture.filename, {
        live: true, env,
        createMail: async () => ({ check: async () => { throw Object.assign(new Error('private provider data'), { diagnosticCode: category }); } }),
        createModel: async () => ({ step: async () => ({ text: 'OK', toolCalls: [] }) }),
        createMcp: async () => ({ listTools: async () => new Map(), close: async () => {} }),
      });
      assert.equal(report.checks.find(check => check.id === 'mailbox').code, expected);
      assert.doesNotMatch(JSON.stringify(report), /private provider data/);
    }
  } finally { await fixture.cleanup(); }
});

test('human output is safe and has no trailing newline', async () => {
  const fixture = await bundle();
  try {
    const report = await runDoctor(fixture.filename, { env: {} });
    const formatted = formatDoctor(report);
    assert.match(formatted, /Mail Agent doctor \(offline\)/);
    assert.match(formatted, /Next:/);
    assert.equal(formatted.endsWith('\n'), false);
  } finally { await fixture.cleanup(); }
});
