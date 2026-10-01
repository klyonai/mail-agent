import test from 'node:test';
import assert from 'node:assert/strict';

const common = ['--config', 'agent.yaml', '--sender-token-file', 'sender.json', '--sender-address', 'alice@example.org',
  '--actor', 'operator@example.org', '--approve-synthetic-write'];
const marker = '00000000-0000-4000-8000-000000000001';

test('MCP live qualification requires explicit bounded synthetic approval and real model mode', async () => {
  const { parseMcpLiveArguments } = await import('../scripts/live-mcp-qualification.mjs');
  const parsed = parseMcpLiveArguments(common);
  assert.equal(parsed.realModel, true);
  assert.equal(parsed.failureMode, 'none');
  assert.equal(parsed.actor, 'operator@example.org');
  assert.throws(() => parseMcpLiveArguments(common.filter(value => value !== '--approve-synthetic-write')));
  assert.throws(() => parseMcpLiveArguments([...common, '--timeout-seconds', '601']));
  assert.throws(() => parseMcpLiveArguments([...common, '--transport-only']));
  assert.throws(() => parseMcpLiveArguments([...common, '--failure-mode', 'delete-records']));
});

test('MCP fixture config replaces no business connections and bounds exact write authority', async () => {
  const { fixtureConfiguration } = await import('../scripts/live-mcp-qualification.mjs');
  const original = { state_root: 'original', instructions: { agent: 'original.md' }, mcp: {},
    model: { capabilities: { tools: false, images: false, pdf: false } },
    policy: { tools: {}, approvers: [] }, limits: { model_calls: 6, tool_calls: 10 }, retention: {} };
  const result = fixtureConfiguration(original, '/synthetic/private', marker, 'operator@example.org');
  assert.deepEqual(original.mcp, {});
  assert.equal(original.model.capabilities.tools, false);
  assert.equal(result.model.capabilities.tools, true);
  assert.deepEqual(Object.keys(result.mcp), ['livefixture']);
  assert.equal(result.policy.tools['livefixture.forbidden_delete'], undefined);
  assert.equal(result.policy.tools['livefixture.write_note'].authorization, 'approval');
  assert.equal(result.policy.tools['livefixture.write_note'].constraints.properties.record.const, marker);
  assert.throws(() => fixtureConfiguration({ ...original, mcp: { business: {} } }, '/synthetic', marker, 'operator@example.org'));
});

test('only the exact fixture proposal can receive the test local grant', async () => {
  const { verifyFixtureApproval, fixtureCase } = await import('../scripts/live-mcp-qualification.mjs');
  const approval = { id: 'a'.repeat(64), tool: 'livefixture.write_note', args: { record: marker, note: 'approved-synthetic-note' } };
  assert.equal(verifyFixtureApproval([approval], marker).id, approval.id);
  assert.throws(() => verifyFixtureApproval([{ ...approval, tool: 'livefixture.forbidden_delete' }], marker));
  assert.throws(() => verifyFixtureApproval([{ ...approval, args: { record: 'foreign', note: 'approved-synthetic-note' } }], marker));
  assert.throws(() => verifyFixtureApproval([approval, approval], marker));
  assert.throws(() => verifyFixtureApproval([{ ...approval, args: { ...approval.args, extra: true } }], marker));
  const item = fixtureCase(marker);
  assert.ok(item.body.includes(marker));
  assert.ok(item.body.includes('injection'));
  assert.equal(item.expected, 'CONFIRMED');
});
