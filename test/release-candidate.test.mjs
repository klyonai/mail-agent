import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

test('candidate metadata requires the matching version tag and immutable source commit', async () => {
  const { candidateMetadata } = await import('../scripts/release-candidate.mjs');
  const metadata = { version: '0.1.0', private: true, engines: { node: '>=24.21.0 <25' } };
  const env = { RELEASE_VERSION: '0.1.0', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0', GITHUB_SHA: 'a'.repeat(40) };
  assert.deepEqual(candidateMetadata(metadata, env), { format: 1, version: '0.1.0', tag: 'v0.1.0',
    sourceCommit: 'a'.repeat(40), node: '>=24.21.0 <25', publication: 'not-published', packagePrivate: true });
  for (const changed of [{ RELEASE_VERSION: '0.2.0' }, { GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REF_NAME: 'v0.1.1' }, { GITHUB_SHA: '../state' }, { RELEASE_VERSION: '$(print-secret)' }]) {
    assert.throws(() => candidateMetadata(metadata, { ...env, ...changed }));
  }
});

test('versioned candidate workflow uses read-only permissions and never publishes an artifact registry', async () => {
  const text = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const workflow = parse(text);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.ok(workflow.on.workflow_dispatch);
  const steps = workflow.jobs.candidate.steps;
  for (const step of steps.filter(step => step.uses)) assert.match(step.uses, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
  assert.doesNotMatch(text, /npm publish|docker push|gh release|id-token: write|packages: write/);
  assert.ok(steps.some(step => step.run === 'npm run test:package'));
  assert.ok(steps.some(step => step.run?.includes('scripts/release-candidate.mjs')));
});
