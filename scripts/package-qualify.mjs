import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageContents } from './package-contract.mjs';
import { validatePackageLinks } from './package-links.mjs';

function run(command, args, settings) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...settings });
  if (result.error || result.status !== 0) throw new Error('Package qualification subprocess failed.');
  return result.stdout;
}

async function qualify(root, project) {
  const output = join(root, 'packed');
  const consumer = join(root, 'consumer');
  await mkdir(output);
  await mkdir(consumer);
  const userConfig = join(root, 'empty.npmrc');
  await writeFile(userConfig, '', { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: root, npm_config_userconfig: userConfig,
    npm_config_registry: 'https://registry.npmjs.org', npm_config_cache: join(root, 'cache') };
  const [pack] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: project, env }));
  const sources = (await readdir(join(project, 'src'))).filter(name => name.endsWith('.mjs'));
  const inventory = validatePackageContents(pack.files, sources);
  if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(pack.filename)) throw new Error('Invalid package filename.');
  await writeFile(join(consumer, 'package.json'), '{"private":true}', { mode: 0o600 });
  run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(output, pack.filename)], { cwd: consumer, env });
  const metadata = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const installed = join(consumer, 'node_modules', metadata.name);
  const inventoryPaths = pack.files.map(file => file.path);
  const documents = await Promise.all(pack.files.filter(file => file.path.endsWith('.md')).map(async file => ({
    path: file.path, text: await readFile(join(installed, file.path), 'utf8'),
  })));
  const packageLinks = validatePackageLinks(documents, inventoryPaths);
  const settings = { cwd: consumer, env: {} };
  const cli = (...args) => run(process.execPath, [join(installed, 'src/cli.mjs'), ...args], settings);
  assert.match(cli('--help'), /recovery-release-apply/);
  const config = join(installed, 'examples/text-inbox/agent.yaml');
  cli('check', '--config', config);
  const preview = JSON.parse(cli('preview', join(installed, 'examples/request.json'), '--config', config));
  assert.equal(preview.mode, 'fixture-preview');
  assert.equal(preview.result.status, 'completed');
  const bundle = join(consumer, 'agent');
  cli('init', '--directory', bundle, '--recipe', 'text-inbox');
  cli('check', '--config', join(bundle, 'agent.yaml'));
  const configured = JSON.parse(cli('init', '--directory', join(consumer, "operator's bundle"), '--recipe', 'text-inbox',
    '--mailbox', 'agent@tenant.test', '--tenant', 'synthetic-tenant', '--client', 'synthetic-client',
    '--model-url', 'https://model.tenant.test/v1', '--model', 'synthetic-model', '--senders', 'alice@tenant.test',
    '--recipients', 'alice@tenant.test', '--auth-profile', 'dmarc', '--authserv-ids', 'mx.tenant.test'));
  assert.equal(configured.nextSteps.length, 4);
  const checked = JSON.parse(run('sh', ['-c', configured.nextSteps[0]], settings));
  assert.equal(checked.mode, 'offline');
  const executable = join(consumer, 'node_modules/.bin/mail-agent');
  assert.match(run(executable, ['--help'], { cwd: consumer, env: { PATH: dirname(process.execPath) } }), /Mail Agent/);
  const recordsConfig = join(installed, 'examples/records-inbox/agent.yaml');
  cli('check', '--config', recordsConfig);
  await installedRecordsRead({ root, consumer, installed, recordsConfig });
  return { ...inventory, packageLinks, installedOutsideSource: true, executable: true, inertSetup: true,
    configuredSetupNextStep: true, fixtureReply: true, recordsRecipe: true, installedRecordsRead: true,
    deploymentCredentials: false, liveMailOrTools: false };
}

async function installedRecordsRead({ root, consumer, installed, recordsConfig }) {
  const privateRoot = join(root, 'records-smoke');
  const recordsRoot = join(privateRoot, 'records');
  const recordDirectory = join(recordsRoot, 'records', 'record-a');
  await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  await chmod(recordsRoot, 0o700);
  await chmod(join(recordsRoot, 'records'), 0o700);
  await chmod(recordDirectory, 0o700);
  const source = join(installed, 'examples/records-inbox');
  const recordFile = join(recordDirectory, 'record.json');
  const policyFile = join(privateRoot, 'actor-policy.json');
  const recordInput = join(source, 'record.json');
  await copyFile(recordInput, recordFile);
  await copyFile(join(source, 'actor-policy.json'), policyFile);
  await chmod(recordFile, 0o600);
  await chmod(policyFile, 0o600);
  const fixedClock = join(privateRoot, 'fixed-clock.mjs');
  await writeFile(fixedClock, 'Date.now = () => 1800000000000;\n', { mode: 0o600 });
  const script = join(privateRoot, 'installed-records-smoke.mjs');
  await writeFile(script, recordsSmokeSource(), { mode: 0o600 });
  try {
    const result = run(process.execPath, ['--import', fixedClock, script, installed, recordsConfig, recordsRoot, policyFile, fixedClock],
      { cwd: consumer, env: {} });
    const report = JSON.parse(result);
    assert.deepEqual(report, { read: true, server: 'records', recordId: 'record-a', revision: 1 });
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

function recordsSmokeSource() {
  return `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const [installed, configPath, recordsRoot, policyFile, fixedClock] = process.argv.slice(2);
const fromInstalled = path => import(pathToFileURL(path).href);
const [{ loadConfig }, { createMcp }, { createDomainContext }, { digest }] = await Promise.all([
  fromInstalled(installed + '/src/config.mjs'), fromInstalled(installed + '/src/mcp.mjs'),
  fromInstalled(installed + '/src/domain-context.mjs'), fromInstalled(installed + '/src/policy.mjs')
]);
const now = 1800000000000;
const { config } = await loadConfig(configPath, { env: {} });
config.mcp.records.command = process.execPath;
config.mcp.records.args = ['--import', fixedClock,
  installed + '/mcp/records/server.mjs', '--root', recordsRoot, '--policy', policyFile];
const client = createMcp(config.mcp, { root: process.cwd(), env: {}, clock: () => now });
try {
  const tools = await client.listTools();
  assert.ok(tools.has('records.get'));
  const tool = 'records.get', args = { recordId: 'record-a' };
  const run = { id: 'package-smoke-run', createdAt: now - 1000, mail: { id: 'synthetic-message',
    conversationId: 'synthetic-conversation', sender: 'alice@example.org', authenticated: true } };
  const context = createDomainContext({ run, call: { name: tool, args }, actionKey: digest([run.id, tool, args]),
    config, authorization: 'automatic', clock: () => now });
  const result = await client.call(tool, args, { context });
  const text = result.content?.find(part => part.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  const value = JSON.parse(text);
  assert.equal(value.record.content, 'Replace this synthetic note with an operator-reviewed record.');
  assert.match(value.recordHash, /^[a-f0-9]{64}$/);
  process.stdout.write(JSON.stringify({ read: true, server: 'records', recordId: value.record.id, revision: value.record.revision }));
} finally { await client.close(); }
`;
}

const root = await mkdtemp(join(tmpdir(), 'mail-agent-package-'));
try {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await qualify(root, project)));
} finally { await rm(root, { recursive: true, force: true }); }
