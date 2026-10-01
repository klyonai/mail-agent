import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

test('runtime floor, lockfile, container and CI agree on the reviewed Node release', async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const metadata = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(metadata.engines.node, '>=24.21.0 <25');
  assert.deepEqual(lock.packages[''].engines, metadata.engines);
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^FROM node:24\.21\.0-trixie-slim@sha256:[0-9a-f]{64}\n/);
  assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/lib\/node_modules\/corepack/);
  assert.match(dockerfile, /rm -f \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx \/usr\/local\/bin\/corepack/);
  assert.match(dockerfile, /libpcre2-8-0=10\.46-1~deb13u3/);
  assert.match(dockerfile, /libssl3t64=3\.5\.7-1~deb13u3/);
  assert.match(dockerfile, /openssl-provider-legacy=3\.5\.7-1~deb13u3/);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists/);
  assert.doesNotMatch(dockerfile, /apt-get upgrade/);
  assert.match(dockerfile, /find \/usr -xdev -type f -perm \/6000 -exec chmod a-s \{\} \+/, 'runtime image must not retain setuid or setgid regular files');
  for (const name of ['check.yml', 'release-candidate.yml']) {
    const workflow = parse(await read(`.github/workflows/${name}`));
    for (const job of Object.values(workflow.jobs)) {
      const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      assert.equal(setup.with['node-version'], '24.21.0');
    }
  }
});
