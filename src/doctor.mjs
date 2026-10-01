import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { createGraph } from './graph.mjs';
import { createModel } from './model.mjs';
import { createMcp } from './mcp.mjs';
import { classifyDiagnostic } from './diagnostics-errors.mjs';

const CHECKS = ['configuration', 'placeholders', 'secrets', 'policy', 'transport', 'state', 'mailbox', 'model', 'mcp'];
const TEXT_PROBE = 'Mail Agent compatibility check. Reply with the single word OK. Do not call a tool.';
const TOOL_PROBE = 'Call doctor.probe exactly once with marker probe. Do not call any other tool.';
const TOOL_SCHEMA = { type: 'object', properties: { marker: { const: 'probe' } }, required: ['marker'], additionalProperties: false };
const DEFAULT_FILESYSTEM = { access, lstat, realpath };
const DIAGNOSTIC_MESSAGES = {
  credential: 'The dependency rejected configured credentials.',
  'access-denied': 'The dependency denied access.',
  'mailbox-unavailable': 'The mailbox is unavailable or not provisioned.',
  dns: 'The dependency hostname could not be resolved.',
  connection: 'The dependency connection failed.',
  tls: 'TLS verification failed for the dependency.',
  timeout: 'The dependency probe timed out.',
  cancelled: 'The dependency probe was cancelled.',
  throttled: 'The dependency is rate limiting the probe.',
  'invalid-response': 'The dependency returned an invalid or oversized response.',
  'endpoint-policy': 'The dependency endpoint violates the configured network policy.',
  configuration: 'The dependency could not be constructed from the current configuration.',
  'instruction-files': 'The dependency could not be constructed from the current instruction bundle.',
  'model-unsupported': 'The model endpoint does not support the configured request.',
  'tool-unavailable': 'A configured MCP tool is unavailable.',
};
const DIAGNOSTIC_REMEDIES = {
  credential: 'Check that the configured credential is current and available to this deployment.',
  'access-denied': 'Ask the administrator to verify application grants and the permitted mailbox scope.',
  'mailbox-unavailable': 'Confirm the mailbox exists, is enabled, and has the required service license.',
  dns: 'Check DNS resolution for the configured service host.',
  connection: 'Check firewall access and whether the configured service is available.',
  tls: 'Check the endpoint hostname, certificate chain, and system trust store.',
  timeout: 'Check service reachability and configured timeouts, then retry.',
  cancelled: 'The probe was cancelled; rerun it when the deployment is ready.',
  throttled: 'Wait for the provider retry window, then run doctor again.',
  'invalid-response': 'Check provider compatibility and response limits.',
  'endpoint-policy': 'Use the configured HTTPS endpoint and remove redirects or unsupported endpoint settings.',
  configuration: 'Correct the dependency configuration and run doctor again.',
  'instruction-files': 'Correct the configured instruction bundle paths and run doctor again.',
  'model-unsupported': 'Check the model identifier and the endpoint’s Chat Completions compatibility.',
  'tool-unavailable': 'Check the configured MCP server and declared tool names.',
};

function result(id, status, code, message, remedy) {
  return { id, status, code, message, remedy };
}

function unknownChecks(status = 'not-checked') {
  return CHECKS.slice(1).map(id => result(id, status, `${id}-not-checked`, 'This check was not run.', 'Resolve the configuration check first.'));
}

function configFailure(error, mode) {
  const classified = safeCode(error, 'configuration');
  const code = ['configuration', 'instruction-files'].includes(classified) ? classified : 'configuration';
  const checks = [result('configuration', 'fail', code, 'The configuration bundle could not be validated.', 'Fix the YAML schema and required instruction files, then run doctor again.'), ...unknownChecks()];
  return { command: 'doctor', mode, ready: false, externalMutations: false, checks, limitations: [] };
}

const SAFE_CODES = new Set([
  'configuration-invalid', 'placeholder-values', 'required-secret-missing', 'policy-mismatch',
  'transport-unverified', 'state-root-insecure', 'state-root-unavailable', 'state-root-ready',
  'credential', 'authorization', 'rate-limited', 'connectivity', 'timeout', 'response-invalid',
  'model-unavailable', 'model-incompatible', 'mcp-unavailable', 'mcp-tools-missing',
  'probe-not-run', 'no-connections', 'access-denied', 'mailbox-unavailable', 'dns', 'connection',
  'tls', 'cancelled', 'throttled', 'invalid-response', 'endpoint-policy', 'configuration',
  'instruction-files', 'model-unsupported', 'tool-unavailable', 'dependency-failed',
]);

function safeCode(error, fallback = 'dependency-unavailable') {
  try {
    const code = classifyDiagnostic(error);
    if (SAFE_CODES.has(code)) return code;
  } catch { /* Classification failure must not expose the original error. */ }
  return fallback;
}

function isPlaceholder(value) {
  if (typeof value !== 'string') return false;
  return /(?:^|[./_-])example(?:[./_-]|$)|example\.(?:org|com|net)|placeholder|your[-_ ]?(?:tenant|application|model|endpoint)|<[^>]*(?:model|tenant|application|endpoint)[^>]*>/i.test(value);
}

function configuredValues(config) {
  const auth = config.mailbox.sender_authentication;
  const mcpValues = Object.values(config.mcp).flatMap(server => [server.url, server.command, ...(server.args ?? [])]);
  return [config.mailbox.tenant_id, config.mailbox.client_id, config.mailbox.address,
    ...(auth.trusted_authserv_ids ?? []), ...(auth.sender_domains ?? []),
    config.model.base_url, config.model.name, ...config.policy.senders, ...config.policy.recipients,
    ...config.policy.approvers, ...mcpValues];
}

function placeholderCheck(config) {
  const found = configuredValues(config).some(isPlaceholder);
  return found
    ? result('placeholders', 'fail', 'placeholder-values', 'Example or placeholder values remain in live connection or mail policy fields.', 'Replace the marked example values with tenant-approved identities and endpoints.')
    : result('placeholders', 'pass', 'placeholders-clear', 'No obvious example values were found in connection or mail policy fields.', 'Review all identities and endpoints before deployment.');
}

function secretNames(config) {
  const names = [config.mailbox.client_secret_env, config.model.api_key_env];
  for (const server of Object.values(config.mcp)) {
    if (server.token_env) names.push(server.token_env);
    names.push(...(server.env ?? []));
  }
  return [...new Set(names)];
}

function secretCheck(config, env) {
  const missing = secretNames(config).filter(name => typeof env[name] !== 'string' || !env[name].trim());
  return missing.length
    ? result('secrets', 'fail', 'required-secret-missing', `Required environment variables are unset: ${missing.join(', ')}.`, 'Supply each named value through the deployment secret manager; values are never displayed.')
    : result('secrets', 'pass', 'secrets-present', 'All configured secret and child environment variables are present.', 'Keep these values in the deployment secret manager.');
}

function policyCheck(config) {
  const senders = new Set(config.policy.senders.map(value => value.toLowerCase()));
  const missing = [...senders].filter(sender => !config.policy.recipients.some(value => value.toLowerCase() === sender));
  return missing.length
    ? result('policy', 'fail', 'policy-mismatch', 'Some admitted senders are not allowed as direct reply recipients.', 'Add intended senders to the recipient allowlist or remove them from the sender allowlist.')
    : result('policy', 'pass', 'policy-consistent', 'Every admitted sender is an allowed direct reply recipient.', 'Confirm these lists match the intended disclosure policy.');
}

function transportCheck(config) {
  return config.mailbox.sender_authentication.transport_headers_verified === true
    ? result('transport', 'pass', 'transport-verified', 'The bundle records administrator verification of trusted mail headers.', 'Confirm the receiving transport still strips forged or duplicate authentication results.')
    : result('transport', 'fail', 'transport-unverified', 'Mail transport authentication headers are not marked as administrator verified.', 'Ask the mail administrator to verify header protection before setting this explicit configuration decision.');
}

async function lstatIfPresent(path, filesystem) {
  try { return await filesystem.lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function safeSystemAlias(current, info, filesystem) {
  if (info.uid !== 0) return false;
  const target = await filesystem.realpath(current);
  const targetInfo = await filesystem.lstat(target);
  return targetInfo.isDirectory() && targetInfo.uid === 0
    && ((targetInfo.mode & 0o022) === 0 || (targetInfo.mode & 0o1000) !== 0);
}

async function unsafeAncestorEntry(current, targetPath, info, filesystem) {
  if (!info) return false;
  if (info.isSymbolicLink()) {
    if (current === targetPath) return true;
    return !(await safeSystemAlias(current, info, filesystem));
  }
  if (!info.isDirectory() || (info.mode & 0o022) === 0) return false;
  return !(info.uid === 0 && (info.mode & 0o1000) !== 0);
}

async function symlinkInAncestry(path, filesystem) {
  const targetPath = resolve(path);
  let current = targetPath;
  for (;;) {
    const info = await lstatIfPresent(current, filesystem);
    if (await unsafeAncestorEntry(current, targetPath, info, filesystem)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function stateCheck(path, filesystem, uid) {
  try {
    if (await symlinkInAncestry(path, filesystem)) return result('state', 'fail', 'state-root-insecure', 'The configured state path has an unsafe symbolic link in its ancestry.', 'Choose a private local directory without symbolic links in its path.');
    const info = await lstatIfPresent(path, filesystem);
    if (info) {
      if (await stateFileLinks(path, filesystem)) return result('state', 'fail', 'state-root-insecure', 'A state database or ownership file is a symbolic link.', 'Remove the symbolic link and restore the state file from a trusted backup.');
      return existingStateCheck(path, info, filesystem, uid);
    }
    return missingStateCheck(path, filesystem);
  } catch {
    return result('state', 'fail', 'state-root-unavailable', 'The state directory could not be inspected safely.', 'Check filesystem access and select a local persistent state directory.');
  }
}

async function stateFileLinks(path, filesystem) {
  const files = ['owner.lock', 'owner.sqlite', 'owner.sqlite-journal', 'owner.sqlite-wal', 'owner.sqlite-shm',
    'agent.sqlite', 'agent.sqlite-journal', 'agent.sqlite-wal', 'agent.sqlite-shm'];
  for (const file of files) {
    const info = await lstatIfPresent(resolve(path, file), filesystem);
    if (info?.isSymbolicLink()) return true;
  }
  return false;
}

async function existingStateCheck(path, info, filesystem, uid) {
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    return result('state', 'fail', 'state-root-insecure', 'The existing state path is not an owner-owned private directory.', 'Set up an owner-owned directory with mode 0700; doctor will not change permissions.');
  }
  try {
    await filesystem.access(path, constants.W_OK | constants.X_OK);
    return result('state', 'pass', 'state-root-ready', 'The existing private state directory is writable by this process.', 'Keep the volume persistent and restrict access to the service owner.');
  } catch {
    return result('state', 'fail', 'state-root-insecure', 'The existing private state directory is not writable by this process.', 'Grant write and search access to the service owner; doctor will not change permissions.');
  }
}

async function missingStateCheck(path, filesystem) {
  let parent = dirname(path);
  while (!(await lstatIfPresent(parent, filesystem))) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const canonicalParent = await filesystem.realpath(parent);
  const info = await filesystem.lstat(canonicalParent);
  if (!info?.isDirectory() || (info.mode & 0o022) !== 0) {
    return result('state', 'fail', 'state-root-insecure', 'No safe writable parent was found for the state directory.', 'Create a private local parent directory owned by the service account.');
  }
  try {
    await filesystem.access(canonicalParent, constants.W_OK | constants.X_OK);
    return result('state', 'pass', 'state-root-ready', 'The state directory is absent; its nearest existing parent is writable.', 'On startup, create the state directory with owner-only permissions and preserve it across restarts.');
  } catch {
    return result('state', 'fail', 'state-root-insecure', 'The nearest existing state parent is not writable by this process.', 'Grant write and search access to the service owner; doctor will not create or change the directory.');
  }
}

function offlineReport(loaded, env) {
  const { config } = loaded;
  return [
    result('configuration', 'pass', 'configuration-valid', 'Configuration and instruction files are valid.', 'Keep the bundle readable only by its operators.'),
    placeholderCheck(config), secretCheck(config, env), policyCheck(config), transportCheck(config),
  ];
}

function dependencyResult(id, error) {
  const classified = safeCode(error, 'dependency-failed');
  return result(id, 'fail', classified, DIAGNOSTIC_MESSAGES[classified] ?? 'The dependency probe failed.',
    DIAGNOSTIC_REMEDIES[classified] ?? 'Check this dependency’s endpoint and deployment configuration.');
}

function skipped(id, code, message, remedy) {
  return result(id, 'not-checked', code, message, remedy);
}

function readyFrom(checks) {
  return checks.every(check => check.status !== 'fail');
}

function summarize(loaded, checks) {
  return { command: 'doctor', mode: 'offline', ready: readyFrom(checks), externalMutations: false, checks, limitations: limitations(loaded.config) };
}

function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function loadBundle(filename, load, env) {
  try { return { loaded: await load(filename, { env, requireSecrets: false }) }; }
  catch (error) { return { error }; }
}

function limitations(config) {
  return [
    'Readiness probes do not verify sender authentication or Exchange/Entra mailbox permission scope.',
    'Synthetic model probes do not measure model quality; run controlled live email acceptance to verify recipient delivery.',
    ...(Object.keys(config.mcp).length ? ['Configured MCP servers may have startup or session effects even though doctor never invokes a tool.'] : []),
    ...(config.mailbox.sender_authentication.transport_headers_verified === true ? [] : ['Mail intake remains blocked until an administrator verifies and explicitly configures trusted transport headers.']),
  ];
}

async function probeMailbox(loaded, env, createMail) {
  if (!env[loaded.config.mailbox.client_secret_env]?.trim()) return skipped('mailbox', 'probe-not-run', 'Mailbox probe skipped because its credential is missing.', `Set ${loaded.config.mailbox.client_secret_env}, then run doctor --live.`);
  try {
    const mail = await createMail(loaded.config.mailbox, { env });
    const response = await mail.check();
    return response?.status === 'ready'
      ? result('mailbox', 'pass', 'mailbox-ready', 'The configured mailbox accepted a read-only connectivity probe.', 'Verify tenant scope separately with allowed and denied mailbox checks.')
      : result('mailbox', 'fail', 'connectivity', 'The mailbox returned an unexpected probe result.', 'Check the Graph application configuration and retry.');
  } catch (error) { return dependencyResult('mailbox', error); }
}

function cleanModelResult(resultValue) {
  if (!resultValue || typeof resultValue.text !== 'string' || !resultValue.text.trim()) return false;
  return !resultValue.toolCalls || (Array.isArray(resultValue.toolCalls) && resultValue.toolCalls.length === 0);
}

function exactProbeArguments(args) {
  return Boolean(args) && typeof args === 'object' && !Array.isArray(args)
    && args.marker === 'probe' && Object.keys(args).length === 1;
}

function exactSyntheticToolCall(generated) {
  if (!generated || !Array.isArray(generated.toolCalls) || generated.toolCalls.length !== 1) return false;
  const call = generated.toolCalls[0];
  return call?.name === 'doctor.probe' && exactProbeArguments(call.args);
}

async function probeModelToolCalling(model, maxOutputTokens) {
  const tools = new Map([['doctor.probe', { description: 'Synthetic diagnostic capability probe with no external effect.', inputSchema: TOOL_SCHEMA }]]);
  const generated = await model.step({ messages: [{ role: 'user', content: TOOL_PROBE }], tools, maxOutputTokens });
  if (exactSyntheticToolCall(generated)) return undefined;
  return result('model', 'fail', 'model-unsupported', 'The model did not generate the exact synthetic tool call within the probe budget.', 'Check the endpoint’s tool-calling support and configured output budget; no tool was executed.');
}

async function probeModel(loaded, env, createModelFn) {
  const settings = loaded.config.model;
  const key = env[settings.api_key_env];
  if (!key?.trim()) return skipped('model', 'probe-not-run', 'Model probe skipped because its credential is missing.', `Set ${settings.api_key_env}, then run doctor --live.`);
  const model = await createModelFn(settings, { apiKey: key });
  const maxOutputTokens = Math.min(512, loaded.config.limits.output_tokens);
  const text = await model.step({ messages: [{ role: 'user', content: TEXT_PROBE }], tools: new Map(), maxOutputTokens });
  if (!cleanModelResult(text)) return result('model', 'fail', 'model-unsupported', 'The model did not return a plain text compatibility response within the probe budget.', 'Check the model name, Chat Completions compatibility and configured output budget.');
  if (settings.capabilities.tools) {
    const failure = await probeModelToolCalling(model, maxOutputTokens);
    if (failure) return failure;
  }
  const message = settings.capabilities.tools ? 'The model returned text and generated the exact synthetic tool call.' : 'The model returned a plain text compatibility response.';
  return result('model', 'pass', 'model-ready', message, 'This confirms protocol compatibility only, not response quality.');
}

async function probeModelSafe(loaded, env, createModelFn) {
  try { return await probeModel(loaded, env, createModelFn); }
  catch (error) { return dependencyResult('model', error); }
}

async function probeMcp(loaded, env, createMcpFn) {
  const { config } = loaded;
  const servers = Object.values(config.mcp);
  if (!servers.length) return skipped('mcp', 'no-connections', 'No MCP connections are configured.', 'Add an explicitly reviewed MCP connection only if the workflow needs tools.');
  const required = secretNames(config).filter(name => servers.some(server => server.token_env === name || server.env?.includes(name)));
  const missing = required.filter(name => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) return skipped('mcp', 'probe-not-run', 'MCP probes were skipped because configured connection environment values are missing.', `Set the configured variables (${missing.join(', ')}) and run doctor --live.`);
  let mcp;
  try {
    mcp = await createMcpFn(config.mcp, { env, root: loaded.root });
    const tools = await mcp.listTools();
    const missingTools = Object.keys(config.policy.tools).filter(name => !tools.has(name));
    return missingTools.length
      ? result('mcp', 'fail', 'mcp-tools-missing', 'One or more explicitly configured tools are unavailable.', 'Check MCP server tool names and reviewed policy entries.')
      : result('mcp', 'pass', 'mcp-ready', 'Configured MCP servers connected and listed tools without invoking any tool.', 'Tool behavior and resource authorization require separate acceptance.');
  } catch (error) { return dependencyResult('mcp', error); }
  finally { if (mcp?.close) await mcp.close().catch(() => {}); }
}

async function liveReport(loaded, env, factories, baseChecks) {
  const placeholder = baseChecks.find(check => check.id === 'placeholders' && check.status === 'fail');
  if (placeholder) {
    const remediation = 'Replace example identities and endpoints before contacting configured services.';
    const checks = [...baseChecks,
      skipped('mailbox', 'probe-not-run', 'Mailbox probe skipped because placeholder values remain.', remediation),
      skipped('model', 'probe-not-run', 'Model probe skipped because placeholder values remain.', remediation),
      skipped('mcp', 'probe-not-run', 'MCP probes skipped because placeholder values remain.', remediation),
    ];
    return { command: 'doctor', mode: 'live', ready: false, externalMutations: false, checks, limitations: limitations(loaded.config) };
  }
  const [mailbox, model, mcp] = await Promise.all([
    probeMailbox(loaded, env, factories.createMail),
    probeModelSafe(loaded, env, factories.createModel),
    probeMcp(loaded, env, factories.createMcp),
  ]);
  const checks = [...baseChecks, mailbox, model, mcp];
  return { command: 'doctor', mode: 'live', ready: readyFrom(checks), externalMutations: false, checks, limitations: limitations(loaded.config) };
}

async function composeDoctorReport(loaded, env, live, factories, filesystem, uid) {
  const checks = offlineReport(loaded, env);
  checks.push(await stateCheck(loaded.config.state_root, filesystem, uid));
  if (!live) {
    checks.push(skipped('mailbox', 'probe-not-run', 'Mailbox dependency was not contacted in offline mode.', 'Use explicit live doctor after reviewing endpoint and credential configuration.'));
    checks.push(skipped('model', 'probe-not-run', 'Model dependency was not contacted in offline mode.', 'Use explicit live doctor after reviewing endpoint and credential configuration.'));
    checks.push(skipped('mcp', 'probe-not-run', 'MCP dependencies were not contacted in offline mode.', 'Use explicit live doctor to check configured MCP servers.'));
    return summarize(loaded, checks);
  }
  return liveReport(loaded, env, factories, checks);
}

export async function runDoctor(filename, {
  live = false, env = process.env, load = loadConfig, createMail = createGraph,
  createModel: createModelFn = createModel, createMcp: createMcpFn = createMcp,
  filesystem = DEFAULT_FILESYSTEM, uid = defaultUid(),
} = {}) {
  const mode = live ? 'live' : 'offline';
  const bundleResult = await loadBundle(filename, load, env);
  if (!bundleResult.loaded) return configFailure(bundleResult.error, mode);
  return composeDoctorReport(bundleResult.loaded, env, live,
    { createMail, createModel: createModelFn, createMcp: createMcpFn }, filesystem, uid);
}

export function formatDoctor(report) {
  const lines = [`Mail Agent doctor (${report.mode}): ${report.ready ? 'ready for next setup step' : 'needs attention'}`, 'Requested effects: no email sends or MCP tool invocations.'];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.id} [${check.code}]: ${check.message}`);
    if (check.status !== 'pass') lines.push(`  Next: ${check.remedy}`);
  }
  if (report.limitations.length) {
    lines.push('Limitations:');
    for (const item of report.limitations) lines.push(`  - ${item}`);
  }
  return lines.join('\n');
}
