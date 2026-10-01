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
  assert.match(dockerfile, /^FROM node:24\.21\.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build\n/);
  assert.match(dockerfile, /^RUN npm ci --omit=dev --ignore-scripts$/m);
  for (const name of ['check.yml', 'release-candidate.yml']) {
    const workflow = parse(await read(`.github/workflows/${name}`));
    for (const job of Object.values(workflow.jobs)) {
      const setup = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      assert.equal(setup.with['node-version'], '24.21.0');
    }
  }
});

test('the declared final stage copies reviewed runtime inputs without builder OS tooling', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const stages = dockerfile.split(/^FROM /m).slice(1);
  assert.equal(stages.length, 2);
  const runtime = stages[1];
  assert.match(runtime, /^gcr\.io\/distroless\/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2\n/);
  assert.doesNotMatch(runtime, /^RUN /m);
  assert.match(stages[0], /RUN mkdir -p \/runtime-root\/state \\\n[ ]{4}&& chown 1000:1000 \/runtime-root\/state \\\n[ ]{4}&& chmod 0700 \/runtime-root\/state/);
  assert.match(runtime, /^COPY --from=build --chown=1000:1000 \/runtime-root\/ \/$/m);
  assert.match(runtime, /^USER 1000:1000$/m);
  assert.match(runtime, /^ENV NODE_ENV=production$/m);
  assert.match(runtime, /^ENV PATH=\/usr\/local\/bin$/m);
  assert.match(runtime, /^ENTRYPOINT \["\/usr\/local\/bin\/node", "\/app\/src\/cli\.mjs"\]$/m);
  assert.match(runtime, /^CMD \["--help"\]$/m);
});

test('hosted checks verify actual state ownership and permissions before preview or artifact creation', async () => {
  for (const filename of ['check.yml', 'release-candidate.yml']) {
    const workflow = parse(await readFile(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8'));
    const commands = Object.values(workflow.jobs).flatMap(job => job.steps.flatMap(step => step.run?.split('\n') ?? []));
    const build = commands.findIndex(command => command.includes('docker build '));
    const gate = commands.findIndex(command => command.includes("lstatSync('/state')"));
    assert.ok(gate > build && build >= 0, 'Actual image state check must follow its build');
    const check = commands[gate];
    assert.match(check, /docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --entrypoint \/usr\/local\/bin\/node/);
    for (const assertion of ['!s.isDirectory()', 's.isSymbolicLink()', 's.uid !== 1000',
      's.gid !== 1000', '(s.mode & 0o7777) !== 0o700']) assert.ok(check.includes(assertion));
    for (const [index, command] of commands.entries()) {
      if (/ preview |docker image (inspect|save) /.test(command)) assert.ok(index > gate);
    }
  }
});
