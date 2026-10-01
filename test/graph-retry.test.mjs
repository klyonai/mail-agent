import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { createGraph, GraphError } from '../src/graph.mjs';

const config = { address: 'agent@example.org', tenant_id: 'tenant', client_id: 'client',
  client_secret_env: 'GRAPH_SECRET', timeout_ms: 30000 };
const token = () => new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600 }));
const ready = () => new Response(JSON.stringify({ value: [] }));

function harness(responses, options = {}) {
  let now = options.now ?? 100000;
  const calls = [], waits = [];
  const graph = createGraph({ ...config, ...options.config }, {
    env: { GRAPH_SECRET: 'synthetic-secret' }, clock: () => now, random: () => 0.5,
    sleep: async (ms, { signal }) => { waits.push(ms); assert.ok(signal); now += ms; },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method, signal: init.signal });
      const item = responses.shift();
      if (typeof item === 'function') return item({ advance: ms => { now += ms; }, init });
      if (item instanceof Error) throw item;
      assert.ok(item instanceof Response, 'Unexpected extra network request'); return item;
    }, ...options.dependencies,
  });
  return { graph, calls, waits, now: () => now };
}

test('safe Graph reads retry transient failures at most three times with injected jitter', async () => {
  const h = harness([token(), new Response(null, { status: 503 }), new Response(null, { status: 502 }), ready()]);
  assert.deepEqual(await h.graph.check(), { status: 'ready' });
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 3);
  assert.equal(h.waits.length, 2); assert.ok(h.waits[1] > h.waits[0]);
  assert.ok(h.calls.every(call => call.signal === h.calls[0].signal));
});

test('token acquisition and GET share three logical attempts and the original deadline', async () => {
  const h = harness([new Response(null, { status: 503 }), token(), new Response(null, { status: 503 }), ready()]);
  await h.graph.check();
  assert.equal(h.calls.filter(call => call.url.includes('/token')).length, 2);
  assert.equal(h.calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(h.waits.length, 2);
  const exhausted = harness([token(), ...[1, 2, 3].map(() => new Response('private body', { status: 503 }))]);
  await assert.rejects(exhausted.graph.check(), error => {
    assert.equal(error.httpStatus, 503); assert.equal(error.retryable, true);
    assert.doesNotMatch(JSON.stringify(error), /private body|synthetic-token|synthetic-secret/); return true;
  });
  assert.equal(exhausted.calls.length, 4);
});

test('Retry-After seconds and HTTP date are minimum waits, never clipped to an earlier retry', async () => {
  for (const retryAfter of ['2', new Date(102000).toUTCString(),
    'Thursday, 01-Jan-70 00:01:42 GMT', 'Thu Jan  1 00:01:42 1970']) {
    const h = harness([token(), new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } }), ready()]);
    await h.graph.check(); assert.ok(h.waits[0] >= 2000);
  }
  const h = harness([token(), new Response('private throttle', { status: 429, headers: { 'Retry-After': '120' } })]);
  await assert.rejects(h.graph.check(), error => {
    assert.equal(error.code, 'rate-limited'); assert.equal(error.uncertain, false);
    assert.equal(error.retryable, true); assert.equal(error.httpStatus, 429);
    assert.equal(error.retryNotBefore, 220000); assert.doesNotMatch(JSON.stringify(error), /private throttle/); return true;
  });
  assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 0);
});

test('token time and backoff consume the same logical mailbox deadline', async () => {
  const h = harness([({ advance }) => { advance(29500); return token(); },
    new Response(null, { status: 429, headers: { 'Retry-After': '1' } })]);
  await assert.rejects(h.graph.check(), error => error.httpStatus === 429 && error.retryNotBefore === 130500);
  assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 0);
  const expired = harness([({ advance }) => { advance(30001); return token(); }]);
  await assert.rejects(expired.graph.check(), { code: 'aborted', diagnosticCode: 'timeout' });
  assert.equal(expired.calls.length, 1);
});

test('safe retry selection excludes TLS, authorization, invalid and oversized responses', async () => {
  const failures = [
    Object.assign(new Error('private'), { code: 'CERT_HAS_EXPIRED' }),
    Object.assign(new Error('private'), { code: 'ENOTFOUND' }),
    new Response(null, { status: 401 }), new Response(null, { status: 403 }),
    new Response(null, { status: 404 }), new Response(null, { status: 501 }),
    new Response('{not json'), new Response('x'.repeat(1025)),
  ];
  for (const failure of failures) {
    const h = harness([token(), failure], { config: { max_response_bytes: 1024 } });
    await assert.rejects(h.graph.check(), error => error instanceof GraphError && error.retryable === false);
    assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 0);
  }
  const h = harness([]);
  await assert.rejects(h.graph.poll({ cursor: 'bad' }), { code: 'invalid-cursor', retryable: false });
  assert.equal(h.calls.length, 0);
});

test('selected connection errors and HTTP 408 retry only on safe reads', async () => {
  for (const failure of [Object.assign(new Error('private'), { code: 'ECONNRESET' }), new Response(null, { status: 408 })]) {
    const h = harness([token(), failure, ready()]);
    await h.graph.check(); assert.equal(h.calls.length, 3); assert.equal(h.waits.length, 1);
  }
});

test('reply and its token acquisition never retry; uncertainty remains conservative', async () => {
  const message = { id: 'id', sender: 'alice@example.org', authenticated: true };
  for (const [response, uncertain] of [[new Response(null, { status: 503 }), true],
    [new Response(null, { status: 429, headers: { 'Retry-After': '120' } }), false]]) {
    const h = harness([token(), response]);
    await assert.rejects(h.graph.reply(message, 'Done'), error => error.uncertain === uncertain && error.retryable === false);
    assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 0);
  }
  const h = harness([new Response(null, { status: 503 })]);
  await assert.rejects(h.graph.reply(message, 'Done'), { uncertain: false, retryable: false });
  assert.equal(h.calls.length, 1);
});

test('caller cancellation during backoff stops immediately even if injected sleep ignores signal', async () => {
  const controller = new AbortController();
  let enter;
  const entered = new Promise(done => { enter = done; });
  const h = harness([token(), new Response(null, { status: 429, headers: { 'Retry-After': '2' } })], { dependencies: {
    sleep: async () => { enter(); return new Promise(() => {}); }
  } });
  const pending = h.graph.check({ signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(pending, { code: 'aborted', diagnosticCode: 'cancelled', retryable: false, retryNotBefore: 102000 });
  assert.equal(h.calls.length, 2);
});

test('provider deadline is observable before a retry wait can be cancelled', async () => {
  const controller = new AbortController();
  const observed = [];
  let enter;
  const entered = new Promise(done => { enter = done; });
  const h = harness([token(), new Response('private provider body', {status:429, headers:{'Retry-After':'2'}})], {dependencies:{
    onRetryNotBefore: timestamp => observed.push(timestamp),
    sleep: async () => {enter(); return new Promise(() => {});}
  }});
  const pending = h.graph.check({signal:controller.signal});
  await entered;
  try {assert.deepEqual(observed,[102000]);}
  finally {controller.abort(); await assert.rejects(pending,{diagnosticCode:'cancelled'});}
  assert.equal(h.calls.length,2);
});

test('logical deadline also bounds successful responses and pre-send token acquisition', async () => {
  const h = harness([token(), ({ advance }) => { advance(30001); return ready(); }]);
  await assert.rejects(h.graph.check(), { code: 'aborted', diagnosticCode: 'timeout', uncertain: false });
  const beforeSend = harness([({ advance }) => { advance(30001); return token(); }]);
  await assert.rejects(beforeSend.graph.reply({ id: 'id', sender: 'alice@example.org', authenticated: true }, 'Done'),
    { code: 'aborted', diagnosticCode: 'timeout', uncertain: false });
  assert.equal(beforeSend.calls.length, 1);
});

test('cancelled callers, TLS causes and invalid Retry-After cannot expand retry scope', async () => {
  const tls = Object.assign(new Error('private'), { code: 'CERT_HAS_EXPIRED',
    cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) });
  const h = harness([token(), tls]);
  await assert.rejects(h.graph.check(), { diagnosticCode: 'tls', retryable: false });
  assert.equal(h.calls.length, 2);
  for (const diagnosticCode of ['cancelled', 'credential', 'access-denied']) {
    const failure = Object.assign(new Error('private'), { diagnosticCode,
      cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }) });
    const sample = harness([token(), failure]);
    await assert.rejects(sample.graph.check(), { diagnosticCode, retryable: false });
    assert.equal(sample.calls.length, 2);
  }
  for (const header of ['private credential text', '-1', 'Infinity', '1.5']) {
    const sample = harness([token(), new Response(null, { status: 429, headers: { 'Retry-After': header } }), ready()]);
    await sample.graph.check(); assert.ok(sample.waits[0] <= 500);
  }
  const cancelled = harness([]);
  await assert.rejects(cancelled.graph.check({ signal: AbortSignal.abort() }), { code: 'aborted', retryable: false });
  assert.equal(cancelled.calls.length, 0);
});

test('exhausted Retry-After remains available for persisted runtime deferral', async () => {
  const h = harness([token(), new Response(null, { status: 503 }), new Response(null, { status: 503 }),
    new Response(null, { status: 429, headers: { 'Retry-After': '120' } })]);
  await assert.rejects(h.graph.check(), error => {
    assert.equal(error.retryNotBefore, h.now() + 120000); assert.equal(error.httpStatus, 429);
    assert.equal(error.retryable, true); return true;
  });
  assert.equal(h.calls.length, 4);
});

test('oversized declared bodies are cancelled without a read retry', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const h = harness([token(), new Response(stream, { headers: { 'content-length': '2048' } })],
    { config: { max_response_bytes: 1024 } });
  await assert.rejects(h.graph.check(), { code: 'response-too-large', retryable: false });
  assert.equal(cancelled, true); assert.equal(h.calls.length, 2); assert.equal(h.waits.length, 0);
});
