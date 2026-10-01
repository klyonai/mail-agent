import { setTimeout as delay } from 'node:timers/promises';

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK = new Set(['EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE',
  'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT']);
const HTTP_DATE = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/;

export const retryStatus = status => TRANSIENT_STATUS.has(status);
export const sleep = (ms, { signal }) => delay(ms, undefined, { signal });

export function retryNetwork(error) {
  const seen = new Set();
  for (let depth = 0; error && depth < 5 && !seen.has(error); depth++) {
    seen.add(error);
    if (TRANSIENT_NETWORK.has(error.code)) return true;
    error = error.cause;
  }
  return false;
}

/** Return a numeric minimum only; never retain the provider header. */
export function retryNotBefore(raw, now) {
  if (typeof raw !== 'string' || raw.length > 128) return undefined;
  const value = raw.trim();
  let timestamp;
  if (/^\d+$/.test(value)) {
    timestamp = Math.min(Number.MAX_SAFE_INTEGER, now + Number(value) * 1000);
  } else {
    // Recognize standard HTTP dates and both legacy wire formats; retain only the numeric result.
    if (!HTTP_DATE.test(value)) return undefined;
    timestamp = Date.parse(value.endsWith('GMT') ? value : `${value} GMT`);
  }
  return Number.isSafeInteger(timestamp) && timestamp > now ? timestamp : undefined;
}

function backoff(attempt, random) {
  const value = Number(random());
  const fraction = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
  return Math.ceil(500 * 2 ** attempt * (0.5 + fraction / 2));
}

/** Three logical attempts share the caller's single deadline, including credential acquisition. */
export async function readWithRetries(operation, { signal, deadline, clock, random, sleep: wait, timeoutError, observedFailure }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw signal.reason;
    if (clock() >= deadline) throw timeoutError();
    try { return await operation(); }
    catch (error) {
      observedFailure(error);
      if (!error.retryable || attempt === 2 || signal.aborted) throw error;
      const now = clock();
      const minimum = Math.max(0, (error.retryNotBefore ?? now) - now);
      const pause = Math.max(minimum, backoff(attempt, random));
      if (pause >= deadline - now) throw error;
      await wait(pause, { signal });
    }
  }
}
