import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sourceGates = {
  'package.json': ['!package.json'],
  'package-lock.json': ['!package-lock.json'],
  src: ['!src/', '!src/**'],
  examples: ['!examples/', '!examples/**'],
  'mcp/records': ['!mcp/', '!mcp/records/', '!mcp/records/**'],
};
const allowedIncludes = ['!Dockerfile', ...Object.values(sourceGates).flat()];

async function contextLines() {
  return (await readFile(new URL('.dockerignore', root), 'utf8')).trim().split('\n');
}

test('declared container context includes every local COPY source and required runtime input', async () => {
  const [dockerfile, lines, sources] = await Promise.all([
    readFile(new URL('Dockerfile', root), 'utf8'), contextLines(),
    readdir(new URL('src/', root)),
  ]);
  const copied = dockerfile.split('\n').filter(line => line.startsWith('COPY '))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1));
  assert.deepEqual(copied, Object.keys(sourceGates));
  for (const source of copied) {
    for (const gate of sourceGates[source]) {
      assert.ok(lines.includes(gate), `Missing explicit container inclusion: ${gate}`);
    }
  }
  const required = ['package.json', 'package-lock.json', 'examples/request.json',
    'examples/text-inbox/AGENT.md', 'examples/text-inbox/agent.yaml',
    'examples/document-inbox/AGENT.md', 'examples/document-inbox/agent.yaml',
    'examples/records-inbox/AGENT.md', 'examples/records-inbox/agent.yaml',
    'examples/records-inbox/actor-policy.json', 'examples/records-inbox/record.json',
    'mcp/records/records.mjs', 'mcp/records/server.mjs', 'mcp/records/README.md',
    ...sources.filter(name => name.endsWith('.mjs')).map(name => `src/${name}`)];
  for (const filename of required) assert.ok((await stat(new URL(filename, root))).isFile());
});

test('container context remains a closed whitelist excluding private material and branding', async () => {
  const lines = await contextLines();
  assert.equal(lines[0], '*');
  // Exact directives keep this a declared whitelist contract, not an ignore-pattern interpreter.
  assert.deepEqual(lines.slice(1), allowedIncludes);
  for (const excluded of ['.env', 'customer/', 'state/', 'private/', 'docs/',
    'docs/roadmap/history/', 'design/branding/', 'test/', 'mcp/other/']) {
    assert.equal(allowedIncludes.some(line => line.slice(1) === excluded), false);
  }
});
