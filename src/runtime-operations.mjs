import { classifyDiagnostic } from './diagnostics-errors.mjs';

const BOUNDARIES = ['configuration', 'mailbox', 'model', 'mcp', 'send','artifacts'];

export function encodeCursor(value) {
  return value ? Buffer.from(JSON.stringify(value)).toString('base64url') : null;
}

export function pageOptions(options = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Page limit must be an integer from 1 to 100.');
  let after = options.after;
  if (typeof after === 'string') {
    if (after.length > 1024) throw new Error('Invalid metadata cursor.');
    try { after = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
    catch { throw new Error('Invalid metadata cursor.'); }
  }
  if (after != null && !validCursor(after)) throw new Error('Invalid metadata cursor.');
  return { limit, after: after ?? undefined, status: options.status };
}

function validCursor(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2 && Number.isSafeInteger(value.sequence)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256;
}

function timestamp(value) {
  const number = Number(value);
  return value && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function baseline(cursor) {
  if (!cursor) return 'not-started';
  try { return JSON.parse(cursor).initialComplete === true ? 'complete' : 'in-progress'; }
  catch { return 'invalid'; }
}

export function createOperations(store, { clock, pollSeconds }) {
  function failures() {
    const result = {};
    for (const boundary of BOUNDARIES) {
      const value = store.getMeta(`failure.${boundary}`);
      if (value) result[boundary] = JSON.parse(value);
    }
    return result;
  }
  function failed(boundary, error) {
    if (!BOUNDARIES.includes(boundary)) throw new Error('Invalid failure boundary.');
    const failure = { code: classifyDiagnostic(error), at: clock(), resolvedAt: null };
    store.setMeta(`failure.${boundary}`, JSON.stringify(failure));
    return failure;
  }
  function succeeded(boundary) {
    const value = store.getMeta(`failure.${boundary}`);
    if (!value) return;
    const failure = JSON.parse(value);
    if (failure.resolvedAt === null) store.setMeta(`failure.${boundary}`, JSON.stringify({ ...failure, resolvedAt: clock() }));
  }
  function sync() {
    const all = failures();
    const lastFailure = [all.configuration, all.mailbox].filter(value => value?.resolvedAt === null)
      .sort((a,b) => b.at - a.at)[0] ?? null;
    return { baseline: baseline(store.getMeta('cursor')), lastAttemptAt: timestamp(store.getMeta('sync.attempt')),
      lastSuccessAt: timestamp(store.getMeta('sync.success')), retryNotBefore: timestamp(store.getMeta('sync.retry')),
      lastFailure };
  }
  function attempt() { store.setMeta('sync.attempt', String(clock())); }
  function polled() {
    store.setMeta('sync.success', String(clock())); store.setMeta('sync.retry', '');
    store.setMeta('last_poll_error', ''); succeeded('mailbox');
  }
  function defer(error) {
    if (Number.isSafeInteger(error?.retryNotBefore) && error.retryNotBefore > clock()) {
      const prior = timestamp(store.getMeta('sync.retry')) ?? 0;
      store.setMeta('sync.retry', String(Math.max(prior, error.retryNotBefore)));
    }
  }
  function health(live, stopped) {
    const state = sync();
    const summary = store.summary();
    const reason = healthReason(state, {live, stopped, now:clock(), pollSeconds});
    return { live: live && !stopped, ready: reason === 'ready', reason, sync: state,
      attention: { approvals: summary.approvals, uncertainty: summary.uncertainty } };
  }
  return {failed, succeeded, failures, sync, attempt, polled, defer, health};
}

function healthReason(state, {live, stopped, now, pollSeconds}) {
  if (stopped) return 'shutting-down';
  if (!live) return 'not-running';
  if (state.baseline === 'invalid') return 'invalid-cursor';
  if (state.retryNotBefore > now) return 'provider-backoff';
  if (state.lastFailure) return 'intake-failed';
  if (state.baseline !== 'complete') return 'baseline-pending';
  if (state.lastSuccessAt === null || now - state.lastSuccessAt > Math.max(60000, pollSeconds * 3000)) return 'intake-stale';
  return 'ready';
}
