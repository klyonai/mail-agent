import assert from 'node:assert/strict';
import test from 'node:test';
import { createModel } from '../src/model.mjs';
import { classifyDiagnostic } from '../src/diagnostics-errors.mjs';

function response(message) {
  return new Response(JSON.stringify({
    id: 'completion-image', object: 'chat.completion', created: 1, model: 'configured-model',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 3 },
  }), { headers: { 'content-type': 'application/json' } });
}

test('configured adapter serializes byte-backed PNG and JPEG as exact user data URLs with no image fetch', async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0xff, 0xd9]);
  const requests = [];
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return response({ role: 'assistant', content: 'A safe description.' });
    },
  });

  await model.step({ messages: [
    { role: 'system', content: 'Trusted operator rules.' },
    { role: 'user', content: [
      { type: 'text', text: 'Describe these untrusted images.' },
      { type: 'file', data: png, mediaType: 'image/png' },
      { type: 'file', data: jpeg, mediaType: 'image/jpeg' },
    ] },
  ], maxOutputTokens: 32 });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://models.example.test/v1/chat/completions');
  assert.deepEqual(requests[0].body.messages[0], { role: 'system', content: 'Trusted operator rules.' });
  const parts = requests[0].body.messages[1].content;
  assert.equal(parts[0].text, 'Describe these untrusted images.');
  assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(png).toString('base64')}` } });
  assert.deepEqual(parts[2], { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` } });
  assert.deepEqual(requests.map(request => request.url), ['https://models.example.test/v1/chat/completions']);
});

test('provider rejection for image input has stable sanitized unsupported diagnostic', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async () => new Response('private prompt and provider detail', { status: 400 }),
  });
  await assert.rejects(model.step({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'private prompt' },
    { type: 'file', data: Uint8Array.from([1, 2, 3]), mediaType: 'image/png' },
  ] }], maxOutputTokens: 32 }), error => {
    assert.equal(classifyDiagnostic(error), 'model-unsupported');
    assert.equal(error.message, 'Model request failed');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /private prompt|provider detail/);
    return true;
  });
});

test('malformed oversized model response is rejected with a safe bounded-input diagnostic', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async () => new Response(null, { headers: { 'content-length': '8000001' } }),
  });
  await assert.rejects(model.step({ messages: [{ role: 'user', content: [
    { type: 'file', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' },
  ] }], maxOutputTokens: 32 }), error => {
    assert.equal(classifyDiagnostic(error), 'invalid-response');
    assert.equal(error.message, 'Model request failed');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('image inference cancellation stays bounded and reports only a safe diagnostic', async () => {
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model', timeout_ms: 2_000 }, {
    fetchImpl: async () => {
      requestStarted();
      return new Promise(() => {});
    },
  });
  const pending = model.step({ messages: [{ role: 'user', content: [
    { type: 'file', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' },
  ] }], maxOutputTokens: 32, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(classifyDiagnostic(error), 'cancelled');
    assert.equal(error.message, 'Model request cancelled');
    assert.equal(error.cause, undefined);
    return true;
  });
});
