import { resolve } from 'node:path';
import { withRecoveryStore } from './recovery-state.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const kinds = new Set(['runs', 'actions']);
const statuses = new Set(['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending', 'completed', 'failed', 'ignored', 'uncertain']);
const actionStates = new Set(['pending', 'executing', 'completed', 'failed', 'uncertain']);
const effects = new Set(['read', 'write']);
const countNames = ['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending', 'completed', 'failed', 'ignored', 'uncertain'];

function fail() { throw new Error('Recovery inspection requires a valid, private held state.'); }

function validateRequest({ stateRoot, identity, limit, kind, after, clock }) {
  if (typeof stateRoot !== 'string' || !stateRoot || stateRoot.length > 4096 || stateRoot.includes('\0')
    || typeof identity !== 'string' || !digestPattern.test(identity) || !Number.isInteger(limit) || limit < 1 || limit > 100
    || !kinds.has(kind) || typeof clock !== 'function') fail();
  return { stateRoot: resolve(stateRoot), identity, limit, kind, after: decodeCursor(after, kind), clock };
}

function decodeCursor(value, kind) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseCursor(value);
  if (!exactKeys(parsed, ['kind', 'position']) || parsed.kind !== kind || !validPosition(parsed.position, kind)) fail();
  return parsed.position;
}

function parseCursor(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) fail();
    return JSON.parse(decoded.toString('utf8'));
  } catch { fail(); }
}

function validPosition(position, kind) {
  if (kind === 'actions') return typeof position === 'string' && safeId(position);
  return exactKeys(position, ['sequence', 'id']) && Number.isSafeInteger(position.sequence) && position.sequence >= 0 && safeId(position.id);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_.:-]+$/.test(value); }

function counts(summary) {
  if (!summary || typeof summary !== 'object' || !summary.counts || typeof summary.counts !== 'object') fail();
  const output = {};
  for (const name of countNames) {
    const value = summary.counts[name] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) fail();
    output[name] = value;
  }
  return output;
}

function safeFingerprint(value) { if (typeof value !== 'string' || !digestPattern.test(value)) fail(); return value; }

function safeRun(item) {
  if (!validRun(item)) fail();
  return { id: item.id, messageKey: item.messageKey, conversationKey: item.conversationKey, status: item.status,
    sequence: item.sequence, createdAt: item.createdAt, contentExpired: item.contentExpired, approved: item.approved,
    activeOperation: item.activeOperation, fingerprint: safeFingerprint(item.fingerprint), budget: safeBudget(item.budget) };
}

function validRun(item) {
  return item && validRunIdentity(item) && validRunState(item) && validBudget(item.budget);
}

function validRunIdentity(item) {
  return safeId(item.id) && digestPattern.test(item.messageKey) && digestPattern.test(item.conversationKey);
}

function validRunState(item) {
  return statuses.has(item.status) && Number.isSafeInteger(item.sequence) && item.sequence >= 0
    && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0 && typeof item.contentExpired === 'boolean'
    && typeof item.approved === 'boolean' && typeof item.activeOperation === 'boolean';
}

function validBudget(value) {
  if (value === null || value === undefined) return true;
  return typeof value === 'object' && !Array.isArray(value)
    && ['modelCalls', 'toolCalls', 'activeMs'].every(key => value[key] === null || value[key] === undefined
      || Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function safeBudget(value) {
  if (!value || !['modelCalls', 'toolCalls', 'activeMs'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  return { modelCalls: value.modelCalls, toolCalls: value.toolCalls, activeMs: value.activeMs };
}

function safeAction(item) {
  if (!item || !safeId(item.key) || !safeId(item.runId) || !actionStates.has(item.state) || !effects.has(item.effect)
    || typeof item.tool !== 'string' || item.tool.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(item.tool)) fail();
  return { key: item.key, runId: item.runId, state: item.state, effect: item.effect, tool: item.tool, fingerprint: safeFingerprint(item.fingerprint) };
}

function nextCursor(value, kind) {
  if (value === null || value === undefined) return null;
  if (kind === 'runs') {
    if (!exactKeys(value, ['sequence', 'id']) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !safeId(value.id)) fail();
  } else if (typeof value !== 'string' || !safeId(value)) fail();
  return Buffer.from(JSON.stringify({ kind, position: value })).toString('base64url');
}

/** Inspect recovery metadata without executing work or exposing stored content. */
export async function inspectRecovery(request, { openStoreImpl } = {}) {
  const value = validateRequest({ limit: 100, kind: 'runs', clock: request?.clock ?? Date.now, ...request });
  return withRecoveryStore({ stateRoot: value.stateRoot, identity: value.identity, clock: value.clock },
    (store, descriptor) => inspectStore(store, value, descriptor), { openStoreImpl });
}

function inspectStore(store, value, descriptor) {
  const { recovery } = descriptor;
  const page = readRecoveryPage(store, value);
  if (!Array.isArray(page?.items) || page.items.length > value.limit) fail();
  const items = page.items.map(value.kind === 'runs' ? safeRun : safeAction);
  return { kind: value.kind, recovery, binding: descriptor.binding, cursorDigest: descriptor.cursorDigest,
    stateSchema: descriptor.stateSchema, counts: counts(store.summary()), items, nextCursor: nextCursor(page.nextCursor, value.kind) };
}

function readRecoveryPage(store, value) {
  if (value.kind === 'runs') return store.recoveryPage({ limit: value.limit, after: value.after });
  return store.actionPage({ limit: value.limit, after: value.after });
}
