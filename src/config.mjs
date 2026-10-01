import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import Ajv from 'ajv';
import { diagnosticError, tagDiagnostic } from './diagnostics-errors.mjs';

const string = { type: 'string', minLength: 1, maxLength: 4096 };
const envName = { type: 'string', pattern: '^[A-Z_][A-Z0-9_]*$', maxLength: 128 };
const email = { type: 'string', pattern: '^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$', maxLength: 254 };
const list = (items, minItems = 0) => ({ type: 'array', items, minItems, maxItems: 1000, uniqueItems: true });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const limit = (value, maximum) => ({ type: 'integer', minimum: 1, maximum, default: value });
const toolPolicy = object({
  effect: { enum: ['read', 'write'] }, authorization: { enum: ['automatic', 'approval'] },
  constraints: { type: 'object' },
}, ['effect', 'authorization']);
const network = { timeout_ms: limit(30000, 300000), max_response_bytes: limit(1048576, 20000000) };
const scope = { const: 'sender-group' };
const domains = list({ type: 'string', pattern: '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,63}$', maxLength: 253 }, 1);
const senderAuthentication = { oneOf: [
  object({ mode: { const: 'exchange-authenticated' },
    trusted_authserv_ids: list({ type: 'string', pattern: '^[A-Za-z0-9.-]+$', maxLength: 253 }, 1),
    transport_headers_verified: { type: 'boolean' } }),
  object({ mode: { const: 'exchange-internal' }, sender_domains: domains,
    transport_headers_verified: { type: 'boolean' } })
] };
const mcpConnection = {
  oneOf: [
    object({ transport: { const: 'stdio' }, command: string, args: { ...list(string), default: [] },
      env: { ...list(envName), default: [] }, pinned_version: string, authorization_scope: scope,
      actor_context: { const: 'mail-agent-v1' }, ...network }, ['transport', 'command', 'pinned_version', 'authorization_scope']),
    object({ transport: { const: 'streamable-http' }, url: string, token_env: envName,
      authorization_scope: scope, allow_insecure: { type: 'boolean', default: false },
      ...network }, ['transport', 'url', 'token_env', 'authorization_scope']),
  ],
};
const schema = object({
  schema_version: { const: 1 },
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' }, state_root: string,
  mailbox: object({
    provider: { const: 'microsoft-graph' }, tenant_id: { ...string, pattern: '^[A-Za-z0-9.-]+$' },
    client_id: { ...string, pattern: '^[A-Za-z0-9-]+$' }, client_secret_env: envName,
    address: email, intake: { const: 'delta-poll' }, delivery: { const: 'direct-reply' },
    poll_seconds: limit(30, 3600), timeout_ms: limit(30000, 300000),
    max_response_bytes: { ...limit(4000000, 20000000), minimum: 1024 },
    sender_authentication: senderAuthentication,
  }, ['provider', 'tenant_id', 'client_id', 'client_secret_env', 'address', 'intake', 'delivery', 'sender_authentication']),
  model: object({ api: { const: 'chat-completions' }, base_url: string, api_key_env: envName, name: string,
    allow_insecure: { type: 'boolean', default: false }, timeout_ms: limit(30000, 300000),
    capabilities: object({ tools: { type: 'boolean' }, images: { type: 'boolean' }, pdf: { type: 'boolean' } }),
  }, ['api', 'base_url', 'api_key_env', 'name', 'capabilities']),
  instructions: object({ agent: string, soul: string, workflows: { ...list(string), default: [] } }, ['agent']),
  policy: object({ senders: list(email, 1), recipients: list(email, 1), approvers: list(email),
    reply: { const: 'sender' }, tools: { type: 'object', additionalProperties: toolPolicy, default: {} },
  }, ['senders', 'recipients', 'approvers', 'reply']),
  mcp: { type: 'object', propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: mcpConnection, default: {} },
  limits: { ...object({ active_runs: { const: 1, default: 1 }, run_seconds: limit(120, 3600),
    model_calls: limit(6, 100), tool_calls: limit(10, 1000), context_tokens: limit(16384, 2000000),
    output_tokens: limit(2048, 100000), queue_messages: limit(100, 10000),
    attachment_bytes: limit(20000000, 100000000),
  }, []), default: {} },
  retention: { ...object({ content_hours: limit(24, 8760), audit_days: limit(30, 3650) }, []), default: {} },
}, ['schema_version', 'id', 'state_root', 'mailbox', 'model', 'instructions', 'policy']);
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const documentSchema = structuredClone(schema);
documentSchema.properties.schema_version = { const: 2 };
documentSchema.properties.model.properties.image_context_tokens = { ...limit(8192, 2000000), minimum: 256 };
documentSchema.properties.limits.properties.context_tokens.default = 65536;
documentSchema.properties.documents = object({
  images: object({ enabled: { type: 'boolean' }, max_count: limit(4, 4),
    max_file_bytes: limit(5242880, 5242880), max_total_bytes: limit(10485760, 10485760),
    max_pixels: limit(12000000, 20000000) }, ['enabled']),
  output: object({ format: { enum: ['text', 'text-attachment'], default: 'text' },
    filename: { const: 'transcription.txt', default: 'transcription.txt' },
    max_bytes: limit(262144, 2000000) }, []),
});
documentSchema.required.push('documents');
const validators = new Map([[1, ajv.compile(schema)], [2, ajv.compile(documentSchema)]]);
const constraintValidator = new Ajv({ strict: true, allErrors: true });

function secureUrl(value, allowInsecure, label) {
  let url;
  try { url = new URL(value); } catch { throw diagnosticError(`${label} must be a valid HTTPS URL`, 'endpoint-policy'); }
  if (url.username || url.password || url.hash) throw diagnosticError(`${label} must not contain credentials or a fragment`, 'endpoint-policy');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecure && local && url.protocol === 'http:')) {
    throw diagnosticError(`${label} requires HTTPS; allow_insecure permits only local HTTP fixtures`, 'endpoint-policy');
  }
}

function validatePolicies(config) {
  validateAuthentication(config.mailbox);
  if (config.schema_version === 1 && config.model.capabilities.images) throw new Error('images capability is unsupported in the text inbox slice');
  if (config.model.capabilities.pdf) throw new Error('pdf capability is unsupported in the text inbox slice');
  validateDocuments(config);
  if (config.limits.output_tokens >= config.limits.context_tokens) throw new Error('output_tokens must be smaller than context_tokens');
  if (Object.keys(config.mcp).length && !config.model.capabilities.tools) throw new Error('MCP requires the model tools capability');
  const names = Object.keys(config.mcp);
  for (const [name, policy] of Object.entries(config.policy.tools)) {
    if (!names.some(server => name.startsWith(`${server}.`) && name.length > server.length + 1)) {
      throw new Error('Tool policy must identify a configured MCP server and tool');
    }
    if (policy.authorization === 'approval' && !config.policy.approvers.length) throw new Error('Tool approval policy needs an approver');
    validateDomainPolicy(name, policy, names, config.mcp);
    validateConstraints(policy);
  }
}

function validateDomainPolicy(name, policy, names, connections) {
  const connection = names.find(server => name.startsWith(`${server}.`) && name.length > server.length + 1);
  const optedIn = connections[connection].actor_context === 'mail-agent-v1';
  if (optedIn && policy.effect === 'write' && policy.authorization === 'automatic') {
    throw new Error('Domain actor context does not permit automatic writes');
  }
}

function validateDocuments(config) {
  if (config.schema_version !== 2) return;
  const { images, output } = config.documents;
  if (config.model.capabilities.images !== images.enabled) throw new Error('Image capability must match the document recipe.');
  if (images.max_file_bytes > images.max_total_bytes) throw new Error('Image file limit exceeds the aggregate limit.');
  if (!images.enabled && output.format !== 'text') throw new Error('Attachment output requires the enabled image recipe.');
  const reserve = images.max_count * config.model.image_context_tokens;
  if (images.enabled && reserve + config.limits.output_tokens + 256 >= config.limits.context_tokens) throw new Error('Image context reservation must leave room for instructions and output.');
}

function validateAuthentication(mailbox) {
  if (mailbox.sender_authentication.mode !== 'exchange-internal') return;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(mailbox.tenant_id)) throw new Error('Internal authentication requires a GUID tenant identifier.');
}

function boundedSchema(schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (Object.hasOwn(schema, 'const') || Array.isArray(schema.enum)) return true;
  if (Number.isFinite(schema.maxLength) || Number.isFinite(schema.maximum) || Number.isFinite(schema.maxItems)) return true;
  return (schema.required ?? []).some(name => boundedSchema(schema.properties?.[name]));
}

function validateConstraints(policy) {
  if (policy.constraints) {
    try { constraintValidator.compile(policy.constraints); }
    catch { throw new Error('Tool policy has an invalid constraints JSON Schema'); }
  }
  if (policy.effect === 'write' && policy.authorization === 'automatic' && !boundedSchema(policy.constraints)) {
    throw new Error('Tool policy automatic writes require explicitly bounded constraints');
  }
}

function validateConnections(config, root) {
  secureUrl(config.model.base_url, config.model.allow_insecure, 'model.base_url');
  if (new URL(config.model.base_url).search) throw new Error('model.base_url must not contain a query');
  for (const [name, server] of Object.entries(config.mcp)) {
    if (server.transport === 'streamable-http') secureUrl(server.url, server.allow_insecure, `mcp.${name}.url`);
    else if (server.command !== 'node') {
      if (!isAbsolute(server.command) && !server.command.startsWith('./')) throw new Error(`mcp.${name}.command must be node or an explicit path`);
      server.command = resolve(root, server.command);
    }
    // AJV cannot apply branch defaults under oneOf; apply them after selection.
    server.timeout_ms ??= 30000;
    server.max_response_bytes ??= 1048576;
    if (server.transport === 'stdio') { server.args ??= []; server.env ??= []; }
  }
}

function validateSecrets(config, env) {
  const names = [config.mailbox.client_secret_env, config.model.api_key_env];
  for (const server of Object.values(config.mcp)) {
    if (server.token_env) names.push(server.token_env);
    if (server.env) names.push(...server.env);
  }
  for (const name of names) if (typeof env[name] !== 'string' || !env[name].trim()) throw new Error(`Missing required secret or environment variable: ${name}`);
}

async function loadInstructions(root, config) {
  try {
    const paths = [config.agent, ...(config.soul ? [config.soul] : []), ...config.workflows];
    const contents = [];
    for (const path of paths) {
      const filename = await realpath(resolve(root, path));
      const outside = relative(root, filename);
      if (outside === '..' || outside.startsWith('../') || isAbsolute(outside)) throw new Error('Instruction files must stay within the agent bundle');
      const info = await stat(filename);
      if (!info.isFile() || info.size > 262144) throw new Error('Instruction files must be regular files no larger than 256 KiB');
      contents.push(await readFile(filename, 'utf8'));
    }
    return contents.join('\n\n');
  } catch (error) {
    throw classifyInstructionFailure(error);
  }
}

function classifyInstructionFailure(error) {
  const retained = error?.message === 'Instruction files must stay within the agent bundle'
    || error?.message === 'Instruction files must be regular files no larger than 256 KiB';
  if (retained) return tagDiagnostic(error, 'instruction-files');
  return diagnosticError('Instruction files could not be loaded.', 'instruction-files');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function validateSchema(config) {
  const validate = validators.get(config?.schema_version);
  if (!validate) throw new Error('Unsupported configuration schema version.');
  if (!validate(config)) throw new Error(`Invalid configuration: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
}

export async function loadConfig(filename, { env = process.env, requireSecrets = false } = {}) {
  try {
  const root = await realpath(dirname(resolve(filename)));
  const text = await readFile(filename, 'utf8');
  if (Buffer.byteLength(text) > 262144) throw new Error('Configuration exceeds 256 KiB');
  let config;
  try { config = parse(text, { maxAliasCount: 0 }); }
  catch { throw new Error('Configuration must be valid YAML without aliases'); }
  validateSchema(config);
  validatePolicies(config);
  validateConnections(config, root);
  if (requireSecrets) validateSecrets(config, env);
  const instructions = await loadInstructions(root, config.instructions);
  const hash = createHash('sha256').update(JSON.stringify(canonical(config))).update('\n').update(instructions).digest('hex');
  config.state_root = resolve(root, config.state_root);
  return { config, instructions, hash, root, filename: resolve(filename) };
  } catch (error) {
    if (error?.diagnosticCode) throw error;
    throw tagDiagnostic(error, 'configuration');
  }
}
