import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, isAbsolute } from 'node:path';
import { maintenanceLimits } from './maintenance-limits.mjs';

export const MAINTENANCE_DEFAULTS = Object.freeze(maintenanceLimits());
const digestPattern = /^[a-f0-9]{64}$/;
const workerErrors = new Set(['STATE_UNSAFE', 'INVALID_STATE', 'IDENTITY_MISMATCH', 'UNSUPPORTED_SCHEMA', 'TOO_LARGE', 'FAILED']);

export class MaintenanceError extends Error {
  constructor(code) { super('State maintenance could not complete.'); this.name = 'MaintenanceError'; this.code = code; }
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function validPath(value) { return typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && isAbsolute(value); }

function safeLimits(value) {
  try { return maintenanceLimits(value); } catch { throw new MaintenanceError('MAINTENANCE_INVALID_INPUT'); }
}

function validateRequest(request) {
  const keys = requestKeys(request?.operation);
  if (!exactKeys(request, keys) || !['snapshot', 'validate', 'restore'].includes(request.operation)) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  if (!validPath(request.source) || typeof request.identity !== 'string' || !digestPattern.test(request.identity)) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  if (request.operation === 'snapshot' && !validPath(request.destination)) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  if (request.operation === 'restore') validateRestoreFields(request);
  safeLimits({ maxBytes: request.maxBytes });
}

function requestKeys(operation) {
  const keys = ['operation', 'source', 'identity', 'maxBytes'];
  if (operation === 'snapshot') keys.push('destination');
  if (operation === 'restore') keys.push('hold', 'actorDigest', 'reasonDigest');
  return keys;
}

function validateRestoreFields(request) {
  if (basename(request.source) !== 'agent.sqlite') throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  const hold = request.hold;
  if (!exactKeys(hold, ['snapshotId', 'snapshotCreatedAt', 'restoredAt'])) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  if (typeof hold.snapshotId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(hold.snapshotId)) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  for (const value of [hold.snapshotCreatedAt, hold.restoredAt]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
  }
  if (![request.actorDigest, request.reasonDigest].every(value => typeof value === 'string' && digestPattern.test(value))) throw new MaintenanceError('MAINTENANCE_INVALID_INPUT');
}

function validWorkerValue(value, identity) {
  return exactKeys(value, ['stateSchema', 'mailboxIdentity', 'sha256'])
    && Number.isInteger(value.stateSchema) && value.stateSchema >= 0 && value.stateSchema <= 5
    && value.mailboxIdentity === identity && typeof value.sha256 === 'string' && digestPattern.test(value.sha256);
}

function workerResponse(message, identity) {
  if (exactKeys(message, ['ok', 'code']) && message.ok === false && workerErrors.has(message.code)) {
    return { error: new MaintenanceError(`MAINTENANCE_${message.code}`) };
  }
  if (!exactKeys(message, ['ok', 'value']) || message.ok !== true) throw new MaintenanceError('MAINTENANCE_FAILED');
  const value = message.value;
  if (!validWorkerValue(value, identity)) throw new MaintenanceError('MAINTENANCE_FAILED');
  return { value };
}

/** Only fixed local SQLite work is permitted. Resolve after the child has terminated, never on its IPC message. */
export async function runMaintenanceWorker(request, {
  signal, timeoutMs = MAINTENANCE_DEFAULTS.timeoutMs, spawnImpl = spawn, setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  validateRequest(request);
  safeLimits({ maxBytes: request.maxBytes, timeoutMs });
  if (signal?.aborted) throw new MaintenanceError('MAINTENANCE_ABORTED');
  let child;
  try {
    child = spawnImpl(process.execPath, [fileURLToPath(new URL('./backup-worker.mjs', import.meta.url))],
      { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  } catch { throw new MaintenanceError('MAINTENANCE_FAILED'); }
  return supervise(child, request, { signal, timeoutMs, setTimer, clearTimer });
}

function supervise(child, request, { signal, timeoutMs, setTimer, clearTimer }) {
  return new Promise((resolve, reject) => {
    let response, failure, timer;
    const terminate = code => {
      if (failure) return;
      failure = new MaintenanceError(code);
      try { child.kill('SIGKILL'); } catch { /* The close event still owns completion and lease release. */ }
    };
    const onMessage = message => {
      if (failure) return;
      try {
        if (response) throw new MaintenanceError('MAINTENANCE_FAILED');
        response = workerResponse(message, request.identity);
      } catch { terminate('MAINTENANCE_FAILED'); }
    };
    const onError = () => terminate('MAINTENANCE_FAILED');
    const onAbort = () => terminate('MAINTENANCE_ABORTED');
    const onClose = code => {
      clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      child.off('message', onMessage); child.off('error', onError); child.off('close', onClose);
      finishWorker({ code, response, failure }, resolve, reject);
    };
    child.on('message', onMessage); child.on('error', onError); child.on('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimer(() => terminate('MAINTENANCE_TIMEOUT'), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    try { child.send(request, error => { if (error) onError(); }); }
    catch { onError(); }
  });
}

function finishWorker({ code, response, failure }, resolve, reject) {
  if (failure) reject(failure);
  else if (response?.error) reject(response.error);
  else if (code === 0 && response?.value) resolve(response.value);
  else reject(new MaintenanceError('MAINTENANCE_FAILED'));
}
