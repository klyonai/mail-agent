import { createConnection, createServer } from 'node:net';
import { chmod, lstat, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateRecordsReceipt } from './records-reconciliation.mjs';

const REQUEST_LIMIT = 65_536;
const RESPONSE_LIMIT = 1_048_576;
const DEADLINE_MS = 3_000;
const METHODS = new Set(['status', 'health', 'approvals', 'approve', 'resolve', 'liveCheck', 'reconcileRecords', 'recordsIntent']);
const SAFE_ERRORS = new Set(['Approval denied', 'Approver is not authorized', 'Approval is unavailable',
  'Approval expired', 'Approval policy changed', 'Unauthorized operator', 'Resolution denied',
  'An operator identity and reason are required.', 'Pending approval not found.',
  'Approval authority expired or is not permitted.', 'Approval policy changed.',
  'Sender is no longer permitted.', 'Recipient is not permitted.', 'Uncertain send not found.',
  'Invalid send resolution.', 'Reply content has expired; request a new run.', 'Records reconciliation denied.']);

function socketPath(root) {
  const path = join(resolve(root), 'control.sock');
  if (Buffer.byteLength(path) > 100) throw new Error('Control socket requires a shorter state_root path');
  return path;
}

function owned(info) {
  return !process.getuid || info.uid === process.getuid();
}

async function privateRoot(root) {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || (info.mode & 0o077)) {
    throw new Error('Control requires a private state directory');
  }
}

async function assertOwner(root) {
  let verified = false;
  try {
    const path = join(root, 'owner.lock');
    const info = await lstat(path);
    if (info.isFile() && !info.isSymbolicLink() && owned(info) && !(info.mode & 0o077) && info.size <= 4096) {
      const owner = JSON.parse(await readFile(path, 'utf8'));
      verified = owner.pid === process.pid;
    }
  } catch { /* Ownership is deliberately fail closed. */ }
  if (!verified) throw new Error('State ownership is required for the control socket');
}

function socketAvailable(path) {
  return new Promise((resolveProbe, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Control socket check timed out')); }, DEADLINE_MS);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolveProbe(false); });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolveProbe(true);
      else reject(new Error('Control socket unavailable'));
    });
  });
}

async function removeSameSocket(path, expected) {
  try {
    const current = await lstat(path);
    if (current.isSocket() && current.ino === expected.ino && current.dev === expected.dev) await unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function prepareSocket(root, path) {
  let existing;
  try { existing = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!existing.isSocket() || !owned(existing)) throw new Error('Unsafe control socket');
  if (!await socketAvailable(path)) throw new Error('Control socket already active');
  await assertOwner(root);
  await removeSameSocket(path, existing);
}

function fields(value, required) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === required.length
    && required.every((name) => Object.hasOwn(value, name));
}

function validActor(input) {
  return typeof input.actor === 'string' && input.actor.length <= 254
    && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.actor)
    && typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 4096;
}

function validMutation(method, params) {
  if (method === 'approve') return fields(params, ['id', 'actor', 'reason']) && validActor(params)
    && typeof params.id === 'string' && params.id.length > 0 && params.id.length <= 256;
  return fields(params, ['runId', 'outcome', 'actor', 'reason']) && validActor(params)
    && typeof params.runId === 'string' && params.runId.length > 0 && params.runId.length <= 256
    && ['sent', 'not-sent'].includes(params.outcome);
}

function validRequest(request) {
  if (!fields(request, ['method', 'params']) || !METHODS.has(request.method)) return false;
  if (request.method === 'reconcileRecords') return validRecordsMutation(request.params);
  if (request.method === 'recordsIntent') return validRecordsOperator(request.params, ['actionKey', 'actor', 'reason']);
  if (['approve', 'resolve'].includes(request.method)) return validMutation(request.method, request.params);
  if (['status', 'approvals'].includes(request.method)) return validPageParams(request.params, request.method === 'status');
  return fields(request.params, []);
}

function validRecordsMutation(params) {
  if (!validRecordsOperator(params, ['actionKey', 'receipt', 'actor', 'reason'])) return false;
  try {
    const receipt = validateRecordsReceipt(params.receipt);
    return Buffer.byteLength(JSON.stringify(receipt)) <= 8192;
  } catch { return false; }
}

function validRecordsOperator(params, keys) {
  return fields(params, keys) && validActor(params) && params.reason.length <= 2048
    && typeof params.actionKey === 'string' && /^[a-f0-9]{64}$/.test(params.actionKey);
}

function validPageParams(params, filter) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const keys = ['limit', 'after', ...(filter ? ['status'] : [])];
  if (Object.keys(params).some(key => !keys.includes(key))) return false;
  if (!validPageLimit(params.limit) || !validPageCursor(params.after)) return false;
  return params.status === undefined || ['queued','running','awaiting_approval','ready_to_send','sending','completed','failed','ignored','uncertain'].includes(params.status);
}

function validPageLimit(value) {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= 100);
}

function validPageCursor(value) {
  return value === undefined || (typeof value === 'string' && value.length <= 1024);
}

function encodedResponse(response) {
  try {
    const text = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(text) <= RESPONSE_LIMIT) return text;
  } catch { /* Handler results must be JSON values. */ }
  return `${JSON.stringify({ ok: false, error: 'Control response exceeded limit' })}\n`;
}

async function dispatch(request, handlers) {
  if (!validRequest(request)) return { ok: false, error: 'Invalid control request' };
  if (typeof handlers[request.method] !== 'function') return { ok: false, error: 'Control method unavailable' };
  try {
    return { ok: true, result: await handlers[request.method](request.params) };
  } catch (error) {
    return { ok: false, error: SAFE_ERRORS.has(error.message) ? error.message : 'Control operation failed' };
  }
}

function readLine(socket, maximum, callback) {
  let bytes = Buffer.alloc(0);
  let consumed = false;
  socket.on('data', (chunk) => {
    if (consumed) return;
    if (bytes.length + chunk.length > maximum) { consumed = true; callback(undefined); return; }
    bytes = Buffer.concat([bytes, chunk]);
    const newline = bytes.indexOf(10);
    if (newline < 0) return;
    consumed = true;
    if (newline !== bytes.length - 1) { callback(undefined); return; }
    let value;
    try { value = JSON.parse(bytes.subarray(0, newline).toString('utf8')); }
    catch { /* Malformed JSON receives a fixed error. */ }
    callback(value);
  });
}

function serveConnection(socket, handlers, connections) {
  connections.add(socket);
  const timer = setTimeout(() => socket.destroy(), DEADLINE_MS);
  socket.on('error', () => {});
  socket.once('close', () => { clearTimeout(timer); connections.delete(socket); });
  readLine(socket, REQUEST_LIMIT, (request) => {
    void dispatch(request, handlers).then((response) => {
      if (!socket.destroyed) socket.end(encodedResponse(response));
    });
  });
}

async function bind(server, path) {
  let failure;
  await new Promise((resolveBind) => {
    server.once('error', (error) => { failure = error.code; resolveBind(); });
    server.listen(path, resolveBind);
  });
  if (failure) {
    const error = new Error('Control socket unavailable');
    error.code = failure;
    throw error;
  }
}

/** Local operator access, protected by the private volume and socket permissions. */
export async function listenControl(stateRoot, handlers) {
  const path = socketPath(stateRoot);
  const root = resolve(stateRoot);
  await privateRoot(root);
  await assertOwner(root);
  await prepareSocket(root, path);
  const connections = new Set();
  const server = createServer((socket) => serveConnection(socket, handlers, connections));
  await bind(server, path);
  await chmod(path, 0o600);
  const identity = await lstat(path);
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
      await removeSameSocket(path, identity);
    },
  };
}

async function verifyClient(root, path) {
  await privateRoot(root);
  const info = await lstat(path);
  if (!info.isSocket() || !owned(info) || (info.mode & 0o077)) throw new Error('Unsafe control socket');
}

function requestControl(path, method, params) {
  const request = { method, params };
  if (!validRequest(request)) return Promise.reject(new Error('Invalid control request'));
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(new Error('Control request timed out')), DEADLINE_MS);
    let complete = false;
    function finish(error, value) {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolveRequest(value);
    }
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once('error', error => {
      const safe = new Error('Control socket unavailable');
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) safe.code = error.code;
      finish(safe);
    });
    socket.once('end', () => finish(new Error('Control response unavailable')));
    readLine(socket, RESPONSE_LIMIT, (response) => {
      if (response?.ok === true) finish(undefined, response.result);
      else finish(new Error(response?.error === 'Control response exceeded limit' ? response.error : safeRemoteError(response)));
    });
  });
}

function safeRemoteError(response) {
  const allowed = new Set([...SAFE_ERRORS, 'Invalid control request', 'Control method unavailable', 'Control operation failed']);
  return allowed.has(response?.error) ? response.error : 'Control operation failed';
}

export async function connectControl(stateRoot) {
  const path = socketPath(stateRoot);
  const root = resolve(stateRoot);
  await verifyClient(root, path);
  const proxy = {};
  for (const method of METHODS) proxy[method] = async (params = {}) => {
    await verifyClient(root, path);
    return requestControl(path, method, params);
  };
  proxy.stop = async () => {};
  return proxy;
}

/** Observes the private daemon only; never opens databases, creates state or acquires ownership. */
export async function readHealth(stateRoot) {
  try {
    const proxy = await connectControl(stateRoot);
    return await proxy.health();
  } catch (error) {
    const absent = ['ENOENT', 'ECONNREFUSED'].includes(error.code);
    return { live: false, ready: false, reason: absent ? 'not-running' : 'control-unavailable' };
  }
}
