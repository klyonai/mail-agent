import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, contextFits, hydrateContext } from '../src/context.mjs';
import { ImageError } from '../src/image-validation.mjs';

const mail = { id: 'synthetic-message', sender: 'sender@example.org', subject: 'Synthetic scan', body: 'Transcribe the image.' };
const artifact = { id: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222', mediaType: 'image/png', size: 10, width: 2, height: 2, sha256: 'a'.repeat(64), expiresAt: 2000, source: { messageId: mail.id, attachmentId: 'synthetic-image' } };
const limits = { context_tokens: 16384, output_tokens: 2048 };

test('durable context contains references and provenance with fixed image context reservation', () => {
  const messages = createContext(mail, 'Trusted recipe.', [], limits, { artifacts: [artifact], imageContextTokens: 8192 });
  assert.equal(messages[1].content[1].type, 'image-reference');
  assert.deepEqual(messages[1].content[1].artifact, artifact);
  assert.equal(contextFits(messages, new Map(), limits, { imageContextTokens: 8192 }), true);
  assert.equal(contextFits(messages, new Map(), limits), false);
  assert.equal(contextFits(messages, new Map(), { ...limits, context_tokens: 9000 }, { imageContextTokens: 8192 }), false);
  assert.equal(createContext(mail, 'Trusted recipe.', [], { ...limits, context_tokens: 9000 }, { artifacts: [artifact], imageContextTokens: 8192 }), null);
  assert.ok(!JSON.stringify(messages).includes('base64'));
});

test('hydration verifies only current image handles and leaves durable context unchanged', async () => {
  const messages = createContext(mail, 'Trusted recipe.', [], limits, { artifacts: [artifact], imageContextTokens: 8192 });
  const before = structuredClone(messages), calls = [], bytes = Buffer.from('synthetic');
  const hydrated = await hydrateContext(messages, { read: async handle => { calls.push(handle); return bytes; } });
  assert.deepEqual(messages, before); assert.equal(calls.length, 1); assert.deepEqual(calls[0], artifact);
  assert.equal(hydrated[1].content[1].type, 'file'); assert.equal(hydrated[1].content[1].mediaType, 'image/png');
  assert.deepEqual(hydrated[1].content[1].data, { type: 'data', data: bytes });
});

test('historical documents, cross-message references and URL or byte-backed durable parts are not imported', async () => {
  const history = [{ mail: { ...mail, attachments: true, body: 'Historical private scan body' }, reply: 'Historical extracted text' }];
  const messages = createContext(mail, 'Recipe', history, limits, { artifacts: [artifact], imageContextTokens: 8192 });
  assert.equal(messages.length, 2); assert.ok(!JSON.stringify(messages).includes('Historical'));
  assert.throws(() => createContext(mail, 'Recipe', [], limits, { artifacts: [{ ...artifact, source: { ...artifact.source, messageId: 'other-message' } }], imageContextTokens: 8192 }), ImageError);
  for (const part of [{ type: 'image', image: new URL('https://example.org/private') }, { type: 'file', mediaType: 'image/png', data: Buffer.from('persisted') }]) {
    const unsafe = [{ role: 'user', content: [part] }];
    assert.equal(contextFits(unsafe, new Map(), limits, { imageContextTokens: 8192 }), false);
    await assert.rejects(hydrateContext(unsafe, { read: async () => { throw new Error('Must not read'); } }), ImageError);
  }
});

test('missing, expired or cancelled artifacts cannot produce a model request', async () => {
  const messages = createContext(mail, 'Recipe', [], limits, { artifacts: [artifact], imageContextTokens: 8192 });
  let reads = 0;
  await assert.rejects(hydrateContext(messages, { read: async () => { reads++; throw new ImageError('IMAGE_EXPIRED'); } }), ImageError);
  assert.equal(reads, 1);
  await assert.rejects(hydrateContext(messages, { read: async () => { reads++; return Buffer.from('bytes'); } }, { signal: AbortSignal.abort() }), ImageError);
  assert.equal(reads, 1);
  const historical = [{ role: 'user', content: [{ type: 'image-reference', artifact }] }, { role: 'user', content: 'Current request' }];
  await assert.rejects(hydrateContext(historical, { read: async () => { reads++; } }), ImageError); assert.equal(reads, 1);
});

test('ordinary text contexts preserve their existing budget and wire shape', async () => {
  const messages = createContext(mail, 'Recipe', [], limits);
  assert.equal(typeof messages[1].content, 'string'); assert.equal(contextFits(messages, new Map(), limits), true);
  assert.deepEqual(await hydrateContext(messages), messages);
});
