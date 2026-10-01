import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const sourceGates = {
  'package.json': ['!package.json'],
  'package-lock.json': ['!package-lock.json'],
  LICENSE: ['!LICENSE'],
  src: ['!src/', '!src/**'],
  examples: ['!examples/', '!examples/**'],
  'mcp/records': ['!mcp/', '!mcp/records/', '!mcp/records/**'],
};
const allowedIncludes = ['!Dockerfile', ...Object.values(sourceGates).flat()];

async function contextLines() {
  return (await readFile(new URL('.dockerignore', root), 'utf8')).trim().split('\n');
}

function declaredCopies(dockerfile) {
  const local = [], internal = [];
  for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY '))) {
    if (line.startsWith('COPY --from=')) {
      const match = /^COPY --from=(build)( --chown=1000:1000)?( --chmod=0700)? (\/[^ ]+) (\/[^ ]+)$/.exec(line);
      assert.ok(match, 'Only declared build-stage copies are supported');
      internal.push({ stage: match[1], ownership: match[2]?.trim() ?? '', mode: match[3]?.trim() ?? '', source: match[4], target: match[5] });
    } else {
      assert.doesNotMatch(line, /^COPY --/, 'Unexpected local COPY option');
      local.push(...line.trim().split(/\s+/).slice(1, -1));
    }
  }
  return { local, internal };
}

test('declared container context includes every local COPY source and required runtime input', async () => {
  const [dockerfile, lines, sources] = await Promise.all([
    readFile(new URL('Dockerfile', root), 'utf8'), contextLines(),
    readdir(new URL('src/', root)),
  ]);
  const copied = declaredCopies(dockerfile).local;
  assert.deepEqual(copied, Object.keys(sourceGates));
  for (const source of copied) {
    for (const gate of sourceGates[source]) {
      assert.ok(lines.includes(gate), `Missing explicit container inclusion: ${gate}`);
    }
  }
  const required = ['package.json', 'package-lock.json', 'LICENSE', 'examples/request.json',
    'examples/text-inbox/AGENT.md', 'examples/text-inbox/agent.yaml',
    'examples/document-inbox/AGENT.md', 'examples/document-inbox/agent.yaml',
    'examples/records-inbox/AGENT.md', 'examples/records-inbox/agent.yaml',
    'examples/records-inbox/actor-policy.json', 'examples/records-inbox/record.json',
    'mcp/records/records.mjs', 'mcp/records/server.mjs', 'mcp/records/README.md',
    ...sources.filter(name => name.endsWith('.mjs')).map(name => `src/${name}`)];
  for (const filename of required) assert.ok((await stat(new URL(filename, root))).isFile());
});

test('the final runtime stage copies only Node, application and private state from the build stage', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
  assert.deepEqual(declaredCopies(dockerfile).internal, [
    { stage: 'build', ownership: '', mode: '', source: '/usr/local/bin/node', target: '/usr/local/bin/node' },
    { stage: 'build', ownership: '', mode: '', source: '/app', target: '/app' },
    { stage: 'build', ownership: '--chown=1000:1000', mode: '--chmod=0700', source: '/state', target: '/state' },
  ]);
  const finalStage = dockerfile.split(/^FROM /m).at(-1);
  assert.deepEqual(declaredCopies(finalStage).local, []);
});

test('the primary container artifact carries the selected MIT notice', async () => {
  const [dockerfile, license, checkWorkflow, candidateWorkflow] = await Promise.all([
    readFile(new URL('Dockerfile', root), 'utf8'),
    readFile(new URL('LICENSE', root), 'utf8'),
    readFile(new URL('.github/workflows/check.yml', root), 'utf8'),
    readFile(new URL('.github/workflows/release-candidate.yml', root), 'utf8'),
  ]);
  assert.match(dockerfile, /^WORKDIR \/app$/m);
  assert.match(dockerfile, /^COPY LICENSE \.\/$/m);
  assert.match(license, /^MIT License\n/);
  for (const workflow of [checkWorkflow, candidateWorkflow]) {
    assert.match(workflow, /readFileSync\('\/app\/LICENSE'\)/);
    assert.match(workflow, /cmp - LICENSE/);
  }
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
