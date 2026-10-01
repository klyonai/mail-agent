import { posix } from 'node:path';

const errorMessage = 'Package documentation links are invalid.';
const maxTextBytes = 1024 * 1024;
const maxTargetLength = 4096;
const scheme = /^[a-z][a-z0-9+.-]*:/i;

function deny() { throw new Error(errorMessage); }

function unsafePath(value) {
  return value.includes('\\') || Array.from(value).some(character =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function packagePath(value) {
  if (typeof value !== 'string' || !value || value.length > maxTargetLength
      || unsafePath(value) || posix.isAbsolute(value) || scheme.test(value)) deny();
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) deny();
  return normalized;
}

function inventorySet(paths) {
  if (!(Array.isArray(paths) || paths instanceof Set) || paths.size > 10000 || paths.length > 10000) deny();
  const inventory = new Set();
  for (const path of paths) {
    const safe = packagePath(path);
    if (inventory.has(safe)) deny();
    inventory.add(safe);
  }
  return inventory;
}

function decodedTarget(raw) {
  if (raw.length > maxTargetLength) deny();
  try {
    const target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    if (target.length > maxTargetLength || unsafePath(target)
        || posix.isAbsolute(target) || scheme.test(target)) deny();
    return target;
  } catch { deny(); }
}

function resolveTarget(raw, source) {
  if (raw.length > maxTargetLength) deny();
  if (/^(?:https?:\/\/|mailto:)/i.test(raw) || raw.startsWith('#')) return undefined;
  const target = decodedTarget(raw);
  const resolved = target ? posix.normalize(posix.join(posix.dirname(source), target)) : source;
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../')) deny();
  return resolved.replace(/\/$/, '');
}

function targetExists(target, inventory) {
  if (inventory.has(target)) return true;
  for (const path of inventory) if (path.startsWith(`${target}/`)) return true;
  return false;
}

function documentLinks(document, inventory) {
  // Intentionally covers inline links/images, angle-wrapped paths and optional quoted titles.
  // Reference links, Markdown syntax validation and external URLs are outside this contract.
  const inline = /!?\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^\s)\r\n]+)(?:\s+["'][^\r\n]*?["'])?\s*\)/g;
  let count = 0;
  for (const match of document.text.matchAll(inline)) {
    const raw = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
    const target = resolveTarget(raw, document.path);
    if (target === undefined) continue;
    if (!targetExists(target, inventory) || ++count > 10000) deny();
  }
  return count;
}

export function validatePackageLinks(documents, inventoryPaths) {
  if (!Array.isArray(documents) || documents.length > 256) deny();
  const inventory = inventorySet(inventoryPaths);
  const seen = new Set();
  let localLinks = 0;
  let textBytes = 0;
  for (const document of documents) {
    const path = packagePath(document?.path);
    if (seen.has(path) || !inventory.has(path) || typeof document.text !== 'string'
        || document.text.length > maxTextBytes) deny();
    seen.add(path);
    const size = Buffer.byteLength(document.text, 'utf8');
    textBytes += size;
    if (size > maxTextBytes || textBytes > 8 * maxTextBytes) deny();
    localLinks += documentLinks(document, inventory);
    if (localLinks > 10000) deny();
  }
  return { documents: documents.length, localLinks };
}
