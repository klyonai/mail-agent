import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.mjs';

function invoke(entry, cwd) {
  return spawnSync(process.execPath, [entry, '--help'], {
    cwd, encoding: 'utf8', timeout: 5_000,
    env: { PATH: process.env.PATH ?? '' },
  });
}

function assertHelpProcess(child) {
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^Mail Agent\n/);
  assert.match(child.stdout, /recovery-release-apply/);
  assert.equal(child.stderr, '');
}

test('CLI help runs from canonical and relative npm-bin-shaped symlink entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mail-agent-cli-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonical = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  assertHelpProcess(invoke(canonical, root));

  const bin = join(root, 'node_modules', '.bin');
  await mkdir(bin, { recursive: true });
  const link = join(bin, 'mail-agent');
  const target = relative(await realpath(dirname(link)), await realpath(canonical));
  await symlink(target, link);
  assertHelpProcess(invoke(link, root));
});

test('programmatic import retains runCli without triggering command output', async () => {
  let stdout = '', stderr = '';
  const code = await runCli(['--help'], {
    stdout: { write(text) { stdout += text; } },
    stderr: { write(text) { stderr += text; } },
  });
  assert.equal(code, 0);
  assert.match(stdout, /^Mail Agent\n/);
  assert.equal(stderr, '');
});

test('configured init emits a runnable offline check for an apostrophe path from another working directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mail-agent-init-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = join(root, 'consumer directory');
  await mkdir(consumer);
  const directory = join(consumer, "operator's bundle");
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const env = { PATH: process.env.PATH ?? '' };
  const initialized = spawnSync(process.execPath, [cli, 'init', '--directory', directory, '--recipe', 'text-inbox', '--id', 'synthetic-agent',
    '--mailbox', 'agent@tenant.test', '--tenant', 'synthetic-tenant', '--client', 'synthetic-client',
    '--model-url', 'https://model.tenant.test/v1', '--model', 'synthetic-model',
    '--senders', 'alice@tenant.test', '--recipients', 'alice@tenant.test', '--auth-profile', 'dmarc', '--authserv-ids', 'mx.tenant.test'], {
    cwd: consumer, env, encoding: 'utf8', timeout: 5_000,
  });
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = JSON.parse(initialized.stdout);
  assert.equal(result.nextSteps.length, 4);
  const check = spawnSync('sh', ['-c', result.nextSteps[0]], { cwd: consumer, env, encoding: 'utf8', timeout: 5_000 });
  assert.equal(check.error, undefined);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /"mode": "offline"/);
  assert.doesNotMatch(`${check.stdout}${check.stderr}`, /synthetic-tenant|synthetic-client|agent@tenant\.test/);
});
