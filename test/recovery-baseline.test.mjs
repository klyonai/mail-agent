import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';
import { createGraph } from '../src/graph.mjs';
import { stageRecoveryBaseline, RecoveryBaselineError } from '../src/recovery-baseline.mjs';

const graphConfig = {
  address: 'agent@example.test', tenant_id: 'tenant', client_id: 'client', client_secret_env: 'GRAPH_SECRET',
  sender_authentication: { mode: 'exchange-authenticated', trusted_authserv_ids: [], transport_headers_verified: false }
};
const root = 'https://graph.microsoft.com/v1.0/users/agent%40example.test/mailFolders/inbox/messages/delta';
const message = (id = 'message-one') => ({ id, conversationId: `conversation-${id}`,
  from: { emailAddress: { address: 'sender@example.test' } }, sender: { emailAddress: { address: 'sender@example.test' } },
  toRecipients: [{ emailAddress: { address: graphConfig.address } }], ccRecipients: [], subject: 'Synthetic',
  uniqueBody: { contentType: 'text', content: 'SYNTHETIC_PRIVATE_BODY' }, receivedDateTime: '2026-09-30T12:00:00Z',
  hasAttachments: false, internetMessageHeaders: [] });
const cursor = (url, initialComplete) => JSON.stringify({ url, initialComplete });

function requestPlan(patch = {}) { return { clock: () => 1234, ...patch }; }

test('actual Graph adapter walks every baseline page and returns only the final private cursor and counts', async () => {
  const links = [`${root}?$skiptoken=page-two`, `${root}?$skiptoken=page-three`, `${root}?$deltatoken=final`];
  const responses = [
    { value: [message('one')], '@odata.nextLink': links[0] },
    { value: [message('two')], '@odata.nextLink': links[1] },
    { value: [], '@odata.deltaLink': links[2] }
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (String(url).includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 3600 }));
    return new Response(JSON.stringify(responses.shift()));
  };
  const graph = createGraph(graphConfig, { env: { GRAPH_SECRET: 'synthetic-secret' }, fetchImpl, clock: () => 1234 });
  const result = await stageRecoveryBaseline({ graph, ...requestPlan() });
  assert.deepEqual(result, { cursor: cursor(links[2], true), pages: 3, messages: 2, observedAt: 1234 });
  assert.deepEqual(calls.slice(1).map(call => call.method), ['GET', 'GET', 'GET']);
  assert.equal(calls.filter(call => call.url.includes('/messages/') && !call.url.includes('/delta')).length, 0);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_BODY'), false);
  assert.equal(JSON.stringify(result).includes('sender@example.test'), false);
});

test('empty mailbox completes a one-page baseline', async () => {
  const final = `${root}?$deltatoken=empty-mailbox`;
  const result = await stageRecoveryBaseline({ graph: { poll: async options => {
    assert.equal(options.cursor, undefined);
    assert.equal(options.maxMessages, 100);
    return { cursor: cursor(final, true), messages: [] };
  } }, ...requestPlan() });
  assert.deepEqual(result, { cursor: cursor(final, true), pages: 1, messages: 0, observedAt: 1234 });
});

test('rejects repeated cursors, invalid cursor shapes, page size overflow and configured bounds', async () => {
  const repeated = cursor(`${root}?$skiptoken=repeat`, false);
  let calls = 0;
  const loop = { poll: async () => { calls++; return { cursor: repeated, messages: [] }; } };
  await assert.rejects(stageRecoveryBaseline({ graph: loop, ...requestPlan() }), { code: 'RECOVERY_BASELINE_FAILED' });
  assert.equal(calls, 2);
  for (const value of [
    { cursor: JSON.stringify({ url: 'u', initialComplete: true, extra: 'private' }), messages: [] },
    { cursor: JSON.stringify({ url: 7, initialComplete: true }), messages: [] },
    { cursor: JSON.stringify({ url: 'u', initialComplete: false }), messages: [] },
    { cursor: 'x'.repeat(65_537), messages: [] },
    { cursor: repeated, messages: new Array(101) }
  ]) {
    await assert.rejects(stageRecoveryBaseline({ graph: { poll: async () => value }, ...requestPlan() }), error => {
      assert.ok(error instanceof RecoveryBaselineError);
      assert.equal(error.message, 'Mailbox baseline could not be completed safely.');
      return true;
    });
  }
  for (const options of [{ maxPages: 0 }, { maxPages: 101 }, { maxMessages: 0 }, { maxMessages: 10_001 }, { timeoutMs: 60_001 }]) {
    await assert.rejects(stageRecoveryBaseline({ graph: { poll: async () => ({ cursor: repeated, messages: [] }) }, ...requestPlan(options) }),
      { code: 'RECOVERY_BASELINE_INVALID' });
  }
});

test('fails when page or total message limits would be exceeded', async () => {
  const page = { poll: async () => ({ cursor: cursor(`${root}?$skiptoken=more`, false), messages: Array.from({ length: 100 }, () => ({})) }) };
  await assert.rejects(stageRecoveryBaseline({ graph: page, maxMessages: 50 }), { code: 'RECOVERY_BASELINE_FAILED' });
  let calls = 0;
  const count = { poll: async () => {
    calls++;
    return { cursor: cursor(`${root}?$skiptoken=${calls}`, false), messages: Array.from({ length: 100 }, () => ({})) };
  } };
  await assert.rejects(stageRecoveryBaseline({ graph: count, maxMessages: 150 }), { code: 'RECOVERY_BASELINE_FAILED' });
  assert.equal(calls, 2);
  await assert.rejects(stageRecoveryBaseline({ graph: { poll: async () => ({ cursor: cursor(`${root}?$skiptoken=more`, false), messages: [] }) }, maxPages: 1 }),
    { code: 'RECOVERY_BASELINE_FAILED' });
});

test('aborts promptly on cancellation, deadlines and provider failures without leaking their messages', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(stageRecoveryBaseline({ graph: { poll: async () => { calls++; } }, signal: controller.signal }),
    error => error.code === 'RECOVERY_BASELINE_ABORTED' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 0);

  const pending = stageRecoveryBaseline({ graph: { poll: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('PRIVATE_PROVIDER_RESPONSE')), { once: true });
  }) }, timeoutMs: 20 });
  await assert.rejects(pending, error => error.code === 'RECOVERY_BASELINE_TIMEOUT' && !error.message.includes('PRIVATE_PROVIDER_RESPONSE'));

  await assert.rejects(stageRecoveryBaseline({ graph: { poll: async () => { throw new Error('PRIVATE_PROVIDER_RESPONSE'); } } }), error => {
    assert.ok(error instanceof RecoveryBaselineError);
    assert.equal(error.code, 'RECOVERY_BASELINE_FAILED');
    assert.equal(error.message, 'Mailbox baseline could not be completed safely.');
    return true;
  });
});

test('referenced deadline keeps a standalone process alive until a hanging poll is timed out', () => {
  const modulePath = resolve('src/recovery-baseline.mjs');
  const script = `
    import { pathToFileURL } from 'node:url';
    const { stageRecoveryBaseline } = await import(pathToFileURL(${JSON.stringify(modulePath)}));
    try {
      await stageRecoveryBaseline({ graph: { poll: () => new Promise(() => {}) }, timeoutMs: 20 });
      process.exitCode = 2;
    } catch (error) {
      if (error.code !== 'RECOVERY_BASELINE_TIMEOUT') process.exitCode = 3;
      else process.stdout.write('timed-out');
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 2_000
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'timed-out');
  assert.equal(child.stderr, '');
});
