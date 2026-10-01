import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';
import { createGraph, GraphError } from '../src/graph.mjs';
import { classifyDiagnostic } from '../src/diagnostics-errors.mjs';
import { buildTextAttachmentReply } from '../src/attachment-reply.mjs';

const config = {
  address: 'agent@example.org', tenant_id: 'tenant', client_id: 'client',
  client_secret_env: 'GRAPH_SECRET', sender_authentication: {mode: 'exchange-authenticated',
  trusted_authserv_ids: ['mx.example.org'], transport_headers_verified: true},
};
const graphRoot = 'https://graph.microsoft.com/v1.0/users/agent%40example.org';
const deltaRoot = `${graphRoot}/mailFolders/inbox/messages/delta`;
const pictureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const imageMetadata = id => ({ '@odata.type': '#microsoft.graph.fileAttachment', id, isInline: false,
  contentType: 'image/png', size: pictureBytes.length });
const mail = (overrides = {}) => ({
  id: 'immutable-id', conversationId: 'conversation',
  from: { emailAddress: { address: 'alice@example.org' } },
  sender: { emailAddress: { address: 'alice@example.org' } },
  toRecipients: [{ emailAddress: { address: config.address } }], ccRecipients: [],
  subject: 'Hello', uniqueBody: { contentType: 'text', content: 'Clean request' },
  body: { contentType: 'text', content: 'Request plus quoted history' },
  receivedDateTime: '2026-01-01T00:00:00Z', hasAttachments: false,
  internetMessageHeaders: [{ name: 'Authentication-Results', value:
    'mx.example.org; dmarc=pass header.from=example.org; spf=pass smtp.mailfrom=example.org' }],
  ...overrides,
});
function setup(responses, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/oauth2/v2.0/token')) {
      return new Response(JSON.stringify({ access_token: 'private-token', expires_in: 3600 }));
    }
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value));
  };
  return { calls, graph: createGraph({ ...config, ...options.config }, {
    env: { GRAPH_SECRET: 'private-secret' }, fetchImpl, clock: options.clock ?? (() => 1000),
    sleep: options.sleep ?? (async () => {}), random: options.random ?? (() => 0),
  }) };
}

test('getImageAttachments returns only complete validated image metadata and caps paging', async () => {
  const { graph, calls } = setup([{ value: [imageMetadata('image-id')] }]);
  assert.deepEqual(await graph.getImageAttachments('immutable-id', { maxImages: 2 }), {
    complete: true, items: [{ id: 'image-id', type: 'file', isInline: false, contentType: 'image/png', size: pictureBytes.length }],
  });
  const request = calls[1];
  assert.equal(request.init.method, 'GET');
  assert.equal(new URL(request.url).searchParams.get('$top'), '3');
  assert.match(new URL(request.url).searchParams.get('$select'), /id,isInline,contentType,size/);
  assert.match(request.init.headers.Prefer, /IdType="ImmutableId".*odata.maxpagesize=3/);
});

test('incomplete or unsupported attachment collections provide no partial image list or content access', async () => {
  for (const response of [
    { value: [imageMetadata('image-id')], '@odata.nextLink': 'https://hostile.invalid/attachments?skip=next' },
    { value: [imageMetadata('image-id')], '@odata.nextLink': '' },
    { value: [imageMetadata('image-id'), { ...imageMetadata('inline'), isInline: true }] },
    { value: [imageMetadata('image-id'), { ...imageMetadata('pdf'), contentType: 'application/pdf' }] },
  ]) {
    const { graph, calls } = setup([response]);
    assert.deepEqual(await graph.getImageAttachments('immutable-id', { maxImages: 2 }), { complete: false, items: [] });
    await assert.rejects(graph.getAttachmentBytes('immutable-id', 'image-id', { maxBytes: 1024 }), { code: 'invalid-input' });
    assert.equal(calls.length, 2);
    assert.equal(calls.some(call => call.url.includes('/$value')), false);
  }
});

test('validated image content is read only from its fixed mailbox message route with a streaming cap', async () => {
  const { graph, calls } = setup([{ value: [imageMetadata('image-id')] }, new Response(pictureBytes)]);
  const metadata = await graph.getImageAttachments('immutable-id');
  const bytes = await graph.getAttachmentBytes('immutable-id', metadata.items[0].id, { maxBytes: 100 });
  assert.deepEqual(Buffer.from(bytes), pictureBytes);
  assert.equal(calls[2].url, `${graphRoot}/messages/immutable-id/attachments/image-id/$value`);
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(calls[2].init.redirect, 'error');
  assert.match(calls[2].init.headers.Prefer, /IdType="ImmutableId"/);
});

test('attachment reads reject unvalidated ids, metadata size overruns, and oversized response streams', async () => {
  const unvalidated = setup([]);
  await assert.rejects(unvalidated.graph.getAttachmentBytes('id', 'attachment', { maxBytes: 100 }), { code: 'invalid-input' });
  assert.equal(unvalidated.calls.length, 0);

  const wrongMessage = setup([{ value: [imageMetadata('image-id')] }]);
  await wrongMessage.graph.getImageAttachments('first-message');
  await assert.rejects(wrongMessage.graph.getAttachmentBytes('second-message', 'image-id', { maxBytes: 100 }), { code: 'invalid-input' });
  assert.equal(wrongMessage.calls.length, 2);

  const knownLarge = setup([{ value: [{ ...imageMetadata('large'), size: 1001 }] }]);
  await knownLarge.graph.getImageAttachments('id');
  await assert.rejects(knownLarge.graph.getAttachmentBytes('id', 'large', { maxBytes: 1000 }), { code: 'response-too-large' });
  assert.equal(knownLarge.calls.length, 2);

  const known = setup([{ value: [imageMetadata('image-id')] }, new Response(new Uint8Array(100))]);
  await known.graph.getImageAttachments('id');
  await assert.rejects(known.graph.getAttachmentBytes('id', 'image-id', { maxBytes: 50 }), { code: 'response-too-large' });

  const partial = setup([{ value: [imageMetadata('partial')] }, new Response(pictureBytes, { status: 206 })]);
  await partial.graph.getImageAttachments('id');
  await assert.rejects(partial.graph.getAttachmentBytes('id', 'partial', { maxBytes: 100 }), { code: 'invalid-response' });
});

test('attachment reads reject partial pages, redirects and cancellation without returning bytes', async () => {
  const redirected = setup([{ value: [imageMetadata('image-id')] }, new Response(null, {
    status: 302, headers: { location: 'https://outside.invalid/private' },
  })]);
  await redirected.graph.getImageAttachments('id');
  await assert.rejects(redirected.graph.getAttachmentBytes('id', 'image-id', { maxBytes: 100 }), { code: 'redirect' });

  const controller = new AbortController();
  let cancelled = false;
  let sent = false;
  const aborted = setup([{ value: [imageMetadata('image-id')] }, new Response(new ReadableStream({
    pull(stream) { if (!sent) { stream.enqueue(Uint8Array.of(1)); sent = true; } }, cancel() { cancelled = true; },
  }))]);
  await aborted.graph.getImageAttachments('id');
  const operation = aborted.graph.getAttachmentBytes('id', 'image-id', { maxBytes: 100, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(operation, { code: 'aborted' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('attachment reply sends exact bounded MIME intent in one POST and rejects mismatched intent before auth', async () => {
  const attachment = { bytes: Buffer.from('Synthetic transcript\n'), name: 'transcript.txt', contentType: 'text/plain',
    expiresAt: 10_000, sha256: createHash('sha256').update('Synthetic transcript\n').digest('hex') };
  const input = { ...mail(), sender: 'alice@example.org', authenticated: true, replyTo: 'alice@example.org' };
  const sample = setup([new Response(null, { status: 202 })]);
  const expectedPayloadSha256 = buildTextAttachmentReply({ message: input, bodyText: 'Completed.', artifact: attachment, now: 1000 }).payloadSha256;
  assert.deepEqual(await sample.graph.reply(input, 'Completed.', { attachment, expectedPayloadSha256 }), { status: 'accepted' });
  assert.equal(sample.calls.length, 2);
  const request = sample.calls[1];
  assert.equal(request.url, `${graphRoot}/messages/immutable-id/reply`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['Content-Type'], 'text/plain');
  const mime = Buffer.from(request.init.body, 'base64').toString('utf8');
  assert.match(mime, /Content-Disposition: attachment; filename="transcript\.txt"/);
  assert.ok(mime.includes(attachment.bytes.toString('base64')));
  assert.equal((await sample.graph.reply(input, 'Completed.', { attachment, expectedPayloadSha256: '0'.repeat(64) }).catch(error => error)).code,
    'attachment-intent-mismatch');
  assert.equal(sample.calls.length, 2);
  const mismatch = setup([]);
  await assert.rejects(mismatch.graph.reply(input, 'Completed.', { attachment, expectedPayloadSha256: '0'.repeat(64) }),
    { code: 'attachment-intent-mismatch' });
  assert.equal(mismatch.calls.length, 0);
});

test('attachment replies remain single-write and preserve unknown send outcomes', async () => {
  const attachment = { bytes: Buffer.from('file'), name: 'transcript.txt', contentType: 'text/plain', expiresAt: 10_000,
    sha256: createHash('sha256').update('file').digest('hex') };
  const input = { ...mail(), sender: 'alice@example.org', authenticated: true };
  const sample = setup([new Response(null, { status: 202 })]);
  const hash = buildTextAttachmentReply({ message: input, bodyText: 'Done', artifact: attachment, now: 1000 }).payloadSha256;
  const graph = sample.graph;
  const other = setup([new Response(null, { status: 500 })]);
  const otherHash = buildTextAttachmentReply({ message: input, bodyText: 'Done', artifact: attachment, now: 1000 }).payloadSha256;
  await assert.rejects(other.graph.reply(input, 'Done', { attachment, expectedPayloadSha256: otherHash }), error => error.uncertain === true);
  assert.equal(other.calls.filter(call => call.url.endsWith('/reply')).length, 1);
  assert.deepEqual(await graph.reply(input, 'Done', { attachment, expectedPayloadSha256: hash }), { status: 'accepted' });

  let now = 1000;
  const expiring = createGraph(config, { env: { GRAPH_SECRET: 'private-secret' }, clock: () => now,
    fetchImpl: async url => {
      if (String(url).includes('/token')) { now = attachment.expiresAt; return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 })); }
      return new Response(null, { status: 202 });
    } });
  const expiringHash = buildTextAttachmentReply({ message: input, bodyText: 'Done', artifact: attachment, now }).payloadSha256;
  await assert.rejects(expiring.reply(input, 'Done', { attachment, expectedPayloadSha256: expiringHash }), { code: 'attachment-expired' });
});

test('attachment metadata classification requests no attachment bytes and distinguishes inline/document/unknown', async () => {
  const cases = [
    [{ value: [] }, 'none'],
    [{ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'i', isInline: true, contentType: 'image/png', size: 20 }] }, 'inline-artifact'],
    [{ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'd', isInline: false, contentType: 'application/pdf', size: 20 }] }, 'document'],
    [{ value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'claimed', isInline: true, contentType: 'application/pdf', size: 20 }] }, 'unknown'],
    [{ value: [], '@odata.nextLink': 'https://hostile.invalid/attachments' }, 'unknown'],
  ];
  for (const [page, kind] of cases) {
    const { graph, calls } = setup([page]);
    assert.deepEqual(await graph.getAttachmentMetadata('id'), { kind, count: page.value.length });
    const url = new URL(calls[1].url);
    assert.equal(url.pathname, '/v1.0/users/agent%40example.org/messages/id/attachments');
    assert.equal(url.searchParams.get('$select'), 'id,isInline,contentType,size');
    assert.doesNotMatch(calls[1].url, /contentBytes|\$value/);
    assert.equal(calls.length, 2);
  }
});

test('Graph body formats are classified without passing unsupported contents through normalized mail', async () => {
  const { graph } = setup([mail({ uniqueBody: { contentType: 'html', content: '<p>private unsupported body</p>' } })]);
  const normalized = await graph.getMessage('id');
  assert.equal(normalized.body, '');
  assert.equal(normalized.bodyFormat, 'html');
  assert.equal(normalized.attachmentStatus, 'unknown');
  assert.doesNotMatch(JSON.stringify(normalized), /private unsupported body/);
});

test('Graph attachment metadata rejects malformed collection responses', async () => {
  for (const page of [null, {}, { value: 'private' }]) {
    const { graph } = setup([page]);
    await assert.rejects(graph.getAttachmentMetadata('id'), error => error instanceof GraphError && error.code === 'invalid-response');
  }
});

test('poll reads a single immutable delta page with clean body and explicit cursor state', async () => {
  const next = `${deltaRoot}?$skiptoken=opaque`;
  const delta = `${deltaRoot}?$deltatoken=opaque`;
  const { graph, calls } = setup([
    { value: [mail()], '@odata.nextLink': next },
    { value: [{ id: 'removed', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': delta },
  ]);
  const first = await graph.poll({ baseline: true });
  assert.equal(first.messages[0].body, 'Clean request');
  assert.equal(first.messages[0].authenticated, true);
  assert.equal(JSON.parse(first.cursor).initialComplete, false);
  assert.equal(calls.length, 2);
  const request = calls[1];
  assert.match(request.init.headers.Prefer, /IdType="ImmutableId"/);
  assert.match(request.init.headers.Prefer, /outlook.body-content-type="text"/);
  assert.match(new URL(request.url).searchParams.get('$select'), /uniqueBody/);
  assert.match(new URL(request.url).searchParams.get('$select'), /internetMessageHeaders/);
  const second = await graph.poll({ cursor: first.cursor, baseline: true });
  assert.deepEqual(second.messages, []);
  assert.equal(JSON.parse(second.cursor).initialComplete, true);
  assert.equal(calls[2].url, next);
  assert.equal(calls.filter(call => call.url.includes('/token')).length, 1);
});

test('getMessage normalizes sender and replyTo without permitting redirect', async () => {
  const { graph } = setup([mail({ replyTo: [{ emailAddress: { address: 'attacker@example.net' } }] })]);
  const value = await graph.getMessage('immutable-id');
  assert.equal(value.replyTo, 'attacker@example.net');
  assert.equal(value.sender, 'alice@example.org');
  await assert.rejects(graph.reply(value, 'Reply'), { code: 'unsafe-recipient', uncertain: false });
});

test('delta links may use Graph canonical inbox key notation without changing mailbox scope', async () => {
  const canonical = deltaRoot.replace('/mailFolders/inbox/', "/mailFolders('inbox')/").replace('%40', '@');
  const { graph, calls } = setup([
    { value: [mail()], '@odata.deltaLink': `${canonical}?$deltatoken=synthetic` },
    { value: [], '@odata.deltaLink': `${canonical}?$deltatoken=next` }
  ]);
  const first = await graph.poll();
  assert.equal(JSON.parse(first.cursor).initialComplete, true);
  await graph.poll({ cursor: first.cursor });
  assert.equal(calls.at(-1).url, `${canonical}?$deltatoken=synthetic`);
  const hostile = setup([{ value: [], '@odata.deltaLink': canonical.replace("('inbox')", "('sentitems')") }]).graph;
  await assert.rejects(hostile.poll(), error => error.code === 'invalid-cursor');
});

test('poll applies a bounded queue-capacity page hint', async () => {
  const { graph, calls } = setup([{ value: [], '@odata.deltaLink': `${deltaRoot}?$deltatoken=x` }]);
  await graph.poll({ maxMessages: 3 });
  assert.match(calls[1].init.headers.Prefer, /odata.maxpagesize=3(?:,|$)/);
  assert.match(calls[1].init.headers.Prefer, /IdType="ImmutableId"/);
  for (const maxMessages of [0, -1, 1001, 1.5, '3']) {
    const sample = setup([]);
    await assert.rejects(sample.graph.poll({ maxMessages }), { code: 'invalid-input' });
    assert.equal(sample.calls.length, 0);
  }
});

test('sender ambiguity, missing clean text and malformed payloads fail closed', async () => {
  for (const input of [
    mail({ uniqueBody: undefined }),
    mail({ uniqueBody: { contentType: 'text', content: 7 } }),
    mail({ uniqueBody: { contentType: 7, content: 'Hi' } }),
    mail({ id: '' }),
  ]) {
    const { graph } = setup([input]);
    await assert.rejects(graph.getMessage('id'), { code: 'invalid-response' });
  }
  const { graph } = setup([mail({ sender: { emailAddress: { address: 'other@example.org' } } })]);
  assert.equal((await graph.getMessage('id')).authenticated, false);
});

test('authentication requires operator assurance, trusted authority and exact DMARC alignment', async () => {
  const cases = [
    { config: { sender_authentication: {...config.sender_authentication, transport_headers_verified: false} }, headers: mail().internetMessageHeaders },
    { config: {}, headers: [{ name: 'Authentication-Results', value: 'evil.net; dmarc=pass header.from=example.org' }] },
    { config: {}, headers: [{ name: 'Authentication-Results', value: 'mx.example.org; dmarc=pass header.from=other.org' }] },
    { config: {}, headers: [{ name: 'Authentication-Results', value: 'mx.example.org; dmarc=fail header.from=example.org' }] },
    { config: {}, headers: [...mail().internetMessageHeaders, ...mail().internetMessageHeaders] },
    { config: {}, headers: [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' }] },
    { config: {}, headers: [{ name: 'Authentication-Results', value: 'mx.example.org; dmarc=pass header.from=example.org.evil' }] },
    { config: {}, headers: [{ name: 'Authentication-Results', value: 'mx.example.org; (dmarc=pass header.from=example.org); dmarc=fail header.from=example.org' }] },
  ];
  for (const sample of cases) {
    const { graph } = setup([mail({ internetMessageHeaders: sample.headers })], sample);
    assert.equal((await graph.getMessage('id')).authenticated, false);
  }
});

const internalTenant = '11111111-2222-3333-4444-555555555555';
const internalPolicy = {
  mode: 'exchange-internal', sender_domains: ['example.org'], transport_headers_verified: true,
};
function internalHeaders() {
  return [
    { name: 'Authentication-Results', value: 'mx.microsoft.com 1; dmarc=none (internal mail) header.from=example.org; dkim=none (not signed)' },
    { name: 'X-MS-Exchange-Organization-AuthAs', value: 'Internal' },
    { name: 'X-MS-Exchange-CrossTenant-AuthAs', value: 'Internal' },
    { name: 'X-MS-Exchange-CrossTenant-FromEntityHeader', value: 'Hosted' },
    { name: 'X-MS-Exchange-Organization-MessageDirectionality', value: 'Originating' },
    { name: 'X-MS-Exchange-CrossTenant-Id', value: internalTenant },
    { name: 'X-MS-Exchange-Organization-AuthSource', value: 'mailbox01.eurprd01.prod.outlook.com' },
  ];
}
function internalSetup(input, overrides = {}) {
  return setup([mail(input)], { config: {
    tenant_id: internalTenant, sender_authentication: internalPolicy, ...overrides,
  } });
}

test('explicit internal profile accepts only reviewed hosted mail from the configured tenant/domain', async () => {
  const { graph } = internalSetup({ internetMessageHeaders: internalHeaders() });
  assert.equal((await graph.getMessage('id')).authenticated, true);
  const withoutSource = internalHeaders().filter(header => !header.name.endsWith('AuthSource'));
  const optional = internalSetup({ internetMessageHeaders: withoutSource });
  assert.equal((await optional.graph.getMessage('id')).authenticated, true);
  const existingProfile = setup([mail({ internetMessageHeaders: internalHeaders() })]);
  assert.equal((await existingProfile.graph.getMessage('id')).authenticated, false);
});

test('internal authentication rejects missing, duplicate and wrong transport evidence', async () => {
  const required = internalHeaders().filter(header => header.name.startsWith('X-MS-') && !header.name.endsWith('AuthSource'));
  for (const header of required) {
    const missing = internalHeaders().filter(value => value.name !== header.name);
    const duplicate = [...internalHeaders(), { ...header }];
    const wrong = internalHeaders().map(value => value.name === header.name ? { ...value, value: 'wrong' } : value);
    for (const headers of [missing, duplicate, wrong]) {
      const { graph } = internalSetup({ internetMessageHeaders: headers });
      assert.equal((await graph.getMessage('id')).authenticated, false);
    }
  }
});

test('internal authentication rejects unverified transport and sender/tenant/domain ambiguity', async () => {
  const cases = [
    { policy: { ...internalPolicy, transport_headers_verified: false } },
    { policy: { ...internalPolicy, sender_domains: ['other.org'] } },
    { policy: { ...internalPolicy, sender_domains: ['org'] } },
    { policy: { ...internalPolicy, sender_domains: [] } },
    { policy: { ...internalPolicy, sender_domains: undefined } },
    { tenant_id: 'tenant-alias.example.org' },
    { tenant_id: '99999999-2222-3333-4444-555555555555' },
    { sender: { emailAddress: { address: 'delegate@example.org' } } },
    { sender: undefined },
    { from: { emailAddress: { address: 'alice@sub.example.org' } }, sender: { emailAddress: { address: 'alice@sub.example.org' } } },
  ];
  for (const sample of cases) {
    const { policy, tenant_id = internalTenant, ...input } = sample;
    const { graph } = internalSetup({ ...input, internetMessageHeaders: internalHeaders() }, {
      tenant_id, sender_authentication: policy ?? internalPolicy,
    });
    assert.equal((await graph.getMessage('id')).authenticated, false);
  }
});

test('internal profile rejects spoofed AuthSource suffixes and duplicate optional evidence', async () => {
  for (const source of ['notprod.outlook.com', 'mail.prod.outlook.com.evil.test', 'https://mail.prod.outlook.com', 'mail.prod.outlook.com\r\nInjected: value', '-mail.prod.outlook.com']) {
    const headers = internalHeaders().map(header => header.name.endsWith('AuthSource') ? { ...header, value: source } : header);
    const { graph } = internalSetup({ internetMessageHeaders: headers });
    assert.equal((await graph.getMessage('id')).authenticated, false);
  }
  const headers = internalHeaders();
  headers.push({ ...headers.at(-1) });
  const { graph } = internalSetup({ internetMessageHeaders: headers });
  assert.equal((await graph.getMessage('id')).authenticated, false);
});

test('internal profile never falls back to a passing DMARC result', async () => {
  const { graph } = internalSetup({ internetMessageHeaders: mail().internetMessageHeaders });
  assert.equal((await graph.getMessage('id')).authenticated, false);
});

test('automatic mail, lists and bounces are marked', async () => {
  for (const headers of [
    [{ name: 'Auto-Submitted', value: 'auto-replied' }],
    [{ name: 'Return-Path', value: '<>' }],
    [{ name: 'List-Id', value: '<list.example.org>' }],
    [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' }],
    [{ name: 'Precedence', value: 'bulk' }],
  ]) {
    const { graph } = setup([mail({ internetMessageHeaders: headers })]);
    assert.equal((await graph.getMessage('id')).autoGenerated, true);
  }
});

test('hostile cursors and provider delta URLs never receive credentials', async () => {
  for (const url of [
    'https://evil.example/delta',
    'https://graph.microsoft.com/v1.0/users/other/messages/delta',
    `${deltaRoot}/../sendMail`,
    `${deltaRoot}?$skiptoken=opaque#fragment`,
    'https://user:pass@graph.microsoft.com/v1.0/users/agent%40example.org/mailFolders/inbox/messages/delta',
  ]) {
    const { graph, calls } = setup([]);
    await assert.rejects(graph.poll({ cursor: JSON.stringify({ url, initialComplete: true }) }), { code: 'invalid-cursor' });
    assert.equal(calls.length, 0);
    const provider = setup([{ value: [], '@odata.deltaLink': url }]);
    await assert.rejects(provider.graph.poll(), { code: 'invalid-cursor' });
    assert.equal(provider.calls.length, 2);
  }
});

test('redirect responses are rejected and redirect following is disabled', async () => {
  const { graph, calls } = setup([new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })]);
  await assert.rejects(graph.poll(), { code: 'redirect', uncertain: false });
  assert.ok(calls.every(call => call.init.redirect === 'error'));
});

test('reply sends explicit text only and preserves ambiguous send outcomes', async () => {
  const { graph, calls } = setup([new Response(null, { status: 202 })]);
  const input = { ...mail(), sender: 'alice@example.org', authenticated: true };
  assert.deepEqual(await graph.reply(input, 'Done'), { status: 'accepted' });
  const call = calls[1];
  assert.equal(call.url, `${graphRoot}/messages/immutable-id/reply`);
  assert.deepEqual(JSON.parse(call.init.body), { message: { body: { contentType: 'Text', content: 'Done' } } });
  for (const [response, uncertain] of [
    [new Response(null, { status: 403 }), false],
    [new Response(null, { status: 429 }), false],
    [new Response(null, { status: 408 }), true],
    [new Response(null, { status: 500 }), true],
    [new Error('private-secret private-token'), true],
  ]) {
    const sample = setup([response]);
    await assert.rejects(sample.graph.reply(input, 'Done'), error => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.uncertain, uncertain);
      assert.doesNotMatch(String(error), /private-secret|private-token/);
      return true;
    });
  }
});

test('OAuth errors are generic, cached tokens expire according to injected clock', async () => {
  let now = 0;
  const { graph, calls } = setup([mail(), mail(), mail()], { clock: () => now });
  await graph.getMessage('id');
  now = 1000;
  await graph.getMessage('id');
  now = 3_600_000;
  await graph.getMessage('id');
  assert.equal(calls.filter(call => call.url.includes('/token')).length, 2);
  assert.match(calls[0].init.body, /client_secret=private-secret/);
  const failed = createGraph(config, { env: { GRAPH_SECRET: 'private-secret' }, fetchImpl: async () => {
    throw new Error('private-secret details');
  } });
  await assert.rejects(failed.check(), error => {
    assert.doesNotMatch(String(error), /private-secret|details/);
    assert.equal(error.uncertain, false);
    return true;
  });
});

test('Graph diagnostics distinguish auth and mailbox failures without changing GraphError codes', async () => {
  for (const [status, expected] of [[401, 'credential'], [403, 'access-denied'], [404, 'mailbox-unavailable']]) {
    const sample = setup([new Response(null, { status })]);
    await assert.rejects(sample.graph.check(), error => {
      assert.ok(error instanceof GraphError);
      assert.equal(error.code, status === 401 ? 'authorization' : status === 403 ? 'authorization' : 'http-error');
      assert.equal(error.diagnosticCode, expected);
      assert.equal(classifyDiagnostic(error), expected);
      return true;
    });
  }
  const graph = createGraph(config, { env: { GRAPH_SECRET: 'private-secret' }, fetchImpl: async () =>
    new Response('private oauth body', { status: 400 }) });
  await assert.rejects(graph.check(), error => {
    assert.equal(error.diagnosticCode, 'credential');
    assert.doesNotMatch(String(error), /private oauth body/);
    return true;
  });
});

test('Graph diagnostic codes preserve send uncertainty and classify safe network codes', async () => {
  const input = { ...mail(), sender: 'alice@example.org', authenticated: true };
  const network = setup([Object.assign(new Error('secret endpoint detail'), { code: 'ENOTFOUND' })]);
  await assert.rejects(network.graph.check(), error => {
    assert.equal(classifyDiagnostic(error), 'dns');
    assert.doesNotMatch(String(error), /secret endpoint detail/);
    return true;
  });
  const sending = setup([new Response(null, { status: 500 })]);
  await assert.rejects(sending.graph.reply(input, 'Done'), error => {
    assert.equal(error.uncertain, true);
    assert.equal(classifyDiagnostic(error), 'dependency-failed');
    return true;
  });
});

test('bounded responses and aborted operations fail safely', async () => {
  const { graph } = setup([new Response('x'.repeat(1025))], { config: { max_response_bytes: 1024 } });
  await assert.rejects(graph.poll(), { code: 'response-too-large' });
  const aborted = setup([]);
  await assert.rejects(aborted.graph.poll({ signal: AbortSignal.abort() }), { code: 'aborted' });
  await assert.rejects(aborted.graph.poll({ signal: AbortSignal.abort() }), error => classifyDiagnostic(error) === 'cancelled');
  assert.equal(aborted.calls.length, 0);
});

test('Graph read timeouts are not reported as caller cancellation', async () => {
  const graph = createGraph({ ...config, timeout_ms: 10 }, {
    env: { GRAPH_SECRET: 'synthetic' }, fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(graph.check(), error => {
    assert.equal(error.code, 'aborted');
    assert.equal(error.uncertain, false);
    assert.equal(classifyDiagnostic(error), 'timeout');
    return true;
  });
});

test('Graph readiness validates successful response metadata', async () => {
  const graph = setup([{ value: [{ id: 17 }] }]).graph;
  await assert.rejects(graph.check(), error => classifyDiagnostic(error) === 'invalid-response');
});

test('malformed delta entries fail safely and caller abort during send is uncertain', async () => {
  const malformed = setup([{ value: [null], '@odata.deltaLink': `${deltaRoot}?$deltatoken=x` }]);
  await assert.rejects(malformed.graph.poll(), { code: 'invalid-response' });
  const controller = new AbortController();
  const graph = createGraph(config, { env: { GRAPH_SECRET: 'synthetic' }, fetchImpl: async url => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'synthetic', expires_in: 3600 }));
    controller.abort();
    throw new Error('private provider diagnostics');
  } });
  await assert.rejects(graph.reply({ id: 'id', sender: 'alice@example.org', authenticated: true }, 'Done', {
    signal: controller.signal,
  }), { code: 'aborted', uncertain: true });
});

test('check is read only and configuration cannot redirect secrets to an arbitrary host', async () => {
  const { graph, calls } = setup([{ value: [] }]);
  await graph.check();
  assert.equal(calls[1].init.method, 'GET');
  for (const option of [{ graph_base_url: 'https://evil.example/v1.0' }, { login_base_url: 'https://evil.example' }]) {
    assert.throws(() => setup([], { config: option }), { code: 'invalid-config' });
  }
});
