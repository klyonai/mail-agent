import assert from 'node:assert/strict';
import test from 'node:test';
import { createModel } from '../src/model.mjs';
import { classifyDiagnostic } from '../src/diagnostics-errors.mjs';

function response(message, usage = { prompt_tokens: 12, completion_tokens: 4 }) {
  return new Response(JSON.stringify({
    id: 'completion-1', object: 'chat.completion', created: 1, model: 'configured-model',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage,
  }), { headers: { 'content-type': 'application/json' } });
}

test('model calls the configured compatible endpoint once and normalizes a reply', async () => {
  const requests = [];
  const model = createModel({ base_url: 'https://inference.example.test/v1', name: 'configured-model' }, {
    apiKey: 'synthetic-key',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
      return response({ role: 'assistant', content: 'Hello.' });
    },
  });
  const result = await model.step({ messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 32 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://inference.example.test/v1/chat/completions');
  assert.equal(requests[0].body.model, 'configured-model');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer synthetic-key');
  assert.deepEqual(result, { text: 'Hello.', toolCalls: [], usage: { inputTokens: 12, outputTokens: 4 } });
});

test('tool names round-trip without execution or another model request', async () => {
  let calls = 0;
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      const toolName = body.tools[0].function.name;
      assert.match(toolName, /^[A-Za-z0-9_-]+$/);
      return response({ role: 'assistant', content: null, tool_calls: [{
        id: 'call-1', type: 'function', function: { name: toolName, arguments: '{"query":"manual"}' },
      }] });
    },
  });
  const result = await model.step({ messages: [{ role: 'user', content: 'Search' }], tools: new Map([
    ['documents.search', { description: 'Search documents', inputSchema: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
    } }],
  ]), maxOutputTokens: 32 });
  assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'documents.search', args: { query: 'manual' } }]);
  assert.equal(calls, 1);
});

test('trusted runtime instructions use the SDK instructions field and reach the provider as system context', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.messages, [{ role: 'system', content: 'Trusted operator rules.' }, { role: 'user', content: 'Untrusted email.' }]);
      return response({ role: 'assistant', content: 'Reply.' });
    }
  });
  assert.equal((await model.step({ messages: [{ role: 'system', content: 'Trusted operator rules.' }, { role: 'user', content: 'Untrusted email.' }], maxOutputTokens: 32 })).text, 'Reply.');
});

test('tool history uses the same provider name as the tool definition', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.messages[1].tool_calls[0].function.name, body.tools[0].function.name);
      return response({ role: 'assistant', content: 'Found it.' });
    },
  });
  await model.step({ messages: [
    { role: 'user', content: 'Search' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'documents.search', input: { query: 'manual' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'documents.search', output: { type: 'json', value: { hits: 1 } } }] },
  ], tools: { 'documents.search': { description: 'Search', inputSchema: { type: 'object' } } }, maxOutputTokens: 32 });
});

test('model failure has no retry and does not disclose provider response', async () => {
  let calls = 0;
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async () => { calls += 1; return new Response('private provider detail', { status: 500 }); },
  });
  await assert.rejects(model.step({ messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 32 }), error => {
    assert.match(error.message, /Model request failed/);
    assert.equal(classifyDiagnostic(error), 'dependency-failed');
    assert.doesNotMatch(String(error), /private provider detail/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test('model HTTP failures receive stable safe diagnostic codes', async () => {
  for (const [status, expected] of [[401, 'credential'], [403, 'access-denied'], [404, 'model-unsupported'], [429, 'throttled'], [503, 'dependency-failed']]) {
    const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
      fetchImpl: async () => new Response('private token and prompt', { status }),
    });
    await assert.rejects(model.step({ messages: [{ role: 'user', content: 'private prompt' }], maxOutputTokens: 32 }), error => {
      assert.equal(classifyDiagnostic(error), expected);
      assert.doesNotMatch(String(error), /private token|private prompt/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('diagnostic classifier returns only whitelisted codes and safely bounds cause traversal', () => {
  const providerError = Object.assign(new Error('private body prompt token'), { code: 'ENOTFOUND' });
  assert.equal(classifyDiagnostic({ cause: providerError }), 'dns');
  assert.equal(classifyDiagnostic({ diagnosticCode: 'private-body', message: 'secret' }), 'dependency-failed');
  assert.doesNotMatch(classifyDiagnostic(providerError), /private|prompt|token/);
  const cyclic = new Error('secret');
  cyclic.cause = cyclic;
  assert.equal(classifyDiagnostic(cyclic), 'dependency-failed');
  let deep = { code: 'ETIMEDOUT' };
  for (let index = 0; index < 6; index += 1) deep = { cause: deep };
  assert.equal(classifyDiagnostic(deep), 'dependency-failed');
});

test('model prevents redirected inference requests', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model' }, {
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return response({ role: 'assistant', content: 'Hi' });
    },
  });
  await model.step({ messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 32 });
});

test('model request timeout bounds a fetcher that ignores cancellation', async () => {
  const model = createModel({ base_url: 'https://models.example.test/v1', name: 'configured-model', timeout_ms: 10 }, {
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(model.step({ messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 32 }), error => {
    assert.match(error.message, /Model request timed out/);
    assert.equal(classifyDiagnostic(error), 'timeout');
    return true;
  });
});

test('only explicitly enabled local HTTP inference is permitted', () => {
  assert.throws(() => createModel({ base_url: 'http://external.example.test/v1', name: 'm', allow_insecure: true }), /Model endpoint requires HTTPS/);
  assert.doesNotThrow(() => createModel({ base_url: 'http://127.0.0.1:3000/v1', name: 'm', allow_insecure: true }));
});

test('model rejects oversized responses before allowing provider contents into the runtime', async () => {
  for (const large of [
    () => new Response('private detail', { headers: { 'content-length': '8000001' } }),
    () => new Response('x'.repeat(8000001))
  ]) {
    const model = createModel({ base_url: 'https://models.example.test/v1', name: 'm' }, { fetchImpl: async () => large() });
    await assert.rejects(model.step({ messages: [{ role: 'user', content: 'Hi' }], maxOutputTokens: 32 }), /^Error: Model request failed$/);
  }
});
