import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { TextDecoder } from 'node:util';

const message = 'Release files are invalid.';
const textLimits = new Map([
  ['candidate.json', 1024 ** 2], ['pack.json', 1024 ** 2], ['image.json', 1024 ** 2], ['SHA256SUMS', 2048],
]);
const fixedNames = [...textLimits.keys(), 'image.tar'];
const packageName = /^mail-agent-\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?\.tgz$/;
const attributes = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
function deny() { throw new Error(message); }
function aborted(signal) { if (signal?.aborted) deny(); }
function unchanged(first, second) {
  if (attributes.some(key => first[key] !== second[key])) deny();
}
function privateOwner(info) {
  if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o077n) !== 0n) deny();
}
function inventory(names) {
  if (!Array.isArray(names) || names.length !== 6 || new Set(names).size !== 6) deny();
  const copy = [...names];
  if (!fixedNames.every(name => copy.includes(name)) || copy.filter(name => typeof name === 'string' && packageName.test(name)).length !== 1) deny();
  return copy;
}
function limitFor(name) {
  if (textLimits.has(name)) return textLimits.get(name);
  return name === 'image.tar' ? 1024 ** 3 : 32 * 1024 ** 2;
}
function validFile(info, name, limit = limitFor(name)) {
  privateOwner(info);
  if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(limit)) deny();
}
async function exactEntries(directory, names, signal) {
  const handle = await opendir(directory, { bufferSize: 1 });
  const seen = new Set();
  let count = 0;
  try {
    for (;;) {
      aborted(signal);
      const entry = await handle.read();
      if (!entry) break;
      if (++count > names.length || !names.includes(entry.name) || seen.has(entry.name)) deny();
      seen.add(entry.name);
    }
    if (count !== names.length) deny();
  } finally { await handle.close(); }
}
async function snapshot(directory, names, signal) {
  await exactEntries(directory, names, signal);
  const files = new Map();
  for (const name of names) {
    const info = await lstat(join(directory, name), { bigint: true });
    validFile(info, name);
    files.set(name, info);
  }
  return files;
}
function hashers(name) {
  const hashes = new Map([['sha256', createHash('sha256')]]);
  if (packageName.test(name)) {
    hashes.set('sha1', createHash('sha1')); hashes.set('sha512', createHash('sha512'));
  }
  return hashes;
}
function finishFile(hashes, text, size) {
  const result = { hash: hashes.get('sha256').digest('hex'), size };
  if (text) result.content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(text));
  if (hashes.has('sha1')) result.packageDigests = { sha1: hashes.get('sha1').digest('hex'), sha512: hashes.get('sha512').digest('base64') };
  return result;
}
async function streamFile(handle, name, info, signal, settings = {}) {
  const hashes = hashers(name);
  const limit = settings.limit ?? limitFor(name);
  const text = (settings.text ?? textLimits.has(name)) ? [] : undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  for (;;) {
    aborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > limit || BigInt(size) > info.size) deny();
    const bytes = buffer.subarray(0, bytesRead);
    for (const hash of hashes.values()) hash.update(bytes);
    if (text) text.push(Buffer.from(bytes));
  }
  if (BigInt(size) !== info.size) deny();
  return finishFile(hashes, text, size);
}
async function readOne(directory, name, info, signal, settings) {
  aborted(signal);
  const filename = join(directory, name);
  unchanged(info, await lstat(filename, { bigint: true }));
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    unchanged(info, await handle.stat({ bigint: true }));
    unchanged(info, await lstat(filename, { bigint: true }));
    const result = await streamFile(handle, name, info, signal, settings);
    unchanged(info, await handle.stat({ bigint: true }));
    unchanged(info, await lstat(filename, { bigint: true }));
    return result;
  } finally { await handle.close(); }
}
async function verifySnapshot(directory, names, files, signal) {
  await exactEntries(directory, names, signal);
  for (const name of names) unchanged(files.get(name), await lstat(join(directory, name), { bigint: true }));
}
async function readDirectory(directory, names, signal) {
  if (typeof directory !== 'string' || !directory) deny();
  aborted(signal);
  const info = await lstat(directory, { bigint: true });
  privateOwner(info);
  if (!info.isDirectory()) deny();
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    unchanged(info, await handle.stat({ bigint: true }));
    unchanged(info, await lstat(directory, { bigint: true }));
    aborted(signal);
    const files = await snapshot(directory, names, signal);
    const result = { hashes: {}, sizes: {}, contents: {}, packageDigests: {} };
    for (const name of names) {
      const file = await readOne(directory, name, files.get(name), signal);
      result.hashes[name] = file.hash; result.sizes[name] = file.size;
      if (textLimits.has(name)) result.contents[name] = file.content;
      if (file.packageDigests) result.packageDigests = file.packageDigests;
    }
    aborted(signal);
    await verifySnapshot(directory, names, files, signal);
    unchanged(info, await handle.stat({ bigint: true }));
    unchanged(info, await lstat(directory, { bigint: true }));
    return result;
  } finally { await handle.close(); }
}

export async function readReleaseFiles(directory, names, options = {}) {
  try { return await readDirectory(directory, inventory(names), options.signal); }
  catch { throw new Error(message); }
}


export async function readReleaseReview(filename, options = {}) {
  try {
    const { signal } = options;
    if (typeof filename !== 'string' || !filename) deny();
    aborted(signal);
    const info = await lstat(filename, { bigint: true });
    const name = basename(filename), limit = 64 * 1024;
    validFile(info, name, limit);
    const result = await readOne(dirname(filename), name, info, signal, { limit, text: true });
    aborted(signal);
    return result.content;
  } catch { throw new Error(message); }
}
