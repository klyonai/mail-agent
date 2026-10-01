import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validatePackageContents } from '../scripts/package-contract.mjs';

test('package stays private and ships only the declared runtime, inert examples and operator documents', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(metadata.private, true);
  assert.deepEqual(metadata.files, [
    'src/*.mjs', 'examples/request.json', 'examples/text-inbox/AGENT.md', 'examples/text-inbox/agent.yaml',
    'examples/document-inbox/AGENT.md', 'examples/document-inbox/agent.yaml', 'docs/document-inbox.md',
    'examples/records-inbox/AGENT.md', 'examples/records-inbox/agent.yaml',
    'examples/records-inbox/actor-policy.json', 'examples/records-inbox/record.json', 'docs/records-inbox.md',
    'mcp/records/records.mjs', 'mcp/records/server.mjs', 'mcp/records/README.md',
    'docs/quickstart.md', 'docs/diagnostics.md', 'docs/microsoft-365-setup.md', 'docs/operations.md',
    'docs/recovery.md', 'docs/support.md', 'docs/public-acceptance.md', 'docs/live-tests.md',
    'docs/live-sender-setup.md', 'docs/live-mcp-tests.md', 'docs/endpoint-qualification.md', 'docs/releasing.md',
    'docs/mailbox-troubleshooting.md',
    'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  ]);
  assert.deepEqual(metadata.bin, { 'mail-agent': 'src/cli.mjs' });
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
    assert.equal(metadata.scripts[lifecycle], undefined);
  }
});

const required = [
  'src/cli.mjs', 'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'docs/quickstart.md', 'docs/diagnostics.md', 'docs/microsoft-365-setup.md', 'docs/operations.md',
  'docs/recovery.md', 'docs/support.md', 'docs/public-acceptance.md', 'docs/live-tests.md',
  'docs/live-sender-setup.md', 'docs/live-mcp-tests.md', 'docs/endpoint-qualification.md', 'docs/releasing.md',
  'docs/mailbox-troubleshooting.md',
  'examples/request.json',
  'examples/text-inbox/AGENT.md', 'examples/text-inbox/agent.yaml',
  'examples/document-inbox/AGENT.md', 'examples/document-inbox/agent.yaml', 'docs/document-inbox.md',
  'examples/records-inbox/AGENT.md', 'examples/records-inbox/agent.yaml',
  'examples/records-inbox/actor-policy.json', 'examples/records-inbox/record.json', 'docs/records-inbox.md',
  'mcp/records/records.mjs', 'mcp/records/server.mjs', 'mcp/records/README.md',
];
const inventory = () => required.map(path => ({ path, size: 100 }));

test('packed inventory requires every declared artifact and rejects extra or ambiguous entries', () => {
  assert.deepEqual(validatePackageContents(inventory(), ['cli.mjs']), { files: required.length, unpackedBytes: required.length * 100 });
  for (const path of ['.env', 'docs/live-email-evidence.md', 'docs/live-email-evidence-2026-10-01.md',
    'docs/roadmap/history/private.md', 'docs/roadmap/history/2026-10-01-ma-007-packaging-preparation.md',
    'design/branding/identity.md', 'test/package.test.mjs', 'scripts/package-qualify.mjs',
    'state/db.sqlite', 'customer/agent.yaml', '../secret', 'src/.private.mjs', 'node_modules/secret']) {
    assert.throws(() => validatePackageContents([...inventory(), { path, size: 1 }], ['cli.mjs']));
  }
  assert.throws(() => validatePackageContents(inventory().slice(1), ['cli.mjs']));
  assert.throws(() => validatePackageContents([...inventory(), inventory()[0]], ['cli.mjs']));
  assert.throws(() => validatePackageContents([{ path: 'src/cli.mjs', size: 33 * 1024 * 1024 }], ['cli.mjs']));
  assert.throws(() => validatePackageContents([{ path: 'src/cli.mjs', size: -1 }], ['cli.mjs']));
});

test('packed inventory requires the selected license artifact', () => {
  const missingLicense = inventory().filter(file => file.path !== 'LICENSE');
  assert.throws(() => validatePackageContents(missingLicense, ['cli.mjs']), /Required package contents are missing\./);
});
