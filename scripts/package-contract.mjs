const documents = new Set([
  'package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
  'docs/quickstart.md', 'docs/diagnostics.md', 'docs/microsoft-365-setup.md',
  'docs/operations.md', 'docs/recovery.md', 'docs/support.md', 'docs/public-acceptance.md',
  'docs/live-tests.md', 'docs/live-sender-setup.md', 'docs/live-mcp-tests.md',
  'docs/endpoint-qualification.md', 'docs/releasing.md', 'docs/mailbox-troubleshooting.md',
  'examples/request.json', 'examples/text-inbox/AGENT.md', 'examples/text-inbox/agent.yaml',
  'examples/document-inbox/AGENT.md', 'examples/document-inbox/agent.yaml', 'docs/document-inbox.md',
  'examples/records-inbox/AGENT.md', 'examples/records-inbox/agent.yaml',
  'examples/records-inbox/actor-policy.json', 'examples/records-inbox/record.json', 'docs/records-inbox.md',
  'mcp/records/records.mjs', 'mcp/records/server.mjs', 'mcp/records/README.md',
]);

export function validatePackageContents(files, sourceNames) {
  if (!Array.isArray(files) || !Array.isArray(sourceNames) || !sourceNames.length) throw new Error('Invalid package inventory.');
  const expected = new Set([...sourceNames.map(name => `src/${name}`), ...documents]);
  const seen = new Set();
  let bytes = 0;
  for (const file of files) {
    if (!file || !expected.has(file.path) || seen.has(file.path)
        || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Unexpected package contents.');
    seen.add(file.path);
    bytes += file.size;
  }
  if (bytes > 32 * 1024 * 1024) throw new Error('Package exceeds its size bound.');
  if ([...expected].some(name => !seen.has(name))) throw new Error('Required package contents are missing.');
  return { files: seen.size, unpackedBytes: bytes };
}
