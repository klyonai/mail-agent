import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

const DEFAULT_MAX_BYTES = 1_048_576;
const MAX_PATH_LENGTH = 4096;

export class RecoveryInputError extends Error {
  constructor(code) {
    const messages = {
      'RECOVERY_INPUT_INVALID': 'Recovery plan input is invalid.',
      'RECOVERY_INPUT_UNSAFE': 'Recovery plan file is unsafe or unavailable.',
      'RECOVERY_INPUT_TOO_LARGE': 'Recovery plan file exceeds the size limit.',
      'RECOVERY_INPUT_CHANGED': 'Recovery plan file changed while being read.',
      'RECOVERY_INPUT_ABORTED': 'Recovery plan read was cancelled.',
      'RECOVERY_INPUT_ENCODING': 'Recovery plan file is not valid UTF-8.',
      'RECOVERY_INPUT_JSON': 'Recovery plan file is not valid JSON.',
      'RECOVERY_INPUT_READ': 'Recovery plan file could not be read.'
    };
    super(messages[code] ?? messages.RECOVERY_INPUT_READ);
    this.name = 'RecoveryInputError';
    this.code = Object.hasOwn(messages, code) ? code : 'RECOVERY_INPUT_READ';
  }
}

function fail(code) { throw new RecoveryInputError(code); }

function validFilename(filename) {
  return typeof filename === 'string' && filename.length > 0 && filename.length <= MAX_PATH_LENGTH && !filename.includes('\0');
}

function validSignal(signal) {
  return !signal || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function');
}

function validateArguments(filename, options) {
  if (!validFilename(filename) || !options || typeof options !== 'object' || Array.isArray(options)) fail('RECOVERY_INPUT_INVALID');
  const { signal, maxBytes = DEFAULT_MAX_BYTES } = options;
  const validMax = Number.isSafeInteger(maxBytes) && maxBytes >= 1 && maxBytes <= DEFAULT_MAX_BYTES;
  if (!validMax || !validSignal(signal)) fail('RECOVERY_INPUT_INVALID');
  return { signal, maxBytes };
}

function abort(signal) { if (signal?.aborted) fail('RECOVERY_INPUT_ABORTED'); }

function safeFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0
    && typeof process.getuid === 'function' && stat.uid === process.getuid();
}

function sameInode(left, right) { return left.dev === right.dev && left.ino === right.ino; }

function unchanged(left, right) {
  return sameInode(left, right) && left.size === right.size && left.mode === right.mode && left.uid === right.uid
    && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function initialStat(filename, lstatImpl, maxBytes) {
  const stat = await lstatImpl(filename);
  if (!safeFile(stat)) fail('RECOVERY_INPUT_UNSAFE');
  if (stat.size > maxBytes) fail('RECOVERY_INPUT_TOO_LARGE');
  return stat;
}

function validateOpenedFile(before, opened, maxBytes) {
  if (!safeFile(opened) || !sameInode(before, opened)) fail('RECOVERY_INPUT_UNSAFE');
  if (opened.size > maxBytes) fail('RECOVERY_INPUT_TOO_LARGE');
  if (!unchanged(before, opened)) fail('RECOVERY_INPUT_CHANGED');
}

function validateReadFile(opened, after, pathStat, bytesRead, maxBytes) {
  if (!safeFile(after) || !safeFile(pathStat) || !sameInode(opened, pathStat)) fail('RECOVERY_INPUT_UNSAFE');
  if (after.size > maxBytes || bytesRead > maxBytes) fail('RECOVERY_INPUT_TOO_LARGE');
  if (!unchanged(opened, after) || !unchanged(after, pathStat) || bytesRead !== opened.size) fail('RECOVERY_INPUT_CHANGED');
}

async function readBounded(handle, maxBytes, signal) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    abort(signal);
    const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
    if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0) fail('RECOVERY_INPUT_READ');
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
    if (bytesRead > maxBytes) fail('RECOVERY_INPUT_TOO_LARGE');
  }
  return { buffer, bytesRead };
}

function decodeJson(buffer, length) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
  catch { fail('RECOVERY_INPUT_ENCODING'); }
  try { return JSON.parse(text); }
  catch { fail('RECOVERY_INPUT_JSON'); }
}

function safeReadError(error, signal) {
  if (error instanceof RecoveryInputError) return error;
  return new RecoveryInputError(signal?.aborted ? 'RECOVERY_INPUT_ABORTED' : 'RECOVERY_INPUT_UNSAFE');
}

/** Read a bounded local recovery plan without exposing filesystem or parser errors. */
export async function readRecoveryPlanFile(filename, options = {}, { lstatImpl = lstat, openImpl = open } = {}) {
  const { signal, maxBytes } = validateArguments(filename, options);
  if (typeof lstatImpl !== 'function' || typeof openImpl !== 'function') fail('RECOVERY_INPUT_INVALID');
  abort(signal);
  let handle;
  try {
    const before = await initialStat(filename, lstatImpl, maxBytes);
    abort(signal);
    handle = await openImpl(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    validateOpenedFile(before, opened, maxBytes);
    const { buffer, bytesRead } = await readBounded(handle, maxBytes, signal);
    abort(signal);
    const after = await handle.stat();
    const pathStat = await lstatImpl(filename);
    validateReadFile(opened, after, pathStat, bytesRead, maxBytes);
    return decodeJson(buffer, bytesRead);
  } catch (error) {
    throw safeReadError(error, signal);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* File descriptors are always closed before returning. */ }
    }
  }
}
