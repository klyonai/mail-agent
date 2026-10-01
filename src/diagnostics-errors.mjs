const CODES = new Set([
  'credential', 'access-denied', 'mailbox-unavailable', 'dns', 'connection', 'tls', 'timeout',
  'cancelled', 'throttled', 'invalid-response', 'endpoint-policy', 'configuration',
  'instruction-files', 'model-unsupported', 'tool-unavailable', 'dependency-failed',
]);

const NETWORK_CODES = new Map([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['EAI_FAIL', 'dns'],
  ['ECONNREFUSED', 'connection'], ['ECONNRESET', 'connection'], ['EPIPE', 'connection'],
  ['ECONNABORTED', 'connection'], ['ENETUNREACH', 'connection'], ['EHOSTUNREACH', 'connection'],
  ['ETIMEDOUT', 'timeout'], ['ERR_SOCKET_CONNECTION_TIMEOUT', 'timeout'],
  ['CERT_HAS_EXPIRED', 'tls'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['ERR_SSL_CERTIFICATE_VERIFY_FAILED', 'tls'],
]);

function explicitCode(error) {
  return CODES.has(error.diagnosticCode) ? error.diagnosticCode : undefined;
}

function statusCode(error) {
  const status = error.statusCode ?? error.status ?? (Number.isInteger(error.code) ? error.code : undefined);
  if (status === 401) return 'credential';
  if (status === 403) return 'access-denied';
  if (status === 404) return 'tool-unavailable';
  if (status === 408) return 'timeout';
  if (status === 429) return 'throttled';
  return undefined;
}

function knownCode(error) {
  if (!error || typeof error !== 'object') return undefined;
  const explicit = explicitCode(error);
  if (explicit) return explicit;
  if (NETWORK_CODES.has(error.code)) return NETWORK_CODES.get(error.code);
  const status = statusCode(error);
  if (status) return status;
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AbortError') return 'cancelled';
  return undefined;
}

/** Return only a stable code from a fixed allowlist. Never use messages or provider bodies. */
export function classifyDiagnostic(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = knownCode(current);
    if (code) return code;
    current = current.cause;
  }
  return 'dependency-failed';
}

export function diagnosticError(message, diagnosticCode) {
  const error = new Error(message);
  error.diagnosticCode = CODES.has(diagnosticCode) ? diagnosticCode : 'dependency-failed';
  return error;
}

export function tagDiagnostic(error, diagnosticCode) {
  if (error && typeof error === 'object') {
    error.diagnosticCode = CODES.has(diagnosticCode) ? diagnosticCode : 'dependency-failed';
    return error;
  }
  return diagnosticError('Dependency operation failed.', diagnosticCode);
}
