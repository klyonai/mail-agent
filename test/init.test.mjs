import test from 'node:test';
import assert from 'node:assert/strict';
import { link as fsLink, lstat, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { initializeAgent } from '../src/init.mjs';

const answers = {
  mailbox: 'agent@tenant.test', tenant: 'tenant-123', client: 'client-123',
  modelUrl: 'https://models.tenant.test/v1', model: 'model-v1',
  senders: 'alice@tenant.test,bob@tenant.test', recipients: 'alice@tenant.test,bob@tenant.test',
  authProfile: 'dmarc', authservIds: 'mx.tenant.test', id: 'helpdesk', stateRoot: '/state',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mail-init-'));
  return { root, directory: join(root, 'agent'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('init without configuration values copies the existing text recipe privately', async () => {
  const target = await fixture();
  try {
    const result = await initializeAgent({ directory: target.directory, recipe: 'text-inbox' });
    assert.equal(result.directory, target.directory);
    assert.match(result.instructions, /Configure mailbox identity/);
    assert.equal((await stat(target.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(target.directory, 'agent.yaml'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(target.directory, 'agent.yaml'), 'utf8'), /example-tenant/);
  } finally { await target.cleanup(); }
});

test('noninteractive init writes a schema-valid complete bundle without secrets or trust inference', async () => {
  const target = await fixture();
  try {
    const result = await initializeAgent({ directory: target.directory, recipe: 'text-inbox', answers });
    const yaml = await readFile(join(target.directory, 'agent.yaml'), 'utf8');
    assert.match(yaml, /tenant_id: tenant-123/);
    assert.match(yaml, /state_root: \/state/);
    assert.match(yaml, /transport_headers_verified: false/);
    assert.match(yaml, /client_secret_env: INBOX_GRAPH_CLIENT_SECRET/);
    assert.doesNotMatch(yaml, /private-secret|secret-value|api-key-value/);
    const loaded = await loadConfig(join(target.directory, 'agent.yaml'), { env: {} });
    assert.equal(loaded.config.id, 'helpdesk');
    assert.deepEqual(loaded.config.policy.senders, ['alice@tenant.test', 'bob@tenant.test']);
    assert.equal(loaded.config.model.capabilities.tools, false);
    assert.deepEqual(result.nextSteps.map(step => step.slice('node src/cli.mjs '.length).split(' ')[0]), ['check', 'doctor', 'doctor', 'start']);
  } finally { await target.cleanup(); }
});

test('next steps safely quote configuration paths containing apostrophes', async () => {
  const target = await fixture();
  try {
    const directory = join(target.root, "agent's bundle");
    const result = await initializeAgent({ directory, answers });
    const path = join(directory, 'agent.yaml');
    const quoted = `'${path.replaceAll("'", "'\\''")}'`;
    assert.equal(result.nextSteps[0], `node src/cli.mjs check --config ${quoted}`);
    assert.equal(result.nextSteps[2], `node src/cli.mjs doctor --live --config ${quoted}`);
  } finally { await target.cleanup(); }
});

test('guided and noninteractive initialization produce identical bytes for the same answers', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const prompts = [];
    await initializeAgent({ directory: first.directory, recipe: 'text-inbox', answers });
    await initializeAgent({ directory: second.directory, recipe: 'text-inbox', guided: true, ask: async question => {
      prompts.push(question.key);
      return answers[question.key];
    } });
    assert.deepEqual(await readFile(join(first.directory, 'agent.yaml')), await readFile(join(second.directory, 'agent.yaml')));
    assert.deepEqual(await readFile(join(first.directory, 'AGENT.md')), await readFile(join(second.directory, 'AGENT.md')));
    assert.ok(prompts.includes('authProfile'));
    assert.ok(prompts.includes('graphSecretEnv'));
    assert.ok(prompts.includes('modelKeyEnv'));
  } finally { await first.cleanup(); await second.cleanup(); }
});

test('internal profile requires a GUID tenant and uses sender domains', async () => {
  const target = await fixture();
  try {
    const dmarcAnswers = { ...answers };
    delete dmarcAnswers.authservIds;
    const values = { ...dmarcAnswers, tenant: '123e4567-e89b-12d3-a456-426614174000', authProfile: 'internal', fromDomains: 'tenant.test' };
    await initializeAgent({ directory: target.directory, answers: values });
    const config = (await loadConfig(join(target.directory, 'agent.yaml'), { env: {} })).config;
    assert.deepEqual(config.mailbox.sender_authentication.sender_domains, ['tenant.test']);
    assert.equal(config.mailbox.sender_authentication.mode, 'exchange-internal');
    assert.equal(config.mailbox.sender_authentication.transport_headers_verified, false);
  } finally { await target.cleanup(); }
});

test('authentication profile rejects conflicting profile-specific fields', async () => {
  const target = await fixture();
  try {
    await assert.rejects(initializeAgent({ directory: target.directory, answers: { ...answers, fromDomains: 'tenant.test' } }), /conflicts/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
    await assert.rejects(initializeAgent({ directory: target.directory, answers: {
      ...answers, tenant: '123e4567-e89b-12d3-a456-426614174000', authProfile: 'internal', fromDomains: 'tenant.test',
    } }), /conflicts/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
  } finally { await target.cleanup(); }
});

test('invalid or incomplete answers fail before publishing a target', async () => {
  const target = await fixture();
  try {
    await assert.rejects(initializeAgent({ directory: target.directory, answers: { ...answers, modelUrl: 'http://models.tenant.test/v1' } }), /HTTPS/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
    assert.deepEqual(await (await import('node:fs/promises')).readdir(target.root), []);
    await assert.rejects(initializeAgent({ directory: target.directory, answers: { ...answers, recipients: 'bob@tenant.test' } }), /sender.*recipient/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
    await assert.rejects(initializeAgent({ directory: target.directory, answers: { mailbox: answers.mailbox } }), /required|missing/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
  } finally { await target.cleanup(); }
});

test('init refuses existing empty directories and symbolic link targets', async () => {
  const target = await fixture();
  try {
    const empty = join(target.root, 'empty');
    await (await import('node:fs/promises')).mkdir(empty);
    await assert.rejects(initializeAgent({ directory: empty, answers }), /already exists/i);
    const linked = join(target.root, 'linked');
    await symlink(empty, linked);
    await assert.rejects(initializeAgent({ directory: linked, answers }), /already exists/i);
  } finally { await target.cleanup(); }
});

test('guided cancellation leaves no destination bundle', async () => {
  const target = await fixture();
  try {
    await assert.rejects(initializeAgent({ directory: target.directory, guided: true, ask: async () => null }), /cancel/i);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
  } finally { await target.cleanup(); }
});

test('failed second publish removes only staged files and the reserved directory', async () => {
  const target = await fixture();
  try {
    let publishedFiles = 0;
    const filesystem = {
      link: async (source, destination) => {
        publishedFiles += 1;
        if (publishedFiles === 2) {
          assert.deepEqual(await readdir(target.directory), ['AGENT.md']);
          throw new Error('synthetic publish failure');
        }
        return fsLink(source, destination);
      },
    };
    await assert.rejects(initializeAgent({ directory: target.directory, answers, filesystem }), /synthetic publish failure/);
    await assert.rejects(lstat(target.directory), { code: 'ENOENT' });
    assert.deepEqual(await readdir(target.root), []);
  } finally { await target.cleanup(); }
});

test('concurrent initializers have one no-overwrite winner', async () => {
  const target = await fixture();
  try {
    const outcomes = await Promise.allSettled([
      initializeAgent({ directory: target.directory, answers }),
      initializeAgent({ directory: target.directory, answers: { ...answers, id: 'second-agent' } }),
    ]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
    const content = await readFile(join(target.directory, 'agent.yaml'), 'utf8');
    assert.match(content, /id: (?:helpdesk|second-agent)/);
    assert.deepEqual((await readdir(target.directory)).sort(), ['AGENT.md', 'agent.yaml']);
  } finally { await target.cleanup(); }
});
