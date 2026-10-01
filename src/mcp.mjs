import { isAbsolute, resolve } from 'node:path';
import { TransformStream } from 'node:stream/web';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { classifyDiagnostic, diagnosticError } from './diagnostics-errors.mjs';
import { DOMAIN_CONTEXT_KEY, validateDomainContext } from './domain-context.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_TOOLS = 256;

function jsonValue(value, maximum) {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > maximum) throw diagnosticError('MCP response exceeded limit', 'invalid-response');
  return JSON.parse(serialized);
}

function bounded(operation, timeout, signal) {
  const controller = new AbortController();
  let timer;
  let abort;
  const cancellation = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(diagnosticError('MCP request cancelled', 'cancelled')); };
    timer = setTimeout(() => {
      controller.abort();
      reject(diagnosticError('MCP request timed out', 'timeout'));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const work = signal?.aborted ? cancellation : Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([work, cancellation]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  });
}

function limitBody(response, maximum) {
  if (Number(response.headers.get('content-length')) > maximum) throw diagnosticError('MCP response exceeded limit', 'invalid-response');
  if (!response.body) return response;
  let count = 0;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > maximum) throw diagnosticError('MCP response exceeded limit', 'invalid-response');
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function restrictedFetch(url, timeout, maximum) {
  return async (input, init = {}) => {
    const destination = input instanceof Request ? input.url : String(input);
    if (destination !== url) throw diagnosticError('Unconfigured MCP endpoint', 'endpoint-policy');
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(init.signal ? [init.signal] : [])]);
    const response = await globalThis.fetch(input, { ...init, signal, redirect: 'error' });
    const safeResponse = sanitizeMcpResponse(response);
    return safeResponse.ok ? limitBody(safeResponse, maximum) : safeResponse;
  };
}

function sanitizeMcpResponse(response) {
  if (response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw diagnosticError('MCP redirect rejected', 'endpoint-policy');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    // Preserve HTTP status for Streamable HTTP protocol control while discarding
    // untrusted bodies before the SDK can include them in an error message.
    return new Response(null, { status: response.status });
  }
  return response;
}

function executable(command, root) {
  if (command === 'node') return process.execPath;
  if (isAbsolute(command)) return command;
  if (command.startsWith('./')) return resolve(root, command);
    throw diagnosticError('MCP command requires an explicit path', 'configuration');
}

function scopedEnvironment(names, env) {
  const result = {};
  for (const name of names ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof env[name] !== 'string') {
      throw diagnosticError('Invalid MCP environment configuration', 'configuration');
    }
    result[name] = env[name];
  }
  return result;
}

function actorContextOption(config) {
  const provided = Object.hasOwn(config, 'actor_context') || config.actor_context !== undefined;
  if (provided
    && (config.transport !== 'stdio' || config.actor_context !== 'mail-agent-v1')) {
    throw diagnosticError('Invalid MCP actor context configuration', 'configuration');
  }
  return config.actor_context === 'mail-agent-v1';
}

function connectionOptions(config, env, root) {
  const actorContext = actorContextOption(config);
  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maximum = config.max_response_bytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(maximum) || maximum <= 0) {
    throw diagnosticError('Invalid MCP limits', 'configuration');
  }
  const common = { transport: config.transport, timeout, maximum, actorContext };
  if (config.transport === 'stdio') return {
    ...common, command: executable(config.command, root), args: [...(config.args ?? [])],
    env: scopedEnvironment(config.env, env), cwd: root,
  };
  if (config.transport !== 'streamable-http') throw new Error('Unsupported MCP transport');
  return httpOptions(config, env, common);
}

function httpOptions(config, env, common) {
  let url;
  try { url = new URL(config.url); }
  catch { throw diagnosticError('Invalid MCP endpoint', 'endpoint-policy'); }
  validateEndpoint(url, config.allow_insecure);
  const token = env[config.token_env];
  if (config.token_env && (typeof token !== 'string' || !token)) throw diagnosticError('Missing MCP credential', 'credential');
  return { ...common, url: url.href, headers: token ? { Authorization: `Bearer ${token}` } : {},
    fetch: restrictedFetch(url.href, common.timeout, common.maximum) };
}

function validateEndpoint(url, allowInsecure) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const secure = url.protocol === 'https:' || (allowInsecure && local && url.protocol === 'http:');
  if (!secure || url.username || url.password || url.hash) throw diagnosticError('Invalid MCP endpoint', 'endpoint-policy');
}

async function sdkClient(options, { signal } = {}) {
  const client = new Client({ name: 'mail-agent', version: '0.1.0' }, { capabilities: {} });
  const transport = options.transport === 'stdio' ? new StdioClientTransport({
    command: options.command, args: options.args, cwd: options.cwd,
    // The SDK otherwise merges these ambient variables into the child environment.
    env: { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, undefined])), ...options.env },
    stderr: 'ignore', maxBufferSize: options.maximum,
  }) : new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: options.headers }, fetch: options.fetch,
    reconnectionOptions: { maxRetries: 0 },
  });
  try {
    await bounded((requestSignal) => client.connect(transport, { signal: requestSignal, timeout: options.timeout }), options.timeout, signal);
    return client;
  } catch (error) {
    await bounded(() => transport.close(), options.timeout).catch(() => {});
    throw diagnosticError('MCP connection failed', classifyDiagnostic(error));
  }
}

function safeFailure(error) {
  const code = classifyDiagnostic(error);
  const message = code === 'cancelled' ? 'MCP request cancelled'
    : code === 'timeout' ? 'MCP request timed out'
      : code === 'invalid-response' ? 'MCP response exceeded limit' : 'MCP request failed';
  return diagnosticError(message, code);
}

async function discover(client, options, connection, validators, signal) {
  const result = new Map();
  const cursors = new Set();
  let cursor;
  do {
    const page = await bounded((signal) => client.listTools(cursor ? { cursor } : {}, {
      signal, timeout: options.timeout,
    }), options.timeout, signal);
    const clean = jsonValue(page, options.maximum);
    for (const definition of clean.tools) {
      const name = `${connection}.${definition.name}`;
      if (result.has(name) || result.size >= MAX_TOOLS) throw new Error('Invalid MCP tool listing');
      validators.set(name, validators.ajv.compile(definition.inputSchema));
      result.set(name, { description: definition.description ?? '', inputSchema: definition.inputSchema });
    }
    cursor = clean.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 32)) throw new Error('Invalid MCP pagination');
    cursors.add(cursor);
  } while (cursor);
  return result;
}

function closeAttempt(attempt, timeout) {
  if (!attempt.client) return Promise.resolve();
  attempt.closing ??= bounded(() => attempt.client.close(), timeout).catch(() => {});
  return attempt.closing;
}

function releaseConnection(connection) {
  const attempt = connection.attempt;
  if (!attempt) return Promise.resolve();
  attempt.abandoned = true;
  connection.attempt = undefined;
  connection.client = undefined;
  return closeAttempt(attempt, connection.options.timeout);
}

async function connect(connection, factory, signal) {
  const { options } = connection;
  const attempt = { abandoned: false };
  connection.attempt = attempt;
  attempt.pending = Promise.resolve().then(() => factory(options, { signal }));
  void attempt.pending.then(client => {
    attempt.client = client;
    if (attempt.abandoned || signal.aborted) return closeAttempt(attempt, options.timeout);
  }).catch(() => {});
  const client = await bounded(() => attempt.pending, options.timeout, signal);
  connection.client = client;
  return client;
}

function validActorCapability(capability) {
  if (!capability || typeof capability !== 'object' || Array.isArray(capability)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(capability))) return false;
  const keys = Reflect.ownKeys(capability);
  const version = Object.getOwnPropertyDescriptor(capability, 'version');
  return keys.length === 1 && keys[0] === 'version' && version?.value === 1;
}

function negotiateActorContext(client, options) {
  if (!options.actorContext) return;
  try {
    if (!validActorCapability(client.getServerCapabilities()?.experimental?.[DOMAIN_CONTEXT_KEY])) throw new Error();
  } catch {
    throw diagnosticError('MCP actor context capability required', 'configuration');
  }
}

function toolRequest(name, args, context, options, clock) {
  const request = { name: name.slice(name.indexOf('.') + 1), arguments: args };
  if (!options.actorContext) return request;
  try {
    request._meta = { [DOMAIN_CONTEXT_KEY]: validateDomainContext(context, {
      now: clock(), tool: name, args, connection: name.split('.', 1)[0],
    }) };
  } catch {
    throw diagnosticError('Invalid MCP actor context', 'access-denied');
  }
  return request;
}

/** Configured transports expose capabilities; runtime policy decides authority. */
export function createMcp(config = {}, { env = process.env, root = process.cwd(), clientFactory = sdkClient, clock = Date.now } = {}) {
  const connections = new Map();
  const validators = new Map();
  validators.ajv = new Ajv({ strict: false, allErrors: false });
  let tools;
  let closed = false;
  let closing;
  const controller = new AbortController();
  for (const [name, settings] of Object.entries(config)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw diagnosticError('Invalid MCP connection name', 'configuration');
    try { connections.set(name, { options: connectionOptions(settings, env, root) }); }
    catch (error) {
      if (error?.diagnosticCode) throw error;
      throw diagnosticError('Invalid MCP connection configuration', 'configuration');
    }
  }

  const discoveryTimeout = Math.max(1, Math.min(300_000, [...connections.values()].reduce((sum, connection) => sum + connection.options.timeout * 2, 0)));

  async function listTools({ signal } = {}) {
    if (closed) throw diagnosticError('MCP registry closed', 'cancelled');
    const listed = await bounded(() => {
      tools ??= loadTools().catch(error => { tools = undefined; throw error; });
      return tools;
    }, discoveryTimeout, signal);
    return new Map(jsonValue([...listed], DEFAULT_MAX_BYTES));
  }

  async function loadTools() {
    const definitions = new Map();
    const candidate = new Map();
    candidate.ajv = validators.ajv;
    try {
      for (const [name, connection] of connections) {
        const client = await connect(connection, clientFactory, controller.signal);
        negotiateActorContext(client, connection.options);
        const listed = await bounded(() => discover(client, connection.options, name, candidate, controller.signal), discoveryTimeout, controller.signal);
        for (const entry of listed) definitions.set(...entry);
      }
      if (closed) throw new Error('MCP registry closed');
      validators.clear();
      for (const entry of candidate) validators.set(...entry);
      return definitions;
    } catch (error) {
      await Promise.allSettled([...connections.values()].map(releaseConnection));
      throw safeFailure(error);
    }
  }

  async function call(name, args, { signal, context } = {}) {
    const connection = connections.get(name.split('.')[0]);
    if (!connection) throw diagnosticError('Unknown MCP tool', 'tool-unavailable');
    const listed = await bounded(() => listTools(), connection.options.timeout, signal);
    if (!listed.has(name)) throw diagnosticError('Unknown MCP tool', 'tool-unavailable');
    if (!validators.get(name)(args)) throw diagnosticError('Invalid MCP tool arguments', 'tool-unavailable');
    const { options, client } = connection;
    let result;
    try {
      result = await bounded((requestSignal) => client.callTool(
        toolRequest(name, args, context, options, clock), undefined,
        { signal: requestSignal, timeout: options.timeout }), options.timeout, signal);
      result = jsonValue(result, options.maximum);
    } catch (error) { throw safeFailure(error); }
    if (result.isError === true) throw diagnosticError('MCP tool failed', 'tool-unavailable');
    return result;
  }

  async function close() {
    if (closed) return closing;
    closed = true;
    controller.abort();
    closing = Promise.allSettled([...connections.values()].map(releaseConnection));
    await closing;
  }

  return { listTools, call, close };
}
