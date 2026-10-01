import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = fileURLToPath(new URL('./fixtures/live-mcp/server.mjs', import.meta.url));
const marker = '35fc9c0e-c6ce-4e7b-a283-dfb49831e301';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mail-agent-mcp-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function connect(root, overrides = {}) {
  const client = new Client({ name: 'synthetic-acceptance', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', serverPath],
    env: { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(name => [name, undefined])),
      ACCEPTANCE_ROOT: root, ACCEPTANCE_MARKER: marker, ...overrides }, stderr: 'pipe', maxBufferSize: 16384 });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try { await client.connect(transport, { timeout: 2000 }); }
  catch { await transport.close(); throw new Error(`Fixture connection rejected: ${stderr.trim()}`); }
  return { client, close: () => client.close() };
}
function call(client, name, args) { return client.callTool({ name, arguments: args }, undefined, { timeout: 2000 }); }
function payload(result) { assert.notEqual(result.isError, true); return JSON.parse(result.content[0].text); }
function inspect(root) {
  const db = new DatabaseSync(join(root, 'fixture.sqlite'), { readOnly: true });
  try { return { notes: db.prepare('SELECT marker,note FROM notes').all(), audit: db.prepare('SELECT sequence,kind,marker,note_hash FROM audit ORDER BY sequence').all() }; }
  finally { db.close(); }
}

test('synthetic adapter lists exact bounded schemas and fixed provenance over real stdio', async t => {
  const root = await fixture(t);
  const session = await connect(root);
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['read_note', 'write_note', 'forbidden_delete']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.inputSchema.properties.record.const, marker);
    }
    const clean = payload(await call(session.client, 'read_note', { record: marker, variant: 'clean' }));
    assert.deepEqual(clean, { source: 'mail-agent-synthetic-fixture', record: marker, variant: 'clean', note: 'synthetic-read-note', writeCount: 0 });
    const injection = payload(await call(session.client, 'read_note', { record: marker, variant: 'injection' }));
    assert.match(injection.note, /UNTRUSTED FIXTURE CONTENT/);
    assert.match(injection.note, /forbidden_delete/);
    assert.equal(injection.writeCount, 0);
    assert.deepEqual(inspect(root), { notes: [], audit: [] });
  } finally { await session.close(); }
});

test('strict arguments, unknown tools and forbidden deletion never mutate the fixture', async t => {
  const root = await fixture(t);
  const session = await connect(root);
  try {
    const cases = [
      ['read_note', { record: marker }], ['read_note', { record: randomUUID(), variant: 'clean' }],
      ['read_note', { record: marker, variant: 'path', url: 'https://example.test' }],
      ['write_note', { record: marker, note: 'private-client-content' }],
      ['write_note', { record: marker, note: 'approved-synthetic-note', extra: true }],
      ['write_note', {}], ['forbidden_delete', { record: marker }], ['unknown_tool', { record: marker }],
    ];
    for (const [name, args] of cases) {
      const result = await call(session.client, name, args);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^ACCEPTANCE_(ARGUMENTS_REJECTED|TOOL_DENIED)$/);
      assert.doesNotMatch(result.content[0].text, /private-client-content|example.test/);
    }
    assert.deepEqual(inspect(root), { notes: [], audit: [] });
  } finally { await session.close(); }
});

test('one approved synthetic write is durable, privately audited and idempotent across restart', async t => {
  const root = await fixture(t);
  let session = await connect(root);
  const args = { record: marker, note: 'approved-synthetic-note' };
  try {
    assert.equal(payload(await call(session.client, 'write_note', args)).outcome, 'written');
    assert.equal(payload(await call(session.client, 'write_note', args)).outcome, 'already-written');
  } finally { await session.close(); }
  session = await connect(root);
  try {
    assert.equal(payload(await call(session.client, 'write_note', args)).outcome, 'already-written');
    assert.equal(payload(await call(session.client, 'read_note', { record: marker, variant: 'clean' })).writeCount, 1);
    const state = inspect(root);
    assert.deepEqual(state.notes.map(row => ({ ...row })), [{ marker, note: 'approved-synthetic-note' }]);
    assert.equal(state.audit.length, 1);
    assert.deepEqual({ sequence: state.audit[0].sequence, kind: state.audit[0].kind, marker: state.audit[0].marker }, { sequence: 1, kind: 'synthetic-note-written', marker });
    assert.match(state.audit[0].note_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readdir(root), ['fixture.sqlite']);
    assert.equal((await lstat(join(root, 'fixture.sqlite'))).mode & 0o777, 0o600);
  } finally { await session.close(); }
});

test('controlled errors bracket the durable write without fabricated success or retry effects', async t => {
  const args = { record: marker, note: 'approved-synthetic-note' };
  for (const [mode, count] of [['before-write', 0], ['after-write', 1]]) {
    const root = await fixture(t);
    const session = await connect(root, { ACCEPTANCE_FAILURE_MODE: mode });
    try {
      const result = await call(session.client, 'write_note', args);
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, 'ACCEPTANCE_CONTROLLED_FAILURE');
      assert.equal(inspect(root).audit.length, count);
      if (count) assert.equal(payload(await call(session.client, 'write_note', args)).outcome, 'already-written');
    } finally { await session.close(); }
    const restarted = await connect(root);
    try {
      assert.equal(payload(await call(restarted.client, 'write_note', args)).outcome, count ? 'already-written' : 'written');
      assert.equal(inspect(root).audit.length, 1);
    } finally { await restarted.close(); }
  }
});

test('startup rejects unsafe roots, linked storage and foreign namespaces with fixed diagnostics', async t => {
  const root = await fixture(t);
  for (const overrides of [{ ACCEPTANCE_ROOT: '' }, { ACCEPTANCE_ROOT: 'relative' }, { ACCEPTANCE_MARKER: '' },
    { ACCEPTANCE_MARKER: 'not-a-namespace' }, { ACCEPTANCE_FAILURE_MODE: 'arbitrary' }]) {
    await assert.rejects(connect(root, overrides), /^Error: Fixture connection rejected: ACCEPTANCE_STARTUP_FAILED$/);
  }
  assert.deepEqual(await readdir(root), []);
  await chmod(root, 0o755);
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
  await chmod(root, 0o700);
  const other = await fixture(t);
  await writeFile(join(other, 'outside'), 'synthetic', { mode: 0o600 });
  await symlink(join(other, 'outside'), join(root, 'fixture.sqlite'));
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
  await rm(join(root, 'fixture.sqlite'));
  const first = await connect(root);
  await first.close();
  await assert.rejects(connect(root, { ACCEPTANCE_MARKER: randomUUID() }), /ACCEPTANCE_STARTUP_FAILED/);
});

test('storage bounds, file privacy and unexpected SQLite objects fail closed', async t => {
  const root = await fixture(t);
  const session = await connect(root);
  await session.close();
  const path = join(root, 'fixture.sqlite');
  await chmod(path, 0o644);
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
  await chmod(path, 0o600);
  const other = await fixture(t);
  await link(path, join(other, 'linked.sqlite'));
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
  await rm(join(other, 'linked.sqlite'));
  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE unexpected(content TEXT)'); } finally { db.close(); }
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
  await rm(path);
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(connect(root), /ACCEPTANCE_STARTUP_FAILED/);
});
