import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQualificationArguments, runEndpointQualification } from '../scripts/endpoint-qualification.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const config = (tools = false) => ({ api: 'chat-completions', base_url: 'https://model.example.test/v1',
  name: 'synthetic-model', api_key_env: 'MODEL_SECRET', capabilities: { tools, images: false, pdf: false }, timeout_ms: 100 });
const answers = ['95', 'Guten Tag', '{"title":"Synthetic record","year":2026}', 'Which document should I summarize?', '95'];

function completion(content, { model = 'synthetic-model', toolCalls } = {}) {
  return new Response(JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
  { headers: { 'content-type': 'application/json' } });
}

function fetchScript({ values = answers, model = 'synthetic-model', incorrectTool = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body, headers: new Headers(init.headers), redirect: init.redirect });
    if (requests.length <= 5) return completion(values[requests.length - 1], { model });
    if (requests.length === 6) return completion(null, { model, toolCalls: [{ id: 'probe-call', type: 'function',
      function: { name: body.tools[0].function.name, arguments: JSON.stringify({ marker: incorrectTool ? 'wrong' : 'qualification' }) } }] });
    return completion('SYNTHETIC NOTE', { model });
  };
  return { requests, fetchImpl };
}

const options = (probeTools = false) => ({ probeTools, timeoutSeconds: 10 });

test('qualification arguments require explicit live inference and bound the suite', () => {
  assert.deepEqual(parseQualificationArguments(['--config', './agent.yaml', '--run']),
    { config: './agent.yaml', run: true, probeTools: false, timeoutSeconds: 120, report: undefined });
  assert.equal(parseQualificationArguments(['--config', './agent.yaml', '--run', '--probe-tools']).probeTools, true);
  for (const args of [[], ['--config', './agent.yaml'], ['--run'],
    ['--config', './agent.yaml', '--run', '--timeout-seconds', '0'],
    ['--config', './agent.yaml', '--run', '--timeout-seconds', '301'],
    ['--config', './agent.yaml', '--run', '--unknown']]) assert.throws(() => parseQualificationArguments(args));
});

test('reference text suite uses actual SDK, only model credentials, bounded exact requests and redacted evidence', async () => {
  const fx = fetchScript();
  const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'private-model-key' }, fetchImpl: fx.fetchImpl });
  assert.equal(report.passed, true);
  assert.equal(report.qualificationComplete, false);
  assert.equal(report.referenceRecipe, 'synthetic-text-v1');
  assert.equal(report.requests, 5);
  assert.equal(report.externalEffects, false);
  assert.equal(report.toolExecutionCount, 0);
  assert.equal(report.aliasIdentity.status, 'pass');
  assert.equal(report.aliasIdentity.weightsIdentityVerified, false);
  assert.deepEqual(report.aliasIdentity.observedModelHashes, [hash('synthetic-model')]);
  assert.equal(report.capabilities.tools.status, 'not-checked');
  assert.equal(report.capabilities.images.status, 'unsupported');
  assert.equal(report.capabilities.pdf.status, 'unsupported');
  assert.equal(report.cases.filter(item => item.status === 'pass').length, 5);
  for (const request of fx.requests) {
    assert.equal(request.url, 'https://model.example.test/v1/chat/completions');
    assert.equal(request.headers.get('authorization'), 'Bearer private-model-key');
    assert.equal(request.body.model, 'synthetic-model');
    assert.ok(request.body.max_tokens <= 256);
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.tools, undefined);
    assert.ok(request.body.messages[0].role === 'system');
  }
  assert.doesNotMatch(JSON.stringify(report), /private-model-key|model\.example|Synthetic record|Guten Tag|Which document/);
});

test('explicit tool proposal and hostile result continuation are exercised without tool execution', async () => {
  const fx = fetchScript();
  const report = await runEndpointQualification(config(true), options(true), { env: { MODEL_SECRET: 'key' }, fetchImpl: fx.fetchImpl });
  assert.equal(report.passed, true);
  assert.equal(report.requests, 7);
  assert.equal(report.capabilities.tools.status, 'pass');
  assert.equal(report.toolExecutionCount, 0);
  assert.deepEqual(report.cases.slice(-2).map(item => item.id), ['tool-proposal', 'tool-result-injection']);
  const second = fx.requests[6].body.messages;
  assert.match(JSON.stringify(second.filter(item => item.role === 'tool')), /UNTRUSTED SYNTHETIC RESULT/);
  assert.doesNotMatch(JSON.stringify(second.filter(item => item.role === 'system')), /UNTRUSTED SYNTHETIC RESULT/);
  assert.equal(fx.requests[5].body.tools.length, 1);
  assert.equal(second[2].tool_calls[0].function.name, fx.requests[6].body.tools[0].function.name);
});

test('tool capability declaration, secret and transport failures are rejected before a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  const rejected = [
    [config(), options(true), { MODEL_SECRET: 'key' }],
    [config(), options(), {}],
    [{ ...config(), base_url: 'http://external.example.test/v1', allow_insecure: true }, options(), { MODEL_SECRET: 'key' }],
  ];
  for (const [model, opts, env] of rejected) await assert.rejects(runEndpointQualification(model, opts, { env, fetchImpl }));
  assert.equal(calls, 0);
});

test('incorrect text/schema and malformed tool proposal visibly fail their cases', async () => {
  const fx = fetchScript({ values: ['94', 'Guten Tag', '{"title":"Synthetic record","year":2026,"extra":true}',
    'Which document should I summarize?', '13'], incorrectTool: true });
  const report = await runEndpointQualification(config(true), options(true), { env: { MODEL_SECRET: 'key' }, fetchImpl: fx.fetchImpl });
  assert.equal(report.passed, false);
  assert.equal(report.requests, 6);
  assert.deepEqual(report.cases.filter(item => item.status === 'fail').map(item => item.id),
    ['arithmetic', 'structured-extraction', 'quoted-injection', 'tool-proposal']);
  assert.equal(report.cases.at(-1).status, 'not-checked');
  assert.equal(report.cases.at(-1).code, 'proposal-not-confirmed');
  assert.equal(report.capabilities.tools.status, 'fail');
});

test('missing, mismatched and mixed response aliases fail identity without exposing aliases', async () => {
  for (const alias of ['', 'private-upstream-alias']) {
    const fx = fetchScript({ model: alias });
    const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' }, fetchImpl: fx.fetchImpl });
    assert.equal(report.passed, false);
    assert.equal(report.aliasIdentity.status, 'fail');
    assert.equal(report.aliasIdentity.code, alias ? 'model-alias-mismatch' : 'model-alias-missing');
    assert.equal(report.aliasIdentity.weightsIdentityVerified, false);
    assert.doesNotMatch(JSON.stringify(report), /private-upstream-alias/);
  }
  let calls = 0;
  const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' },
    fetchImpl: async () => completion(answers[calls], { model: calls++ ? 'private-other-alias' : 'synthetic-model' }) });
  assert.equal(report.aliasIdentity.code, 'model-alias-mismatch');
  assert.equal(report.aliasIdentity.observedModelHashes.length, 2);
});

test('dependency failures stop further requests and preserve only fixed diagnostic evidence', async () => {
  for (const [status, code] of [[401, 'credential'], [403, 'access-denied'], [400, 'model-unsupported'],
    [429, 'throttled'], [503, 'dependency-failed']]) {
    let calls = 0;
    const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' },
      fetchImpl: async () => { calls++; return new Response('private-provider-body-and-secret', { status }); } });
    assert.equal(calls, 1);
    assert.equal(report.passed, false);
    assert.equal(report.cases[0].code, code);
    assert.equal(report.cases[1].status, 'not-checked');
    assert.doesNotMatch(JSON.stringify(report), /private-provider/);
  }
});

test('deadline and cancellation bound unresponsive fetchers without further calls', async () => {
  let calls = 0;
  const report = await runEndpointQualification({ ...config(), timeout_ms: 10 }, options(), { env: { MODEL_SECRET: 'key' },
    fetchImpl: async () => { calls++; return new Promise(() => {}); } });
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].code, 'timeout');
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' }, signal: controller.signal,
    fetchImpl: async () => { calls++; throw new Error('should not reach fetch'); } });
  assert.equal(cancelled.cases[0].code, 'cancelled');
  assert.equal(calls, 1);
});

test('oversized or invalid JSON responses stay bounded and sanitized', async () => {
  for (const makeResponse of [
    () => new Response('private invalid json'),
    () => new Response('private body', { headers: { 'content-length': '8000001' } }),
    () => new Response('x'.repeat(8_000_001)),
  ]) {
    const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' }, fetchImpl: async () => makeResponse() });
    assert.equal(report.passed, false);
    assert.equal(report.cases[0].code, 'invalid-response');
    assert.doesNotMatch(JSON.stringify(report), /private body|private invalid/);
  }
});

test('tool proposals cannot include prose claiming an unconfirmed effect', async () => {
  const fx = fetchScript();
  const report = await runEndpointQualification(config(true), options(true), { env: { MODEL_SECRET: 'key' },
    fetchImpl: async (url, init) => {
      const result = await fx.fetchImpl(url, init);
      if (fx.requests.length !== 6) return result;
      const body = await result.json();
      body.choices[0].message.content = 'I already wrote your note.';
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal(report.passed, false);
  assert.equal(report.requests, 6);
  assert.equal(report.cases[5].status, 'fail');
  assert.equal(report.cases[6].status, 'not-checked');
});

test('text overflow cannot pass by surrounding an expected answer with whitespace', async () => {
  const fx = fetchScript({ values: [`${' '.repeat(4096)}95`, ...answers.slice(1)] });
  const report = await runEndpointQualification(config(), options(), { env: { MODEL_SECRET: 'key' }, fetchImpl: fx.fetchImpl });
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].status, 'fail');
  assert.equal(report.cases[1].status, 'pass');
});

test('CLI reserves private evidence before inference and refuses overwrite without disclosing input', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mail-agent-endpoint-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/endpoint-qualification.mjs', import.meta.url));
  const bundle = fileURLToPath(new URL('../examples/text-inbox/agent.yaml', import.meta.url));
  const filename = join(root, 'report.json');
  const exec = promisify(execFile);
  const run = args => exec(process.execPath, [script, ...args], { env: {}, timeout: 10_000, maxBuffer: 4096 });
  await assert.rejects(run(['--config', bundle, '--run', '--report', filename]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stderr).error, 'model-secret-missing');
    return true;
  });
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const first = await readFile(filename, 'utf8');
  assert.equal(JSON.parse(first).error, 'model-secret-missing');
  await assert.rejects(run(['--config', '/unavailable-private-path', '--run', '--report', filename]));
  assert.equal(await readFile(filename, 'utf8'), first);
  const noRun = join(root, 'must-not-exist.json');
  await assert.rejects(run(['--config', bundle, '--report', noRun]), error => {
    assert.equal(JSON.parse(error.stderr).error, 'explicit-config-and-run-required');
    return true;
  });
  await assert.rejects(stat(noRun), { code: 'ENOENT' });
  const linked = join(root, 'existing.txt');
  await writeFile(linked, 'synthetic-private-content');
  await assert.rejects(run(['--config', bundle, '--run', '--report', linked]));
  assert.equal(await readFile(linked, 'utf8'), 'synthetic-private-content');
});
