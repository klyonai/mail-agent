import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from './config.mjs';

const RECIPE = 'text-inbox';
const TEMPLATE_FILES = ['AGENT.md', 'agent.yaml'];
const REQUIRED_KEYS = ['mailbox', 'tenant', 'client', 'modelUrl', 'model', 'senders', 'recipients', 'authProfile'];
const ALLOWED_ANSWERS = new Set([...REQUIRED_KEYS, 'authservIds', 'fromDomains', 'id', 'stateRoot', 'graphSecretEnv', 'modelKeyEnv']);
const DEFAULTS = { id: RECIPE, stateRoot: './state', graphSecretEnv: 'INBOX_GRAPH_CLIENT_SECRET', modelKeyEnv: 'INBOX_MODEL_API_KEY' };
const DEFAULT_COMMAND = ['node', 'src/cli.mjs'];
const OPTIONAL_KEYS = ['id', 'stateRoot', 'graphSecretEnv', 'modelKeyEnv'];
const DEFAULT_FILESYSTEM = { chmod, link, lstat, mkdir, mkdtemp, rm, rmdir, writeFile };
const PROMPTS = {
  mailbox: { label: 'Mailbox address' }, tenant: { label: 'Microsoft tenant ID' }, client: { label: 'Microsoft application client ID' },
  modelUrl: { label: 'OpenAI-compatible model base URL' }, model: { label: 'Model name' },
  senders: { label: 'Allowed sender addresses (comma separated)' },
  recipients: { label: 'Allowed reply recipient addresses (comma separated)' },
  authProfile: { label: 'Sender authentication profile (dmarc or internal)' },
  authservIds: { label: 'Trusted Authentication-Results authorities (comma separated)' },
  fromDomains: { label: 'Allowed same-tenant sender domains (comma separated)' },
  id: { label: 'Agent identifier' }, stateRoot: { label: 'Private state directory' },
  graphSecretEnv: { label: 'Microsoft application secret environment variable' },
  modelKeyEnv: { label: 'Model API key environment variable' },
};

function error(message, cause) {
  return new Error(message, cause ? { cause } : undefined);
}

async function terminalAsk({ label, defaultValue }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw error('Guided setup requires an interactive terminal.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    return await input.question(`${label}${suffix}: `);
  } finally { input.close(); }
}

function listValues(value, key) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const cleaned = items.map(item => String(item).trim().toLowerCase()).filter(Boolean);
  if (!cleaned.length) throw error(`Missing required --${key} value.`);
  if (new Set(cleaned).size !== cleaned.length) throw error(`Repeated values in --${key}.`);
  return cleaned;
}

function requiredText(value, key) {
  if (typeof value !== 'string' || !value.trim()) throw error(`Missing required --${key} value.`);
  return value.trim();
}

async function askMissing(values, keys, ask, optional = false) {
  for (const key of keys) {
    if (Object.hasOwn(values, key) && String(values[key]).trim()) continue;
    const response = await ask({ key, ...PROMPTS[key], ...(optional ? { defaultValue: DEFAULTS[key] } : {}), required: !optional });
    if (response === null) throw error('Guided setup was cancelled.');
    values[key] = optional && !String(response ?? '').trim() ? DEFAULTS[key] : response;
  }
}

function profilePromptKey(values) {
  const profile = requiredText(values.authProfile, 'auth-profile').toLowerCase();
  if (profile === 'dmarc') return 'authservIds';
  if (profile === 'internal') return 'fromDomains';
  throw error('Sender authentication profile must be dmarc or internal.');
}

async function collectAnswers({ answers, guided, ask }) {
  const collected = { ...answers };
  const unknown = Object.keys(collected).filter(key => !ALLOWED_ANSWERS.has(key));
  if (unknown.length) throw error(`Unknown initialization field: ${unknown[0]}.`);
  if (guided) {
    await askMissing(collected, REQUIRED_KEYS, ask);
    await askMissing(collected, [profilePromptKey(collected)], ask);
    await askMissing(collected, OPTIONAL_KEYS, ask, true);
  }
  for (const key of REQUIRED_KEYS) requiredText(collected[key], key === 'modelUrl' ? 'model-url' : key === 'authProfile' ? 'auth-profile' : key);
  return collected;
}

function profileConfig(values) {
  const profile = requiredText(values.authProfile, 'auth-profile').toLowerCase();
  if (profile === 'dmarc') {
    if (Object.hasOwn(values, 'fromDomains')) throw error('--from-domains conflicts with --auth-profile dmarc.');
    return { mode: 'exchange-authenticated', trusted_authserv_ids: listValues(values.authservIds, 'authserv-ids'), transport_headers_verified: false };
  }
  if (profile === 'internal') {
    if (Object.hasOwn(values, 'authservIds')) throw error('--authserv-ids conflicts with --auth-profile internal.');
    return { mode: 'exchange-internal', sender_domains: listValues(values.fromDomains, 'from-domains'), transport_headers_verified: false };
  }
  throw error('Sender authentication profile must be dmarc or internal.');
}

function makeConfig(values) {
  const senders = listValues(values.senders, 'senders');
  const recipients = listValues(values.recipients, 'recipients');
  if (senders.some(sender => !recipients.includes(sender))) throw error('Every allowed sender must also be an allowed reply recipient.');
  const config = {
    schema_version: 1,
    id: values.id ? requiredText(values.id, 'id') : DEFAULTS.id,
    state_root: values.stateRoot ? requiredText(values.stateRoot, 'state-root') : DEFAULTS.stateRoot,
    mailbox: {
      provider: 'microsoft-graph', tenant_id: requiredText(values.tenant, 'tenant'),
      client_id: requiredText(values.client, 'client'),
      client_secret_env: values.graphSecretEnv ? requiredText(values.graphSecretEnv, 'graph-secret-env') : DEFAULTS.graphSecretEnv,
      address: requiredText(values.mailbox, 'mailbox').toLowerCase(), intake: 'delta-poll', delivery: 'direct-reply',
      sender_authentication: profileConfig(values),
    },
    model: {
      api: 'chat-completions', base_url: requiredText(values.modelUrl, 'model-url'),
      api_key_env: values.modelKeyEnv ? requiredText(values.modelKeyEnv, 'model-key-env') : DEFAULTS.modelKeyEnv,
      name: requiredText(values.model, 'model'), capabilities: { tools: false, images: false, pdf: false },
    },
    instructions: { agent: 'AGENT.md', workflows: [] },
    policy: { senders, recipients, approvers: [], reply: 'sender', tools: {} },
    mcp: {}, limits: {}, retention: { content_hours: 24, audit_days: 30 },
  };
  return `${stringify(config, { lineWidth: 0 })}`;
}

async function stageBundle(parent, files, filesystem) {
  const stage = await filesystem.mkdtemp(join(parent, '.mail-agent-init-'));
  try {
    await filesystem.chmod(stage, 0o700);
    for (const [name, contents] of Object.entries(files)) {
      await filesystem.writeFile(join(stage, name), contents, { flag: 'wx', mode: 0o600 });
      await filesystem.chmod(join(stage, name), 0o600);
    }
  } catch (cause) {
    await filesystem.rm(stage, { recursive: true, force: true });
    throw cause;
  }
  return stage;
}

async function targetExists(target, filesystem) {
  try { await filesystem.lstat(target); return true; }
  catch (cause) { if (cause.code === 'ENOENT') return false; throw error('Cannot inspect the target path.', cause); }
}

function targetAlreadyExists() {
  return error('Target already exists; init refuses to overwrite directories, files, or symbolic links.');
}

async function removeOwnedFiles(target, published, filesystem) {
  for (const item of published.reverse()) {
    try {
      const current = await filesystem.lstat(item.path);
      if (current.dev === item.dev && current.ino === item.ino) await filesystem.rm(item.path);
    } catch { /* Preserve anything no longer owned by this initializer. */ }
  }
  if (!target) return;
  try {
    const current = await filesystem.lstat(target.path);
    if (current.dev === target.dev && current.ino === target.ino) await filesystem.rmdir(target.path);
  } catch { /* A nonempty or replaced target belongs to an external writer. */ }
}

async function publishBundle(stage, targetPath, filesystem) {
  const target = { path: targetPath };
  const published = [];
  let reserved;
  try {
    if (await targetExists(targetPath, filesystem)) throw targetAlreadyExists();
    await filesystem.mkdir(targetPath, { mode: 0o700 });
    reserved = await filesystem.lstat(targetPath);
    target.dev = reserved.dev;
    target.ino = reserved.ino;
    for (const name of ['AGENT.md', 'agent.yaml']) {
      const staged = await filesystem.lstat(join(stage, name));
      const destination = join(targetPath, name);
      published.push({ path: destination, dev: staged.dev, ino: staged.ino });
      await filesystem.link(join(stage, name), destination);
    }
  } catch (cause) {
    await removeOwnedFiles(reserved ? target : undefined, published, filesystem);
    if (cause.code === 'EEXIST') throw targetAlreadyExists();
    throw cause;
  }
}

function copyInstructions() {
  return 'Configure mailbox identity, sender authentication, allowlists, model endpoint, and secret environment variables before starting.';
}

function configuredInstructions(targetPath, config) {
  return `Bundle created at ${targetPath}. Supply the configured secret variables (${config.mailbox.client_secret_env}, ${config.model.api_key_env}) through your deployment secret manager. Ask a mail administrator to verify transport authentication headers, then make that explicit trust decision in agent.yaml before live checks. For a container deployment, set state_root to /state in agent.yaml before starting. Run live doctor only after secrets and transport verification are in place; start only after controlled live email acceptance.`;
}

function safeCommand(command) {
  if (!Array.isArray(command) || command.length < 1 || command.length > 8
    || command.some(value => typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value))) {
    throw error('Initialization command must be a bounded array of nonempty arguments.');
  }
  return command;
}

function commandLine(command, args) {
  return [...command, ...args].map(shellQuote).join(' ');
}

function configuredSteps(targetPath, command) {
  const config = join(targetPath, 'agent.yaml');
  return [
    commandLine(command, ['check', '--config', config]),
    commandLine(command, ['doctor', '--config', config]),
    commandLine(command, ['doctor', '--live', '--config', config]),
    commandLine(command, ['start', '--config', config]),
  ];
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

async function templateFiles() {
  const files = {};
  for (const name of TEMPLATE_FILES) files[name] = await readFile(new URL(`../examples/text-inbox/${name}`, import.meta.url), 'utf8');
  return files;
}

async function prepareFiles({ guided, answers, ask }) {
  if (!guided && Object.keys(answers).length === 0) return { files: await templateFiles(), configured: false };
  const values = await collectAnswers({ answers, guided, ask });
  return { files: { ...await templateFiles(), 'agent.yaml': makeConfig(values) }, configured: true };
}

function normalizeOptions(options) {
  const values = {
    directory: options.directory, recipe: options.recipe ?? RECIPE,
    guided: options.guided ?? false, answers: options.answers ?? {},
    env: options.env ?? process.env, ask: options.ask ?? terminalAsk,
    command: safeCommand(options.command ?? DEFAULT_COMMAND),
    filesystem: { ...DEFAULT_FILESYSTEM, ...(options.filesystem ?? {}) },
  };
  if (values.recipe !== RECIPE) throw error(`Unknown recipe; supported recipe: ${RECIPE}.`);
  if (!values.directory || typeof values.directory !== 'string') throw error('Missing initialization directory.');
  return values;
}

async function buildBundle(targetPath, files, env, filesystem) {
  const parent = dirname(targetPath);
  await filesystem.mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = await stageBundle(parent, files, filesystem);
  let loaded;
  try {
    loaded = await loadConfig(join(stage, 'agent.yaml'), { env, requireSecrets: false });
    await publishBundle(stage, targetPath, filesystem);
  } finally { await filesystem.rm(stage, { recursive: true, force: true }); }
  return loaded;
}

function initializedResult(targetPath, configured, config, command) {
  if (!configured) return { directory: targetPath, instructions: copyInstructions() };
  return { directory: targetPath, instructions: configuredInstructions(targetPath, config), nextSteps: configuredSteps(targetPath, command) };
}

async function refuseExistingTarget(targetPath, filesystem) {
  if (await targetExists(targetPath, filesystem)) throw targetAlreadyExists();
}

export async function initializeAgent(options = {}) {
  const values = normalizeOptions(options);
  const targetPath = resolve(values.directory);
  await refuseExistingTarget(targetPath, values.filesystem);
  const prepared = await prepareFiles(values);
  const loaded = await buildBundle(targetPath, prepared.files, values.env, values.filesystem);
  return initializedResult(targetPath, prepared.configured, loaded.config, values.command);
}
