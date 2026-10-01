import { createHash } from 'node:crypto';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { TransformStream } from 'node:stream/web';
import { classifyDiagnostic, diagnosticError } from './diagnostics-errors.mjs';

const MAX_RESPONSE_BYTES = 8_000_000;

function boundedResponse(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw diagnosticError('Model response exceeded limit', 'invalid-response');
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw diagnosticError('Model response exceeded limit', 'invalid-response');
    controller.enqueue(chunk);
  } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function providerName(name) {
  return `t_${createHash('sha256').update(name).digest('base64url')}`;
}

function messageNames(messages) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((part) => {
      if (part.type !== 'tool-call' && part.type !== 'tool-result') return part;
      return { ...part, toolName: providerName(part.toolName) };
    }) };
  });
}

function providerTools(tools) {
  const entries = tools instanceof Map ? [...tools] : Object.entries(tools ?? {});
  const names = new Map();
  const definitions = {};
  for (const [name, definition] of entries) {
    const safeName = providerName(name);
    if (names.has(safeName)) throw new Error('Duplicate model tool name');
    names.set(safeName, name);
    definitions[safeName] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
    });
  }
  return { names, definitions };
}

function endpointFetch(config, fetchImpl) {
  const endpoint = `${config.base_url.replace(/\/$/, '')}/chat/completions`;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint) throw diagnosticError('Unconfigured model endpoint', 'endpoint-policy');
    const response = await fetchImpl(input, { ...init, redirect: 'error' });
    validateModelResponse(response);
    return boundedResponse(response);
  };
}

function modelFailureCode(status) {
  if (status === 401) return 'credential';
  if (status === 403) return 'access-denied';
  if (status === 429) return 'throttled';
  if (status === 408) return 'timeout';
  if (status === 404 || status === 400) return 'model-unsupported';
  return 'dependency-failed';
}

function validateModelResponse(response) {
  if (response.redirected) {
    void response.body?.cancel().catch(() => {});
    throw diagnosticError('Model redirect rejected', 'endpoint-policy');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw diagnosticError('Model request failed', modelFailureCode(response.status));
  }
}

function normalizedResult(result, names) {
  const toolCalls = result.toolCalls.map((call) => {
    const name = names.get(call.toolName);
    if (!name) throw new Error('Unknown model tool');
    return { id: call.toolCallId, name, args: call.input };
  });
  return { text: result.text, toolCalls, usage: {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  } };
}

async function boundedInference(operation, timeout, signal) {
  const controller = new AbortController();
  let timer;
  let abort;
  const cancellation = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(diagnosticError('Model request cancelled', 'cancelled')); };
    timer = setTimeout(() => {
      controller.abort();
      reject(diagnosticError('Model request timed out', 'timeout'));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  const work = signal?.aborted ? cancellation : Promise.resolve().then(() => operation(controller.signal));
  try { return await Promise.race([work, cancellation]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function secureEndpoint(config) {
  let url;
  try { url = new URL(config.base_url); }
  catch { throw diagnosticError('Invalid model endpoint', 'endpoint-policy'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(config.allow_insecure && local && url.protocol === 'http:')) {
    throw diagnosticError('Model endpoint requires HTTPS', 'endpoint-policy');
  }
  if (url.username || url.password || url.search || url.hash) throw diagnosticError('Invalid model endpoint', 'endpoint-policy');
}

/** An inference boundary: one provider request; the caller owns all effects. */
export function createModel(config, { apiKey, fetchImpl = globalThis.fetch } = {}) {
  secureEndpoint(config);
  const provider = createOpenAICompatible({
    name: 'mail-agent-compatible', baseURL: config.base_url, apiKey,
    fetch: endpointFetch(config, fetchImpl),
  });
  return {
    async step({ messages, tools, maxOutputTokens, signal }) {
      const { names, definitions } = providerTools(tools);
      try {
        const result = await boundedInference((requestSignal) => generateText({
          model: provider.chatModel(config.name),
          instructions: messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || undefined,
          messages: messageNames(messages.filter(message => message.role !== 'system')),
          tools: definitions,
          maxOutputTokens,
          maxRetries: 0,
          stopWhen: stepCountIs(1),
          abortSignal: requestSignal,
          experimental_telemetry: { isEnabled: false },
        }), config.timeout_ms ?? 30_000, signal);
        return normalizedResult(result, names);
      } catch (error) {
        const code = signal?.aborted ? 'cancelled' : classifyDiagnostic(error);
        const message = code === 'timeout' ? 'Model request timed out'
          : code === 'cancelled' ? 'Model request cancelled' : 'Model request failed';
        throw diagnosticError(message, code);
      }
    },
  };
}
