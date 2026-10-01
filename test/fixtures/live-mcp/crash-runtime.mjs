import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../../../src/config.mjs';
import { createRuntime } from '../../../src/runtime.mjs';
import { createMcp } from '../../../src/mcp.mjs';
import { digest } from '../../../src/policy.mjs';

// Test-only caller crash barriers. No network adapter or production model is constructed.
const [root, marker, boundary] = process.argv.slice(2);
const fixedNow = 1_800_000_000_000;
const counters = { modelCalls: 0, toolCalls: 0, writeDispatches: 0, replyIntents: 0 };
let stdioPid = null;
let injectionReadVerified = false;
let pendingApprovalVerified = false;
const note = 'approved-synthetic-note';
function requireCondition(condition) { if (!condition) throw new Error('Invalid synthetic crash fixture.'); }
async function notify(value) {
  requireCondition(typeof process.send === 'function');
  await new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
}
async function barrier() {
  await notify({ phase: 'crash-boundary', boundary, stdioPid, injectionReadVerified, pendingApprovalVerified, counters });
  // Keeping IPC referenced prevents a pending-promise-only process from exiting.
  await new Promise(resolve => process.once('message', resolve));
  throw new Error('Crash barrier must be terminated by the parent test.');
}
async function sdkClient(options, { signal }) {
  const client = new Client({ name: 'synthetic-crash-client', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: options.command, args: options.args, cwd: options.cwd,
    env: { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(name => [name, undefined])), ...options.env },
    stderr: 'ignore', maxBufferSize: options.maximum });
  try { await client.connect(transport, { signal, timeout: options.timeout }); }
  catch (error) { await transport.close(); throw error; }
  stdioPid = transport.pid;
  return client;
}
function trackedMcp(mcp) {
  return { ...mcp, async call(name, args, options) {
    counters.toolCalls++;
    if (name === 'livefixture.write_note') {
      requireCondition(pendingApprovalVerified && digest(args) === digest({ record: marker, note }));
      if (boundary === 'before-dispatch') await barrier();
      counters.writeDispatches++;
    }
    const result = await mcp.call(name, args, options);
    if (name === 'livefixture.read_note') {
      const data = JSON.parse(result.content[0].text);
      requireCondition(data.record === marker && data.variant === 'injection' && data.note.includes('UNTRUSTED FIXTURE CONTENT'));
      injectionReadVerified = true;
    }
    if (name === 'livefixture.write_note' && boundary === 'after-commit') await barrier();
    return result;
  } };
}
function scriptedModel() {
  return { async step({ tools }) {
    counters.modelCalls++;
    requireCondition(boundary !== 'recover' && counters.modelCalls <= 2 && tools.size === 2
      && tools.has('livefixture.read_note') && tools.has('livefixture.write_note'));
    const name = counters.modelCalls === 1 ? 'livefixture.read_note' : 'livefixture.write_note';
    const args = counters.modelCalls === 1 ? { record: marker, variant: 'injection' } : { record: marker, note };
    return { text: '', toolCalls: [{ id: `synthetic-call-${counters.modelCalls}`, name, args }] };
  } };
}
function syntheticMail(request) {
  return { async getMessage(id) { requireCondition(id === request.id); return structuredClone(request); },
    async reply() { counters.replyIntents++; throw new Error('Crash fixture must never reply.'); }, async close() {} };
}
async function exactApproval(runtime) {
  const [approval, extra] = runtime.approvals();
  requireCondition(approval?.tool === 'livefixture.write_note' && !extra && injectionReadVerified && counters.writeDispatches === 0);
  requireCondition(digest(approval.args) === digest({ record: marker, note }));
  await runtime.approve({ id: approval.id, actor: 'operator@example.org', reason: 'Approve only the exact synthetic crash-test note.' });
  pendingApprovalVerified = true;
}
async function main() {
  requireCondition(['before-dispatch', 'after-commit', 'recover'].includes(boundary));
  process.umask(0o077);
  const env = { INBOX_GRAPH_CLIENT_SECRET: 'unused-synthetic', INBOX_MODEL_API_KEY: 'unused-synthetic',
    ACCEPTANCE_ROOT: join(root, 'fixture'), ACCEPTANCE_MARKER: marker, ACCEPTANCE_FAILURE_MODE: 'none' };
  const loaded = await loadConfig(join(root, 'agent.yaml'), { env, requireSecrets: true });
  const request = { id: `crash-${marker}`, conversationId: `conversation-${marker}`, sender: 'alice@example.org',
    replyTo: 'alice@example.org', to: ['assistant@example.org'], cc: [], subject: 'Synthetic MCP crash request',
    body: 'Read the injected synthetic note, then request approval to write the exact synthetic note.',
    receivedAt: new Date(fixedNow).toISOString(), bodyFormat: 'text', attachments: false, attachmentStatus: 'none',
    authenticated: true, autoGenerated: false };
  const mcp = createMcp(loaded.config.mcp, { env, root: loaded.root, clientFactory: sdkClient });
  const runtime = await createRuntime({ ...loaded, env, mode: 'live', clock: () => fixedNow,
    model: scriptedModel(), mail: syntheticMail(request), mcp: trackedMcp(mcp),
    fetchImpl: () => { throw new Error('Network is forbidden in this fixture.'); } });
  try {
    const result = await runtime.processMessage(request);
    if (boundary === 'recover') {
      await runtime.stop();
      await notify({ phase: 'recovered', status: result.status, counters });
      return;
    }
    requireCondition(result.status === 'awaiting_approval');
    await exactApproval(runtime);
    await runtime.processMessage(request);
    throw new Error('Crash boundary was not reached.');
  } finally { await runtime.stop(); }
}
main().then(() => { process.disconnect(); }).catch(async () => {
  await notify({ phase: 'error' }).catch(() => {}); process.exitCode = 1; process.disconnect();
});
