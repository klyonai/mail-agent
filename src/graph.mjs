import { classifyDiagnostic } from './diagnostics-errors.mjs';
import { readWithRetries, retryStatus, retryNetwork, retryNotBefore, sleep as defaultSleep } from './graph-retry.mjs';
import { buildTextAttachmentReply } from './attachment-reply.mjs';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';
const SELECT = 'id,conversationId,from,sender,replyTo,toRecipients,ccRecipients,subject,uniqueBody,receivedDateTime,hasAttachments,internetMessageHeaders';
const PREFER = 'IdType="ImmutableId", outlook.body-content-type="text"';
const RETRY_DIAGNOSTICS = new Set(['connection', 'timeout', 'dns']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif']);
const ATTACHMENT_CACHE_LIMIT = 128;

export class GraphError extends Error {
  constructor(code, { uncertain = false, diagnosticCode = graphDiagnostic(code), retryable = false, httpStatus, retryNotBefore } = {}) {
    super(`Microsoft Graph operation failed (${code}).`);
    this.name = 'GraphError';
    this.code = code;
    this.uncertain = uncertain;
    this.diagnosticCode = diagnosticCode;
    this.retryable = retryable === true;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
    if (Number.isSafeInteger(retryNotBefore) && retryNotBefore > 0) this.retryNotBefore = retryNotBefore;
  }
}

function graphDiagnostic(code) {
  if (code === 'invalid-config') return 'configuration';
  if (code === 'redirect') return 'endpoint-policy';
  if (code === 'rate-limited') return 'throttled';
  if (code === 'invalid-response' || code === 'response-too-large') return 'invalid-response';
  if (code === 'aborted') return 'cancelled';
  if (code === 'authorization') return 'access-denied';
  return 'dependency-failed';
}

function fail(code, uncertain = false, diagnosticCode, metadata = {}) {
  throw new GraphError(code, { uncertain, ...metadata, ...(diagnosticCode ? { diagnosticCode } : {}) });
}

function email(value) {
  if (typeof value !== 'string') return '';
  const address = value.trim().toLowerCase();
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(address) ? address : '';
}

function addresses(values) {
  if (!Array.isArray(values)) fail('invalid-response');
  return values.map(value => {
    const address = email(value?.emailAddress?.address);
    if (!address) fail('invalid-response');
    return address;
  });
}

function headersOf(values) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) fail('invalid-response');
  return values.map(value => {
    if (typeof value?.name !== 'string' || typeof value.value !== 'string') fail('invalid-response');
    return { name: value.name.toLowerCase(), value: value.value.trim() };
  });
}

function automatic(headers, sender) {
  if (/^(mailer-daemon|postmaster)@/i.test(sender)) return true;
  return headers.some(({ name, value }) => {
    if (name === 'auto-submitted') return value.toLowerCase() !== 'no';
    if (name === 'return-path') return value === '<>';
    if (name === 'precedence') return /^(bulk|list|junk)$/i.test(value);
    if (name === 'content-type') return /(?:delivery-status|disposition-notification)/i.test(value);
    return name === 'list-id' || name === 'list-unsubscribe';
  });
}

function verifiedDmarc(value, domain) {
  // Comments are unsupported: a pass result embedded in a comment must never authenticate mail.
  if (/[()\r\n]/.test(value)) return false;
  const results = value.split(';').slice(1).map(part => part.trim());
  const dmarc = results.filter(part => /^dmarc=/i.test(part));
  if (dmarc.length !== 1 || !/^dmarc=pass(?:\s|$)/i.test(dmarc[0])) return false;
  const from = [...dmarc[0].matchAll(/(?:^|\s)header\.from=([^\s;]+)/gi)];
  return from.length === 1 && from[0][1].toLowerCase() === domain;
}

function singletonHeader(headers, name) {
  const values = headers.filter(header => header.name === name);
  return values.length === 1 ? values[0].value : undefined;
}

function internalAuthSource(headers) {
  const values = headers.filter(header => header.name === 'x-ms-exchange-organization-authsource');
  if (values.length === 0) return true;
  if (values.length !== 1 || values[0].value.length > 253) return false;
  // A hostname boundary excludes lookalikes, URLs and externally appended suffixes.
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+prod\.outlook\.com$/i.test(values[0].value);
}

function internalAuthenticated(headers, sender, config, policy) {
  const domains = policy.sender_domains;
  const domain = sender.split('@')[1];
  if (!Array.isArray(domains) || !domains.some(value => typeof value === 'string' && value.toLowerCase() === domain)) return false;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.tenant_id ?? '')) return false;
  const tenant = singletonHeader(headers, 'x-ms-exchange-crosstenant-id');
  if (tenant?.toLowerCase() !== config.tenant_id.toLowerCase()) return false;
  const required = [
    ['x-ms-exchange-organization-authas', 'Internal'],
    ['x-ms-exchange-crosstenant-authas', 'Internal'],
    ['x-ms-exchange-crosstenant-fromentityheader', 'Hosted'],
    ['x-ms-exchange-organization-messagedirectionality', 'Originating'],
  ];
  return required.every(([name, value]) => singletonHeader(headers, name) === value)
    && internalAuthSource(headers);
}

function authenticated(headers, sender, config, transportSender) {
  const policy = config.sender_authentication;
  if (policy?.transport_headers_verified !== true) return false;
  if (transportSender !== sender) return false;
  if (policy.mode === 'exchange-internal') return internalAuthenticated(headers, sender, config, policy);
  if (policy.mode !== 'exchange-authenticated') return false;
  const trusted = policy.trusted_authserv_ids ?? [];
  const authHeaders = headers.filter(({ name }) => name === 'authentication-results');
  const matching = authHeaders.filter(({ value }) => trusted.includes(value.split(';')[0].trim().toLowerCase()));
  return matching.length === 1 && verifiedDmarc(matching[0].value, sender.split('@')[1]);
}

function messageIdentity(value) {
  if (typeof value?.id !== 'string' || !value.id) fail('invalid-response');
  if (typeof value.conversationId !== 'string' || !value.conversationId) fail('invalid-response');
  const sender = email(value.from?.emailAddress?.address);
  if (!sender) fail('invalid-response');
  return { id: value.id, conversationId: value.conversationId, sender };
}

function messageContent(value) {
  if (typeof value.uniqueBody?.contentType !== 'string') fail('invalid-response');
  if (typeof value.uniqueBody.content !== 'string') fail('invalid-response');
  if (typeof value.receivedDateTime !== 'string' || !Number.isFinite(Date.parse(value.receivedDateTime))) fail('invalid-response');
  const bodyFormat = value.uniqueBody.contentType.toLowerCase();
  return { subject: typeof value.subject === 'string' ? value.subject : '',
    body: bodyFormat === 'text' ? value.uniqueBody.content : '', bodyFormat, receivedAt: value.receivedDateTime };
}

function normalize(value, config) {
  const identity = messageIdentity(value);
  const content = messageContent(value);
  const transportSender = email(value.sender?.emailAddress?.address);
  const replyTo = addresses(value.replyTo ?? []);
  if (replyTo.length > 1) fail('invalid-response');
  const headers = headersOf(value.internetMessageHeaders);
  return {
    ...identity, ...content,
    ...(replyTo.length ? { replyTo: replyTo[0] } : {}),
    to: addresses(value.toRecipients), cc: addresses(value.ccRecipients ?? []),
    autoGenerated: automatic(headers, identity.sender),
    authenticated: authenticated(headers, identity.sender, config, transportSender),
    attachments: value.hasAttachments === true,
    // Graph hasAttachments excludes inline files. Only a separate metadata read can rule those out.
    attachmentStatus: 'unknown',
  };
}

function attachmentKind(value) {
  if (value?.['@odata.type'] !== '#microsoft.graph.fileAttachment') return 'unknown';
  if (value.isInline === false) return 'document';
  if (value.isInline === true && /^image\/(?:png|jpeg|gif)$/i.test(value.contentType ?? '')) return 'inline-artifact';
  return 'unknown';
}

function attachmentClassification(page) {
  if (!Array.isArray(page?.value)) fail('invalid-response');
  const kinds = page.value.map(attachmentKind);
  let kind = 'none';
  if (kinds.length) kind = kinds.every(value => value === 'inline-artifact') ? 'inline-artifact' : 'document';
  if (kinds.includes('unknown') || page['@odata.nextLink']) kind = 'unknown';
  return { kind, count: kinds.length };
}

function validGraphId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && ![...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
}

function imageItem(item, seen) {
  const id = item?.id;
  const contentType = typeof item?.contentType === 'string' ? item.contentType.toLowerCase() : '';
  if (item?.['@odata.type'] !== '#microsoft.graph.fileAttachment' || !validGraphId(id) || seen.has(id)
    || item.isInline !== false || !IMAGE_TYPES.has(contentType)
    || !Number.isSafeInteger(item.size) || item.size < 1) return undefined;
  seen.add(id);
  return { id, type: 'file', isInline: false, contentType, size: item.size };
}

function validatedImagePage(page, maxImages) {
  if (!Array.isArray(page?.value)) fail('invalid-response');
  if (page['@odata.nextLink'] !== undefined || page.value.length > maxImages) return { complete: false, items: [] };
  const seen = new Set();
  const items = page.value.map(item => imageItem(item, seen));
  if (items.some(item => !item)) return { complete: false, items: [] };
  return { complete: true, items };
}

function validateIdentity(config, env) {
  if (!email(config.address)) fail('invalid-config');
  if (!/^[a-z0-9.-]+$/i.test(config.tenant_id ?? '') || !/^[a-z0-9-]+$/i.test(config.client_id ?? '')) fail('invalid-config');
  if (!env[config.client_secret_env]) fail('invalid-config');
}

function validateEndpoints(config) {
  if ((config.graph_base_url ?? GRAPH_BASE) !== GRAPH_BASE) fail('invalid-config');
  if ((config.login_base_url ?? LOGIN_BASE) !== LOGIN_BASE) fail('invalid-config');
}

function validateConfig(config, env) {
  validateIdentity(config, env);
  validateEndpoints(config);
  const timeout = config.timeout_ms ?? 30_000;
  const cap = config.max_response_bytes ?? 4_000_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) fail('invalid-config');
  if (!Number.isSafeInteger(cap) || cap < 1024 || cap > 20_000_000) fail('invalid-config');
  return { timeout, cap };
}

function deltaUrl(raw, deltaRoot) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail('invalid-cursor'); }
  const expected = new URL(deltaRoot);
  const path = cursorPath(parsed.pathname);
  if (parsed.origin !== expected.origin || path !== expected.pathname) fail('invalid-cursor');
  if (parsed.username || parsed.password || parsed.hash) fail('invalid-cursor');
  return parsed.href;
}

function cursorPath(path) {
  try {
    return path.replace(/^\/v1\.0\/users\/([^/]+)/, (_, mailbox) => `/v1.0/users/${encodeURIComponent(decodeURIComponent(mailbox))}`)
      .replace(/\/mailFolders\('inbox'\)\/messages\/delta$/, '/mailFolders/inbox/messages/delta');
  } catch { fail('invalid-cursor'); }
}

function readCursor(cursor, deltaRoot) {
  if (!cursor) return { url: `${deltaRoot}?$select=${SELECT}`, initialComplete: false };
  let parsed;
  try { parsed = JSON.parse(cursor); } catch { fail('invalid-cursor'); }
  if (typeof parsed?.url !== 'string' || typeof parsed.initialComplete !== 'boolean') fail('invalid-cursor');
  return { url: deltaUrl(parsed.url, deltaRoot), initialComplete: parsed.initialComplete };
}

/** Validate a completed recovery checkpoint without credentials or network access. */
export function validateGraphCheckpoint(config,cursor) {
  if (typeof cursor!=='string' || !cursor || Buffer.byteLength(cursor,'utf8')>65536 || !email(config.address)) fail('invalid-cursor');
  const root=`${GRAPH_BASE}/users/${encodeURIComponent(email(config.address))}/mailFolders/inbox/messages/delta`;
  if (!readCursor(cursor,root).initialComplete) fail('invalid-cursor');
  return cursor;
}

function pagePreferences(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) fail('invalid-input');
  return `${PREFER}, odata.maxpagesize=${maximum}`;
}

async function withSignal(promise, signal) {
  let listener;
  const aborted = new Promise((resolve, reject) => {
    listener = () => reject(new GraphError('aborted'));
    if (signal.aborted) listener();
    else signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

async function boundedJson(response, cap, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > cap) {
    void response.body?.cancel().catch(() => {});
    fail('response-too-large');
  }
  if (!response.body) fail('invalid-response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > cap) fail('response-too-large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid-response'); }
}

async function boundedBytes(response, cap, signal) {
  const length = Number(response.headers.get('content-length'));
  if (length > cap) { void response.body?.cancel().catch(() => {}); fail('response-too-large'); }
  if (!response.body) fail('invalid-response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > cap) fail('response-too-large');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function readResponse(response, { binary, cap, signal, deadline, clock }) {
  const value = binary ? await boundedBytes(response, cap, signal) : await boundedJson(response, cap, signal);
  checkDeadline(signal, deadline, clock);
  return value;
}

function statusDiagnostic(status, tokenStage) {
  if (status === 401 || (tokenStage && status === 400)) return 'credential';
  if (status === 403) return 'access-denied';
  if (status === 404) return tokenStage ? 'dependency-failed' : 'mailbox-unavailable';
  if (status === 408) return 'timeout';
  if (status >= 400 && status < 500) return 'invalid-response';
  return 'dependency-failed';
}

function classifyStatus(status, sending, tokenStage, metadata) {
  if (status >= 300 && status < 400) fail('redirect', sending, 'endpoint-policy', metadata);
  if (status === 429) fail('rate-limited', false, 'throttled', metadata);
  const definite = status >= 400 && status < 500 && status !== 408;
  fail(status === 401 || status === 403 ? 'authorization' : 'http-error', sending && !definite, statusDiagnostic(status, tokenStage), metadata);
}

function operationSignal(signal, timeout) {
  if (signal?.aborted) fail('aborted');
  const timed = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timed]) : timed;
}

function translateError(error, signal, sending, read = false, retryNotBefore) {
  if (error instanceof GraphError) {
    if (error.code === 'aborted') {
      const diagnosticCode = signal.aborted ? classifyDiagnostic(signal.reason) : error.diagnosticCode;
      fail('aborted', sending, diagnosticCode === 'timeout' ? 'timeout' : 'cancelled', { retryNotBefore });
    }
    throw error;
  }
  if (signal.aborted) {
    const diagnosticCode = classifyDiagnostic(signal.reason);
    fail('aborted', sending, diagnosticCode === 'timeout' ? 'timeout' : 'cancelled', { retryNotBefore });
  }
  const diagnosticCode = classifyDiagnostic(error);
  fail('network-error', sending, diagnosticCode, { retryable: read && RETRY_DIAGNOSTICS.has(diagnosticCode) && retryNetwork(error) });
}

function checkDeadline(signal, deadline, clock) {
  if (signal.aborted) throw new GraphError('aborted');
  if (clock() >= deadline) fail('aborted', false, 'timeout');
}

function responseDeadline(response, signal, deadline, clock) {
  try { checkDeadline(signal, deadline, clock); }
  catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
}

function responseFailure(response, { sending, tokenStage, read }, clock) {
  void response.body?.cancel().catch(() => {});
  const transient = retryStatus(response.status);
  classifyStatus(response.status, sending, tokenStage, { httpStatus: response.status,
    retryable: read && transient,
    retryNotBefore: transient ? retryNotBefore(response.headers.get('retry-after'), clock()) : undefined });
}

function validateSendResponse(response) {
  void response.body?.cancel().catch(() => {});
  if (response.status !== 202) fail('unexpected-send-response', true);
  return { status: 'accepted' };
}

function validateBinaryResponse(response, binary) {
  if (binary && response.status !== 200) fail('invalid-response');
}

function checkArtifactExpiry(notAfter, clock) {
  if (Number.isSafeInteger(notAfter) && clock() >= notAfter) fail('attachment-expired');
}

function attachmentPayload(message, text, attachment, expectedPayloadSha256, clock) {
  if (typeof expectedPayloadSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedPayloadSha256)) fail('attachment-intent-mismatch');
  let payload;
  try { payload = buildTextAttachmentReply({ message, bodyText: text, artifact: attachment, now: clock() }); }
  catch { fail('invalid-input'); }
  if (payload.payloadSha256 !== expectedPayloadSha256.toLowerCase()) fail('attachment-intent-mismatch');
  return payload;
}

function validateReplyRecipient(message) {
  if (!email(message.sender) || message.authenticated !== true) fail('unsafe-recipient');
  if (message.replyTo && message.replyTo !== message.sender) fail('unsafe-recipient');
}

function presentMessages(values) {
  return values.filter(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid-response');
    return !value['@removed'];
  });
}

export function createGraph(config, { env = process.env, fetchImpl = fetch, clock = Date.now,
  random = Math.random, sleep = defaultSleep, onRetryNotBefore = () => {} } = {}) {
  const limits = validateConfig(config, env);
  const root = `${GRAPH_BASE}/users/${encodeURIComponent(email(config.address))}`;
  const deltaRoot = `${root}/mailFolders/inbox/messages/delta`;
  let cachedToken;
  let expiresAt = 0;
  const attachmentMetadata = new Map();

  function forgetMessageAttachments(messageId) {
    for (const [key, value] of attachmentMetadata) if (value.messageId === messageId) attachmentMetadata.delete(key);
  }

  function rememberAttachment(messageId, item) {
    const key = JSON.stringify([messageId, item.id]);
    attachmentMetadata.set(key, { messageId, ...item });
    while (attachmentMetadata.size > ATTACHMENT_CACHE_LIMIT) attachmentMetadata.delete(attachmentMetadata.keys().next().value);
  }

  function observeRetry(error) {
    if (Number.isSafeInteger(error.retryNotBefore) && error.retryNotBefore > clock()) onRetryNotBefore(error.retryNotBefore);
  }

async function request(url, init, { signal, deadline, read = false, sending = false, tokenStage = false,
    binary = false, cap = limits.cap, notAfter }) {
    let attempted = false;
    try {
      checkDeadline(signal, deadline, clock);
      checkArtifactExpiry(notAfter, clock);
      attempted = true;
      const response = await withSignal(fetchImpl(url, { ...init, redirect: 'error', signal }), signal);
      if (!response.ok) responseFailure(response, { sending, tokenStage, read }, clock);
      validateBinaryResponse(response, binary);
      responseDeadline(response, signal, deadline, clock);
      if (sending) return validateSendResponse(response);
      return await readResponse(response, { binary, cap, signal, deadline, clock });
    } catch (error) {
      observeRetry(error);
      translateError(error, signal, sending && attempted, read);
    }
  }

  async function token(context) {
    if (cachedToken && clock() < expiresAt) return cachedToken;
    const body = new URLSearchParams({
      client_id: config.client_id, client_secret: env[config.client_secret_env],
      grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    });
    const value = await request(`${LOGIN_BASE}/${encodeURIComponent(config.tenant_id)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
    }, { ...context, cap: 65_536, tokenStage: true });
    if (typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(value.expires_in) || value.expires_in <= 0) fail('invalid-response');
    cachedToken = value.access_token;
    expiresAt = clock() + Math.max(0, value.expires_in * 1000 - 60_000);
    return cachedToken;
  }

  async function get(url, signal, prefer = PREFER, { binary = false, maxBytes = limits.cap } = {}) {
    const context = { signal: operationSignal(signal, limits.timeout), deadline: clock() + limits.timeout, read: true };
    try {
      return await withSignal(readWithRetries(async () => {
        const accessToken = await token(context);
        return request(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Prefer: prefer } },
          { ...context, binary, cap: binary ? maxBytes : limits.cap });
      }, { ...context, clock, random, sleep,
        observedFailure: error => { context.retryNotBefore = Math.max(context.retryNotBefore ?? 0, error.retryNotBefore ?? 0); },
        timeoutError: () => new GraphError('aborted', { diagnosticCode: 'timeout' }) }), context.signal);
    } catch (error) {
      translateError(error, context.signal, false, false, context.retryNotBefore > clock() ? context.retryNotBefore : undefined);
    }
  }

  return {
    async poll({ cursor, signal, maxMessages = 50 } = {}) {
      const prefer = pagePreferences(maxMessages);
      const previous = readCursor(cursor, deltaRoot);
      const value = await get(previous.url, signal, prefer);
      if (!Array.isArray(value?.value)) fail('invalid-response');
      const next = value['@odata.nextLink'];
      const delta = value['@odata.deltaLink'];
      if (typeof (next ?? delta) !== 'string' || (next && delta)) fail('invalid-response');
      const url = deltaUrl(next ?? delta, deltaRoot);
      const messages = presentMessages(value.value).map(message => normalize(message, config));
      return { messages, cursor: JSON.stringify({ url, initialComplete: previous.initialComplete || Boolean(delta) }) };
    },
    async getMessage(id, { signal } = {}) {
      if (typeof id !== 'string' || !id) fail('invalid-input');
      return normalize(await get(`${root}/messages/${encodeURIComponent(id)}?$select=${SELECT}`, signal), config);
    },
    async getAttachmentMetadata(id, { signal } = {}) {
      if (typeof id !== 'string' || !id) fail('invalid-input');
      const page = await get(`${root}/messages/${encodeURIComponent(id)}/attachments?$select=id,isInline,contentType,size`, signal);
      return attachmentClassification(page);
    },
    async getImageAttachments(messageId, { maxImages = 4, signal } = {}) {
      if (!validGraphId(messageId) || !Number.isSafeInteger(maxImages) || maxImages < 1 || maxImages > 4) fail('invalid-input');
      forgetMessageAttachments(messageId);
      const select = 'id,isInline,contentType,size';
      const query = new URLSearchParams({ '$select': select, '$top': String(maxImages + 1) });
      const page = await get(`${root}/messages/${encodeURIComponent(messageId)}/attachments?${query}`,
        signal, `${PREFER}, odata.maxpagesize=${maxImages + 1}`);
      const result = validatedImagePage(page, maxImages);
      if (result.complete) for (const item of result.items) rememberAttachment(messageId, item);
      return result;
    },
    async getAttachmentBytes(messageId, attachmentId, { maxBytes, signal } = {}) {
      if (!validGraphId(messageId) || !validGraphId(attachmentId) || !Number.isSafeInteger(maxBytes)
        || maxBytes < 1 || maxBytes > limits.cap) fail('invalid-input');
      const known = attachmentMetadata.get(JSON.stringify([messageId, attachmentId]));
      if (!known) fail('invalid-input');
      if (known.size > maxBytes) fail('response-too-large');
      const url = `${root}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`;
      const bytes = await get(url, signal, PREFER, { binary: true, maxBytes });
      if (bytes.length !== known.size) fail('invalid-response');
      return new Uint8Array(bytes);
    },
    async reply(message, text, { signal, attachment, expectedPayloadSha256 } = {}) {
      if (!message?.id || typeof text !== 'string' || !text) fail('invalid-input');
      validateReplyRecipient(message);
      const mime = attachment ? attachmentPayload(message, text, attachment, expectedPayloadSha256, clock) : undefined;
      const context = { signal: operationSignal(signal, limits.timeout), deadline: clock() + limits.timeout };
      const accessToken = await token(context);
      return request(`${root}/messages/${encodeURIComponent(message.id)}/reply`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Prefer: PREFER,
          'Content-Type': mime ? mime.contentType : 'application/json' },
        body: mime ? mime.body : JSON.stringify({ message: { body: { contentType: 'Text', content: text } } }),
      }, { ...context, sending: true, ...(mime ? { notAfter: attachment.expiresAt } : {}) });
    },
    async check({ signal } = {}) {
      const value = await get(`${root}/mailFolders/inbox/messages?$top=1&$select=id`, signal);
      if (!Array.isArray(value?.value) || value.value.some(message => typeof message?.id !== 'string' || !message.id)) {
        fail('invalid-response');
      }
      return { status: 'ready' };
    },
  };
}
