import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { createFixtureMail, loadFixture } from '../src/fixture.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function output() {
  let text = '';
  return { write: value => { text += value; }, value: () => text };
}
async function initialized() {
  const directory = join(await mkdtemp(join(tmpdir(), 'mail-cli-')), 'bundle');
  const stdout = output();
  assert.equal(await runCli(['init', '--directory', directory, '--recipe', 'text-inbox'], { stdout }), 0);
  return { directory, filename: join(directory, 'agent.yaml') };
}

test('init creates a recipe and refuses to overwrite', async () => {
  const { directory, filename } = await initialized();
  assert.match(await readFile(filename, 'utf8'), /schema_version: 1/);
  const stderr = output();
  assert.equal(await runCli(['init', '--directory', directory, '--recipe', 'text-inbox'], { stderr }), 1);
  assert.match(stderr.value(), /exist|overwrite/i);
});

test('init maps guided and scripted inputs to the same initializer without runtime access', async () => {
  const stdout = output();
  let received;
  const ask = async () => 'synthetic';
  const initialize = async settings => { received = settings; return { directory: '/synthetic/bundle', nextSteps: ['doctor'] }; };
  const code = await runCli(['init', '--directory', 'bundle', '--recipe', 'text-inbox', '--interactive',
    '--mailbox', 'agent@tenant.test', '--tenant', 'tenant-id', '--client', 'client-id',
    '--model-url', 'https://models.tenant.test/v1', '--model', 'model-v1',
    '--senders', 'alice@tenant.test,bob@tenant.test', '--recipients', 'alice@tenant.test,bob@tenant.test',
    '--auth-profile', 'dmarc', '--authserv-ids', 'mx.tenant.test', '--from-domains', 'tenant.test',
    '--id', 'help-inbox', '--state-root', '/state', '--graph-secret-env', 'MAIL_SECRET', '--model-key-env', 'MODEL_KEY'], {
    stdout, env: {}, ask, initialize, createRuntime: () => { throw new Error('No runtime'); },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, {
    directory: 'bundle', recipe: 'text-inbox', guided: true, env: {}, ask,
    answers: { mailbox: 'agent@tenant.test', tenant: 'tenant-id', client: 'client-id',
      modelUrl: 'https://models.tenant.test/v1', model: 'model-v1', senders: 'alice@tenant.test,bob@tenant.test',
      recipients: 'alice@tenant.test,bob@tenant.test', authProfile: 'dmarc', authservIds: 'mx.tenant.test',
      fromDomains: 'tenant.test', id: 'help-inbox', stateRoot: '/state', graphSecretEnv: 'MAIL_SECRET', modelKeyEnv: 'MODEL_KEY' },
  });
  assert.deepEqual(JSON.parse(stdout.value()).nextSteps, ['doctor']);
});

test('invalid init options fail before prompts or publication and do not echo their values', async () => {
  let invoked = false;
  const stderr = output();
  const initialize = () => { invoked = true; };
  for (const args of [
    ['--client-secret', 'PRIVATE_SENTINEL'], ['--interactive', '--interactive'], ['--mailbox'],
  ]) assert.equal(await runCli(['init', '--directory', 'bundle', '--recipe', 'text-inbox', ...args], { initialize, stderr }), 1);
  assert.equal(invoked, false);
  assert.doesNotMatch(stderr.value(), /PRIVATE_SENTINEL/);
});

test('guided CLI fails promptly with closed stdin instead of publishing a bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-closed-input-'));
  try {
    const directory = join(root, 'bundle');
    await assert.rejects(promisify(execFile)(process.execPath, [
      new URL('../src/cli.mjs', import.meta.url).pathname, 'init', '--directory', directory,
      '--recipe', 'text-inbox', '--interactive',
    ], { env: {}, timeout: 3000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /interactive terminal/);
      return true;
    });
    await assert.rejects(readFile(join(directory, 'agent.yaml')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('offline check never constructs a live runtime', async () => {
  const { filename } = await initialized();
  const stdout = output();
  const code = await runCli(['check', '--config', filename], {
    stdout, env: {}, createRuntime: () => { throw new Error('network boundary crossed'); },
  });
  assert.equal(code, 0);
  assert.match(stdout.value(), /offline/i);
});

test('stopped backup bypasses runtime construction and forwards bounded maintenance settings',async t=>{
  const {directory,filename}=await initialized();
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let received;
  const stdout=output(),stderr=output();
  const code=await runCli(['backup','--config',filename,'--directory',join(directory,'snapshot'),'--max-bytes','100000','--timeout-seconds','1'],{
    env:{},stdout,stderr,createRuntime:()=>{throw new Error('Backup must not construct a runtime.');},
    backupState:async settings=>{received=settings;return {snapshotId:'synthetic',stateSchema:4};}
  });
  assert.equal(code,0);assert.equal(stderr.value(),'');
  assert.equal(received.stateRoot,join(await realpath(directory),'state'));
  assert.equal(received.directory,join(directory,'snapshot'));
  assert.match(received.identity,/^[a-f0-9]{64}$/);
  assert.equal(received.maxBytes,100000);assert.equal(received.timeoutMs,1000);
  assert.deepEqual(JSON.parse(stdout.value()),{snapshotId:'synthetic',stateSchema:4});
});

test('backup limits fail before source access and unexpected errors omit private details',async()=>{
  const stderr=output();let invoked=0;
  const settings={env:{},stdout:output(),stderr,backupState:async()=>{invoked++;throw new Error('PRIVATE_BACKUP_SENTINEL');}};
  for(const value of ['0','-1','NaN','1.5']) assert.equal(await runCli(['backup','--config','unused','--directory','unused','--max-bytes',value],settings),1);
  assert.equal(invoked,0);
  const {filename}=await initialized();
  assert.equal(await runCli(['backup','--config',filename,'--directory','snapshot'],settings),1);
  assert.equal(invoked,1);assert.doesNotMatch(stderr.value(),/PRIVATE_BACKUP_SENTINEL/);
});

test('approval records explicit actor and reason', async () => {
  const { filename } = await initialized();
  let approval;
  const code = await runCli(['approve', '--config', filename, '--id', 'a-1', '--actor', 'operator@example.org', '--reason', 'Reviewed target'], {
    stdout: output(), createRuntime: () => ({ approve: async value => { approval = value; return { approved: true }; } }),
  });
  assert.equal(code, 0);
  assert.deepEqual(approval, { id: 'a-1', actor: 'operator@example.org', reason: 'Reviewed target' });
});

test('unknown options and absent approval reason fail before runtime creation', async () => {
  const stderr = output();
  assert.equal(await runCli(['check', '--unsafe'], { stderr }), 1);
  assert.match(stderr.value(), /unknown/i);
  assert.equal(await runCli(['approve', '--id', 'a-1', '--actor', 'operator@example.org'], { stderr }), 1);
  assert.match(stderr.value(), /reason/i);
});

test('live checks require secrets before calling the runtime', async () => {
  const { filename } = await initialized();
  let checked = false;
  const createRuntime = async () => ({ liveCheck: async () => { checked = true; return { connected: true }; } });
  assert.equal(await runCli(['check', '--config', filename, '--live'], { createRuntime, env: {}, stderr: output() }), 1);
  assert.equal(checked, false);
  assert.equal(await runCli(['check', '--config', filename, '--live'], { createRuntime, stdout: output(), env: { INBOX_GRAPH_CLIENT_SECRET: 'synthetic', INBOX_MODEL_API_KEY: 'synthetic' } }), 0);
  assert.equal(checked, true);
});

test('preview injects deterministic offline adapters and labels its limits', async () => {
  const { filename } = await initialized();
  const stdout = output();
  let settings;
  const code = await runCli(['preview', new URL('../examples/request.json', import.meta.url).pathname, '--config', filename], {
    stdout, env: {}, createRuntime: async value => {
      settings = value;
      return { processMessage: async mail => value.model.step({ messages: [{ role: 'user', content: mail.body }] }) };
    },
  });
  assert.equal(code, 0);
  assert.equal(settings.mode, 'preview');
  assert.equal(settings.filename, filename);
  assert.match(stdout.value(), /does not assess live model quality/);
  assert.match(stdout.value(), /Fixture preview:/);
  assert.deepEqual(await settings.mail.check(), { mode: 'fixture', connected: false });
  assert.equal((await settings.mcp.listTools()).size, 0);
  await assert.rejects(settings.mcp.call('external.write', {}), /unavailable.*fixture/i);
});

test('fixture adapter can refetch only seeded messages before replying', async () => {
  const message = await loadFixture(new URL('../examples/request.json', import.meta.url));
  assert.equal(message.attachments, false);
  const mail = createFixtureMail();
  await assert.rejects(mail.getMessage(message.id), /fixture mailbox/);
  mail.rememberMessage(message);
  assert.deepEqual(await mail.getMessage(message.id), message);
  await mail.reply(message, 'Synthetic response');
  assert.deepEqual(mail.sent, [{ id: message.id, text: 'Synthetic response' }]);
});

test('fixture preview demonstrates an unsupported attachment without retaining its contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mail-preview-unsupported-'));
  try {
    const request = JSON.parse(await readFile(new URL('../examples/request.json', import.meta.url), 'utf8'));
    request.attachments = [{ name: 'synthetic.pdf', content: 'PRIVATE_ATTACHMENT_SENTINEL' }];
    const filename = join(root, 'request.json');
    await writeFile(filename, JSON.stringify(request));
    const loaded = await loadFixture(filename);
    assert.equal(loaded.attachments, true);
    assert.doesNotMatch(JSON.stringify(loaded), /PRIVATE_ATTACHMENT_SENTINEL|synthetic.pdf/);
    const stdout = output();
    assert.equal(await runCli(['preview', filename, '--config', new URL('../examples/text-inbox/agent.yaml', import.meta.url).pathname], {
      stdout, env: {},
    }), 0);
    const result = JSON.parse(stdout.value()).result;
    assert.equal(result.status, 'completed');
    assert.match(result.reply, /plain text.*attachments/i);
    assert.doesNotMatch(stdout.value(), /PRIVATE_ATTACHMENT_SENTINEL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('doctor defaults offline, prints human results and never constructs a runtime', async () => {
  const stdout = output();
  let received;
  const report = { command: 'doctor', ready: true, checks: [{ id: 'configuration', status: 'pass' }] };
  const code = await runCli(['doctor', '--config', 'bundle/agent.yaml'], {
    stdout, env: {},
    doctor: async (filename, settings) => { received = { filename, settings }; return report; },
    formatDoctor: result => { assert.equal(result, report); return 'PASS configuration'; },
    createRuntime: () => { throw new Error('Doctor must never acquire runtime state'); },
  });
  assert.equal(code, 0);
  assert.deepEqual(received, { filename: 'bundle/agent.yaml', settings: { live: false, env: {} } });
  assert.equal(stdout.value(), 'PASS configuration\n');
});

test('health probes only the private control boundary and exits nonzero when stopped', async () => {
  const {filename}=await initialized();
  const stdout=output();
  let stateRoot;
  const code=await runCli(['health','--config',filename],{
    stdout,env:{},healthProbe:async root=>{stateRoot=root;return {live:false,ready:false,reason:'not-running'};},
    createRuntime:()=>{throw new Error('Health must not acquire SQLite or start a runtime');},
  });
  assert.equal(code,1);
  assert.match(stateRoot,/state$/);
  assert.deepEqual(JSON.parse(stdout.value()),{live:false,ready:false,reason:'not-running'});
});

test('health succeeds only for live ready state and CLI metadata pages retain bounds', async () => {
  const {filename}=await initialized();
  assert.equal(await runCli(['health','--config',filename],{stdout:output(),healthProbe:async()=>({live:true,ready:true})}),0);
  let page;
  assert.equal(await runCli(['status','--config',filename,'--limit','10','--after','cursor-1','--state','uncertain'],{
    stdout:output(),createRuntime:()=>({status:params=>{page=params;return {runs:[]};}}),
  }),0);
  assert.deepEqual(page,{limit:10,after:'cursor-1',status:'uncertain'});
  for(const limit of ['0','101','1.5','garbage']) assert.equal(await runCli(['status','--config',filename,'--limit',limit],{
    stderr:output(),createRuntime:()=>{throw new Error('Invalid pagination must fail before state open');},
  }),1);
});

test('doctor JSON preserves failed and not-checked results and exits nonzero', async () => {
  const stdout = output();
  const report = { command: 'doctor', ready: false, mode: 'live', externalMutations: false,
    checks: [{ id: 'mailbox', status: 'fail', code: 'mailbox-unavailable' }, { id: 'mcp', status: 'not-checked' }] };
  const code = await runCli(['doctor', '--config', 'missing.yaml', '--live', '--json'], {
    stdout, env: {}, doctor: async (filename, settings) => {
      assert.equal(filename, 'missing.yaml'); assert.equal(settings.live, true); return report;
    },
    formatDoctor: () => { throw new Error('JSON mode must not use human formatter'); },
    createRuntime: () => { throw new Error('No runtime'); },
  });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(stdout.value()), report);
});

test('doctor rejects unknown/duplicate flags and missing config before probes', async () => {
  const calls = [];
  const settings = { stderr: output(), doctor: async () => { calls.push('probe'); } };
  for (const argv of [
    ['doctor', '--live'], ['doctor', '--config', 'a.yaml', '--once'],
    ['doctor', '--config', 'a.yaml', '--json', '--json'],
  ]) assert.equal(await runCli(argv, settings), 1);
  assert.deepEqual(calls, []);
});

test('doctor unexpected errors cannot expose credentials or provider content', async () => {
  const stderr = output();
  const code = await runCli(['doctor', '--config', 'agent.yaml'], {
    stderr, doctor: async () => { throw new Error('PRIVATE_TOKEN_AND_MAIL_BODY'); },
  });
  assert.equal(code, 1);
  assert.doesNotMatch(stderr.value(), /PRIVATE_TOKEN_AND_MAIL_BODY/);
  assert.match(stderr.value(), /doctor|Doctor/);
});

test('CLI doctor uses actual offline diagnostics for a freshly initialized bundle', async () => {
  const { filename } = await initialized();
  const stdout = output();
  const code = await runCli(['doctor', '--config', filename, '--json'], {
    stdout, env: {}, createRuntime: () => { throw new Error('Offline doctor must not start a runtime'); },
  });
  const report = JSON.parse(stdout.value());
  assert.equal(code, 1);
  assert.equal(report.mode, 'offline');
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.id === 'configuration').status, 'pass');
  assert.equal(report.checks.find(check => check.id === 'placeholders').status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'secrets').status, 'fail');
  assert.equal(report.checks.find(check => check.id === 'mailbox').status, 'not-checked');
  assert.equal(report.externalMutations, false);
});
