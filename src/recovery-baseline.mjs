const MAX_CURSOR_BYTES = 65_536;
const MAX_PAGE_MESSAGES = 100;

export class RecoveryBaselineError extends Error {
  constructor(code = 'RECOVERY_BASELINE_FAILED') {
    const messages = {
      RECOVERY_BASELINE_INVALID: 'Recovery baseline request is invalid.',
      RECOVERY_BASELINE_ABORTED: 'Mailbox baseline was cancelled.',
      RECOVERY_BASELINE_TIMEOUT: 'Mailbox baseline exceeded its time limit.',
      RECOVERY_BASELINE_FAILED: 'Mailbox baseline could not be completed safely.'
    };
    super(messages[code] ?? messages.RECOVERY_BASELINE_FAILED);
    this.name = 'RecoveryBaselineError';
    this.code = Object.hasOwn(messages, code) ? code : 'RECOVERY_BASELINE_FAILED';
  }
}

function fail(code) { throw new RecoveryBaselineError(code); }

function validSignal(signal) {
  return !signal || (typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function');
}

function validGraphInput(graph, signal, clock) {
  return graph && typeof graph.poll === 'function' && validSignal(signal) && typeof clock === 'function';
}

function validBounds(timeoutMs, maxPages, maxMessages) {
  return Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
    && Number.isSafeInteger(maxPages) && maxPages >= 1 && maxPages <= 100
    && Number.isSafeInteger(maxMessages) && maxMessages >= 1 && maxMessages <= 10_000;
}

function validateOptions({ graph, signal, clock, timeoutMs, maxPages, maxMessages }) {
  if (!validGraphInput(graph, signal, clock) || !validBounds(timeoutMs, maxPages, maxMessages)) fail('RECOVERY_BASELINE_INVALID');
}

function composedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = controller.signal;
  return { deadline, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, timer };
}

function abortStatus(signal, deadline) {
  if (signal?.aborted) return 'RECOVERY_BASELINE_ABORTED';
  if (deadline.aborted) return 'RECOVERY_BASELINE_TIMEOUT';
  return null;
}

function checkActive(signal, deadline) {
  const code = abortStatus(signal, deadline);
  if (code) fail(code);
}

function pollBounded(graph, request, signal, callerSignal, deadline) {
  const operation = Promise.resolve().then(() => {
    if (signal.aborted) throw new RecoveryBaselineError(abortStatus(callerSignal, deadline));
    return graph.poll({ ...request, signal });
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, new RecoveryBaselineError(abortStatus(callerSignal, deadline)));
    operation.then(value => finish(resolve, value), () => finish(reject, safeFailure(callerSignal, deadline)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
  });
}

function safeFailure(callerSignal, deadline) {
  const code = abortStatus(callerSignal, deadline);
  return new RecoveryBaselineError(code ?? 'RECOVERY_BASELINE_FAILED');
}

function rethrowSafe(error, signal, deadline) {
  if (error instanceof RecoveryBaselineError) throw error;
  if (signal?.aborted) fail('RECOVERY_BASELINE_ABORTED');
  if (deadline?.aborted) fail('RECOVERY_BASELINE_TIMEOUT');
  fail('RECOVERY_BASELINE_FAILED');
}

function parseCursor(value) {
  try { return JSON.parse(value); } catch { fail('RECOVERY_BASELINE_FAILED'); }
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function validCursorState(value) {
  return exactKeys(value, ['url', 'initialComplete']) && typeof value.url === 'string' && value.url.length > 0
    && typeof value.initialComplete === 'boolean';
}

function cursorState(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES) fail('RECOVERY_BASELINE_FAILED');
  const parsed = parseCursor(value);
  if (!validCursorState(parsed)) fail('RECOVERY_BASELINE_FAILED');
  return parsed;
}

function pageMessageCount(page, total, maxMessages) {
  if (!page || typeof page !== 'object' || !Array.isArray(page.messages) || page.messages.length > MAX_PAGE_MESSAGES) fail('RECOVERY_BASELINE_FAILED');
  const nextTotal = total + page.messages.length;
  if (!Number.isSafeInteger(nextTotal) || nextTotal > maxMessages) fail('RECOVERY_BASELINE_FAILED');
  return nextTotal;
}

function safeObservedAt(clock) {
  const observedAt = clock();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('RECOVERY_BASELINE_FAILED');
  return observedAt;
}

async function walkBaseline({ graph, maxPages, maxMessages, signal, clock }, composed) {
  let cursor;
  let pages = 0;
  let messages = 0;
  const seen = new Set();
  for (;;) {
    checkActive(signal, composed.deadline);
    if (pages >= maxPages) fail('RECOVERY_BASELINE_FAILED');
    const page = await pollBounded(graph, { cursor, maxMessages: MAX_PAGE_MESSAGES }, composed.signal, signal, composed.deadline);
    checkActive(signal, composed.deadline);
    pages++;
    messages = pageMessageCount(page, messages, maxMessages);
    const state = cursorState(page.cursor);
    if (seen.has(page.cursor)) fail('RECOVERY_BASELINE_FAILED');
    seen.add(page.cursor);
    if (state.initialComplete) return { cursor: page.cursor, pages, messages, observedAt: safeObservedAt(clock) };
    cursor = page.cursor;
  }
}

/** Read every page of an initial Graph delta baseline without exposing its messages or mutating state. */
export async function stageRecoveryBaseline({ graph, signal, clock = Date.now, timeoutMs = 60_000, maxPages = 100, maxMessages = 10_000 } = {}) {
  let composed;
  try {
    const options = { graph, signal, clock, timeoutMs, maxPages, maxMessages };
    validateOptions(options);
    composed = composedSignal(signal, timeoutMs);
    checkActive(signal, composed.deadline);
    return await walkBaseline(options, composed);
  } catch (error) {
    rethrowSafe(error, signal, composed?.deadline);
  } finally {
    if (composed) clearTimeout(composed.timer);
  }
}
