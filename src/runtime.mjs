import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {setImmediate as yieldControl} from 'node:timers/promises';
import { openStore } from './store.mjs';
import { admitted, maySend, permittedTool, policyDigest, digest, address } from './policy.mjs';
import { createContext, contextFits, hydrateContext, appendModelStep, appendToolResult } from './context.mjs';
import { createModel } from './model.mjs';
import { createMcp } from './mcp.mjs';
import { createGraph } from './graph.mjs';
import { loadConfig } from './config.mjs';
import { classifyRequest, UNSUPPORTED_REPLY } from './runtime-content.mjs';
import {createOperations, pageOptions, encodeCursor} from './runtime-operations.mjs';
import {diagnosticError} from './diagnostics-errors.mjs';
import {mailboxIdentity} from './state-identity.mjs';
import {recoveryState,requireRecovered} from './recovery-hold.mjs';
import {createDocumentWorkflow,DOCUMENT_UNSUPPORTED_REPLY,artifactFailure,unsupportedDocumentInput} from './runtime-documents.mjs';
import { requireDomainApproval, domainInvocationContext, invocationOptions } from './runtime-domain.mjs';
import { recordDomainIntent, inspectRecordsIntent, reconcileRecords } from './runtime-records.mjs';

const terminal = new Set(['completed', 'failed', 'ignored', 'uncertain']);
const safeResult = run => ({ runId: run.id, status: run.status, reply: run.preview ? run.reply : undefined });

function normalizeMessage(message) {
  for (const key of ['id', 'conversationId', 'sender', 'body', 'subject']) {
    if (typeof message[key] !== 'string' || message[key].length > 4_000_000) throw new Error('Invalid normalized mail.');
  }
  if (!message.id || !message.conversationId || !Array.isArray(message.to)) throw new Error('Invalid normalized mail.');
  return { ...message, sender: address(message.sender), attachments: Array.isArray(message.attachments) ? message.attachments.length > 0 : Boolean(message.attachments) };
}

function pages(read, apply) {
  let after;
  do {
    const page = read(after);
    for (const item of page.items) apply(item);
    after = page.nextCursor;
  } while (after);
}

function conservativeRecovery(run) {
  return terminal.has(run.status) && ['sent', 'fenced', 'skip'].includes(run.recovery?.outcome);
}

function safeReservation(run) {
  if (!run.budget || !run.activeOperation) return false;
  const numeric = ['modelCalls', 'toolCalls', 'activeMs'].every(field => Number.isSafeInteger(run.budget[field]) && run.budget[field] >= 0);
  const reservedMs = run.activeOperation.reservedMs;
  return numeric && Number.isSafeInteger(reservedMs) && reservedMs >= 0 && Number.isSafeInteger(run.budget.activeMs + reservedMs);
}

function recoverConservative(store, run) {
  // Keep unknown historical counters and reservations unknown. These decisions cannot resume execution.
  if (!safeReservation(run)) return;
  run.budget.activeMs += run.activeOperation.reservedMs;
  delete run.activeOperation;
  store.saveRun(run);
}

function recover(store) {
  if (recoveryState(store)) return;
  pages(after => store.executingActionsBatch({limit:100, after}), action => {
    action.state = action.effect === 'write' ? 'uncertain' : 'pending';
    store.saveAction(action);
  });
  pages(after => store.recoveryBatch({limit:100, after}), run => {
    if (conservativeRecovery(run)) { recoverConservative(store, run); return; }
    if (run.activeOperation) {
      run.budget.activeMs += run.activeOperation.reservedMs;
      delete run.activeOperation;
    }
    if (run.status === 'sending') { run.status = 'uncertain'; run.uncertainty = {kind:'send'}; }
    if (run.status === 'running') run.status = 'queued';
    const uncertain = store.findUncertainAction(run.id);
    if (uncertain) {run.status='uncertain'; run.uncertainty={kind:'tool',key:uncertain.key};}
    store.saveRun(run);
  });
}

function operator(actor, reason) {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(actor ?? '') || !reason?.trim() || reason.length > 2048) throw new Error('An operator identity and reason are required.');
}

export async function createRuntime(options) {
  const { config, root, instructions, hash, mode, filename, clock = Date.now, env = process.env } = options;
  if (mode === 'live' && !config.mailbox.sender_authentication?.transport_headers_verified) throw new Error('Live intake requires verified mail transport authentication.');
  const previewRoot = mode === 'preview' ? await mkdtemp(join(tmpdir(), 'mail-agent-preview-')) : null;
  const stateRoot = previewRoot ?? resolve(root, config.state_root);
  let store;
  try { store = openStore(stateRoot, { identity: mailboxIdentity(config), clock }); }
  catch (error) {
    if (mode !== 'operator' || !/owned or locked/.test(error.message)) throw error;
    const { connectControl } = await import('./control.mjs');
    return connectControl(stateRoot);
  }
  recover(store);
  let current = { config, instructions, hash };
  let model = options.model, mail = options.mail, mcp = options.mcp;
  let tail = Promise.resolve(), stopped = false, running = false, control, closedStatus, closedHealth, stopPromise;
  const controller = new AbortController();
  const operations = createOperations(store, {clock, pollSeconds:config.mailbox.poll_seconds ?? 30});
  const documents=createDocumentWorkflow({config,stateRoot,store,clock});
  const bindingFields = value => [value.schema_version,value.documents,value.mailbox, value.model, value.mcp, value.state_root, value.limits, value.retention];
  const bindings = digest(bindingFields(config));

  async function latest() {
    try {
      if (!filename || mode === 'preview') return current;
      const loaded = await loadConfig(filename, {env});
      if (mailboxIdentity(loaded.config) !== mailboxIdentity(config)) throw diagnosticError('Mailbox identity changed; restart required.', 'configuration');
      if (digest(bindingFields(loaded.config)) !== bindings) throw diagnosticError('Runtime configuration changed; restart required.', 'configuration');
      current = loaded;
      operations.succeeded('configuration');
      return loaded;
    } catch(error) {operations.failed('configuration', error); throw error;}
  }

  async function boundary(name, callback) {
    try {const result = await callback(); operations.succeeded(name); return result;}
    catch(error) {
      if (name === 'mailbox') operations.defer(error);
      operations.failed(name,error); throw error;
    }
  }

  function isDeferred(error) {return error.deferred === true || error.retryNotBefore > clock();}
  function shouldDefer(error) {return controller.signal.aborted || isDeferred(error);}

  function requireMailboxWindow() {
    const retryNotBefore = operations.sync().retryNotBefore;
    if (retryNotBefore > clock()) throw Object.assign(diagnosticError('Mailbox provider wait is active.', 'throttled'), {deferred:true,retryNotBefore});
  }

  function mailboxRead(run, callback) {
    requireMailboxWindow();
    return boundary('mailbox', () => measured(run, callback));
  }

  function exclusive(callback) {
    const result = tail.then(callback);
    tail = result.catch(() => {});
    return result;
  }

  async function modelClient() {
    model ??= createModel(config.model, { apiKey: env[config.model.api_key_env], fetchImpl: options.fetchImpl });
    return model;
  }
  async function mailClient() {
    mail ??= createGraph(config.mailbox, { env, fetchImpl: options.fetchImpl, clock,
      onRetryNotBefore: retryNotBefore => operations.defer({retryNotBefore}) });
    return mail;
  }
  async function mcpClient() {
    mcp ??= await createMcp(config.mcp ?? {}, { env, root, clock });
    return mcp;
  }

  function audit(event, run, details = {}) { store.audit(event, run, details); }
  function finish(run, status) { run.status = status; store.saveRun(run); return safeResult(run); }
  function ready(run, text) { run.reply = text; run.status = 'ready_to_send'; store.saveRun(run); }

  function queue(message) {
    const normalized = normalizeMessage(message);
    const key = digest([config.id, normalized.id]);
    const existing = store.byMessage(key);
    if (existing) return existing;
    const allowed = admitted(normalized, current.config);
    const summary = store.summary();
    const queued = summary.backlog + summary.approvals;
    if (allowed && queued >= config.limits.queue_messages) throw new Error('Queue capacity reached.');
    const sequence = Number(store.getMeta('queue_sequence') ?? 0) + 1;
    store.setMeta('queue_sequence', String(sequence));
    const run = {
      id: randomUUID(), messageKey: key, conversationKey: digest(normalized.conversationId),
      status: allowed ? 'queued' : 'ignored', createdAt: clock(), sequence,
      mail: allowed ? normalized : undefined, instructionSnapshot: current.instructions,
      configHash: current.hash, budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 },
      messages: null, pending: [], preview: mode === 'preview'
    };
    store.saveRun(run);
    audit(allowed ? 'admitted' : 'ignored', run, { actor: digest(normalized.sender) });
    return run;
  }

  async function measured(run, callback) {
    const remaining = config.limits.run_seconds * 1000 - run.budget.activeMs;
    if (remaining <= 0) throw diagnosticError('Run budget exhausted.', 'timeout');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))]);
    const started = clock();
    run.activeOperation = { reservedMs: remaining };
    store.saveRun(run);
    let listener;
    try {
      if (signal.aborted) throw new Error('Run cancelled.');
      const aborted = new Promise((_, reject) => {
        listener = () => reject(diagnosticError('Run cancelled or timed out.', controller.signal.aborted ? 'cancelled' : 'timeout'));
        if (signal.aborted) listener(); else signal.addEventListener('abort', listener, { once: true });
      });
      return await Promise.race([callback(signal), aborted]);
    } finally {
      signal.removeEventListener('abort', listener);
      run.budget.activeMs += Math.max(0, clock() - started);
      delete run.activeOperation;
      store.saveRun(run);
    }
  }

  async function authority(run, { sending = false } = {}) {
    const loaded = await latest();
    if (!admitted(run.mail, loaded.config)) throw new Error('Sender is no longer permitted.');
    if (sending && !maySend(run, loaded.config)) throw new Error('Recipient is not permitted.');
    return loaded.config;
  }

  async function freshEnvelope(run) {
    const client = await mailClient();
    if (!client.getMessage) return;
    const fresh = normalizeMessage(await mailboxRead(run, signal => client.getMessage(run.mail.id, {signal})));
    if (address(fresh.sender) !== address(run.mail.sender) || fresh.conversationId !== run.mail.conversationId) throw new Error('Message envelope changed.');
    run.mail = { ...fresh, body: run.mail.body, subject: run.mail.subject };
  }

  async function toolsFor(run) {
    const active = await authority(run);
    await verifyImages(run);
    const all = await boundary('mcp', () => measured(run, async signal => (await mcpClient()).listTools({signal})));
    const permitted = new Map();
    if (!active.model.capabilities.tools) return { all, permitted };
    for (const [name, tool] of all) if (active.policy.tools[name]) permitted.set(name, tool);
    return { all, permitted };
  }

  async function executeCall(run, call, all) {
    await freshEnvelope(run);
    const active = await authority(run);
    const policy = permittedTool(call, active, all.get(call.name));
    requireDomainApproval(active, call, policy);
    const key = digest([run.id, call.name, call.args]);
    let action = store.getAction(key);
    if (action?.state === 'completed') { appendToolResult(run, call, action.result); return true; }
    if (action?.state === 'uncertain') { run.uncertainty = { kind: 'tool', key }; finish(run, 'uncertain'); return false; }
    if (run.budget.toolCalls >= config.limits.tool_calls) { ready(run, 'The tool budget was exhausted. No additional action was attempted.'); return false; }
    if (policy.authorization === 'approval' && !approved(run, key, active)) {
      run.approval = { id: key, tool: call.name, args: call.args, policyHash: policyDigest(active), expiresAt: run.createdAt + config.retention.content_hours * 3600000 };
      finish(run, 'awaiting_approval');
      audit('approval-required', run, { target: key });
      return false;
    }
    await verifyImages(run);
    const context = domainInvocationContext(run, call, key, active, policy, clock);
    action = recordDomainIntent({ key, runId: run.id, effect: policy.effect, state: 'executing', tool: call.name }, context, call);
    run.budget.toolCalls++;
    store.transaction(() => { store.saveAction(action); store.saveRun(run); });
    try {
      const client = await mcpClient();
      action.result = await boundary('mcp', () => measured(run, signal => client.call(call.name, call.args, invocationOptions(signal, context))));
      action.state = 'completed';
      store.saveAction(action);
      appendToolResult(run, call, action.result);
      audit('action-completed', run, { target: key });
      return true;
    } catch {
      action.state = policy.effect === 'write' ? 'uncertain' : 'failed';
      store.saveAction(action);
      if (policy.effect === 'write') { run.uncertainty = { kind: 'tool', key }; finish(run, 'uncertain'); }
      else ready(run, 'The configured tool failed. No successful result is available.');
      audit('action-failed', run, { target: key, uncertain: policy.effect === 'write' });
      return false;
    }
  }

  function approved(run, key, active) {
    const grant = run.grants?.[key];
    return grant && grant.expiresAt > clock() && grant.policyHash === policyDigest(active) && active.policy.approvers.includes(grant.actor);
  }

  async function runPending(run, all) {
    while (run.pending.length) {
      const call = run.pending[0];
      try { if (!await executeCall(run, call, all)) return false; }
      catch(error) {
        if (isDeferred(error) || artifactFailure(error)) throw error;
        ready(run, 'The requested tool or its arguments are not permitted. No action was taken.'); return false;
      }
      run.pending.shift();
      store.saveRun(run);
    }
    return true;
  }

  function initializeContext(run) {
    if (run.messages) return;
    const history = store.recentContext({conversationKey:run.conversationKey, sender:run.mail.sender, excludeId:run.id, limit:8});
    run.messages = createContext(run.mail, run.instructionSnapshot, history, config.limits,documents.contextOptions(run));
    if (!run.messages) ready(run, 'This request is too large for the configured context budget. Please shorten it.');
  }

  async function oneStep(run, tools) {
    if (run.budget.modelCalls >= config.limits.model_calls || !contextFits(run.messages, tools, config.limits,documents.contextOptions(run))) {
      ready(run, 'The model or context budget was exhausted. No additional action was attempted.');
      return;
    }
    await authority(run);
    run.budget.modelCalls++;
    store.saveRun(run);
    const step = await boundary('model', async () => {
      const client = await modelClient();
      const result = await measured(run, async signal => {
        const artifacts=run.responseKind==='images'?documents.imageStore(run):undefined;
        const messages=await hydrateContext(run.messages,artifacts,{signal});
        return client.step({messages,tools,maxOutputTokens:config.limits.output_tokens,signal});
      });
      if (!result || typeof result.text !== 'string' || !Array.isArray(result.toolCalls)) throw diagnosticError('Invalid model result.', 'invalid-response');
      return result;
    });
    if (step.toolCalls.length > config.limits.tool_calls) { ready(run, 'Too many tool calls were proposed. No action was taken.'); return; }
    if (!step.toolCalls.length) {
      const staged=documents.attachmentOutput(run) && await measured(run,signal=>documents.stageReply(run,step.text,{signal}));
      if (!staged) ready(run, step.text || 'No answer was produced.');
      return;
    }
    appendModelStep(run, step);
    run.pending = step.toolCalls;
    store.saveRun(run);
  }

  async function send(run) {
    let delivery;
    try {
      requireMailboxWindow(); await freshEnvelope(run); await authority(run, { sending: true });
      delivery=documents.attachmentDelivery(run)?await measured(run,signal=>documents.delivery(run,{signal})):{};
    }
    catch(error) {
      operations.failed('send',error);
      if (shouldDefer(error)) return finish(run, 'ready_to_send');
      audit('send-denied', run); return finish(run, 'failed');
    }
    const client = await mailClient();
    if (run.budget.activeMs >= config.limits.run_seconds * 1000) return finish(run, 'failed');
    run.status = 'sending';
    store.saveRun(run);
    let attempted = false;
    try {
      const result = await measured(run, signal => { attempted = true; return client.reply(run.mail, run.reply, { ...delivery,signal }); });
      if (result?.status !== 'accepted') throw new Error('Unconfirmed mail result.');
      operations.succeeded('send');
      audit('send-accepted', run);
      return finish(run, 'completed');
    } catch (error) {
      operations.defer(error);
      operations.failed('send',error);
      const uncertain = attempted && error.uncertain !== false;
      run.uncertainty = uncertain ? { kind: 'send' } : null;
      audit('send-failed', run, { uncertain });
      return finish(run, uncertain ? 'uncertain' : 'ready_to_send');
    }
  }

  function blocked(run) {return store.hasEarlierBlocker(run);}

  async function execute(run) {
    if (terminal.has(run.status)) return safeResult(run);
    store.expireRunById(run.id,{contentHours:current.config.retention.content_hours});
    run = store.getRun(run.id);
    if (terminal.has(run.status)) return safeResult(run);
    if (run.status === 'awaiting_approval') return pendingApproval(run);
    if (blocked(run)) return safeResult(run);
    if (run.status === 'ready_to_send') return send(run);
    run.status = 'running'; store.saveRun(run);
    try {
      await prepareRequest(run);
      if (run.status === 'running') initializeContext(run);
      while (run.status === 'running') {
        const { all, permitted } = await toolsFor(run);
        if (!await runPending(run, all)) break;
        await oneStep(run, permitted);
      }
    } catch(error) {
      const result=executionFailure(run,error);
      if (result) return result;
    }
    return run.status === 'ready_to_send' ? send(run) : safeResult(run);
  }

  function executionFailure(run,error) {
    if (shouldDefer(error)) return finish(run,'queued');
    if (artifactFailure(error)) {audit('artifact-unavailable',run);return finish(run,'failed');}
    ready(run,'The configured service failed or the execution budget expired. Confirmed actions will not be repeated.');
    return null;
  }

  async function verifyImages(run) {
    if (run.responseKind==='images') await measured(run,signal=>documents.verifyImages(run,{signal}));
  }

  async function prepareRequest(run) {
    await authority(run, { sending: true });
    if (run.responseKind === 'unsupported') return ready(run, documents.enabled?DOCUMENT_UNSUPPORTED_REPLY:UNSUPPORTED_REPLY);
    if (['model','images'].includes(run.responseKind)) return;
    const classification = await classifyRequest(run.mail, await mailClient(), callback => mailboxRead(run, callback), controller.signal);
    run.contentClassification = classification;
    if (documents.enabled && classification==='document') {
      await prepareDocument(run);
      return;
    }
    run.responseKind = classification === 'none' ? 'model' : 'unsupported';
    if (run.responseKind === 'unsupported') {
      audit('unsupported-request', run, { reason: classification });
      ready(run, documents.enabled?DOCUMENT_UNSUPPORTED_REPLY:UNSUPPORTED_REPLY);
    } else store.saveRun(run);
  }

  async function prepareDocument(run) {
    try {
      await freshEnvelope(run);await authority(run,{sending:true});
      const client=await mailClient();
      await mailboxRead(run,signal=>documents.intake(run,{client,signal,read:async callback=>{
        await authority(run,{sending:true});
        return callback(signal);
      }}));
    } catch(error) {
      if (shouldDefer(error) || !unsupportedDocumentInput(error)) throw error;
      audit('unsupported-request',run,{reason:'image-input'});
      run.responseKind='unsupported';ready(run,DOCUMENT_UNSUPPORTED_REPLY);
    }
  }

  async function pendingApproval(run) {
    try {
      const active = await authority(run);
      if (run.approval.expiresAt <= clock() || run.approval.policyHash !== policyDigest(active)) throw new Error('Stale approval.');
    } catch { audit('approval-invalidated', run); return finish(run, 'failed'); }
    return safeResult(run);
  }

  async function approve({ id, actor, reason }) {
    operator(actor, reason); actor = address(actor);
    const run = store.findApproval(id);
    if (!run) throw new Error('Pending approval not found.');
    const active = await authority(run);
    if (!active.policy.approvers.includes(actor) || run.approval.expiresAt <= clock()) throw new Error('Approval authority expired or is not permitted.');
    if (run.approval.policyHash !== policyDigest(active) || !active.policy.tools[run.approval.tool]) throw new Error('Approval policy changed.');
    run.grants ??= {};
    run.grants[id] = { ...run.approval, actor, reasonHash: digest(reason) };
    run.approval = null;
    run.status = 'queued';
    store.transaction(() => { store.saveRun(run); audit('approved', run, { actor: digest(actor), target: id, reasonHash: digest(reason) }); });
    return safeResult(run);
  }

  function resolveSend({ runId, outcome, actor, reason }) {
    operator(actor, reason);
    const run = store.getRun(runId);
    if (!run || run.status !== 'uncertain' || run.uncertainty?.kind !== 'send') throw new Error('Uncertain send not found.');
    if (!['sent', 'not-sent'].includes(outcome)) throw new Error('Invalid send resolution.');
    if (outcome === 'not-sent' && (!run.reply || !run.mail)) throw new Error('Reply content has expired; request a new run.');
    run.uncertainty = null;
    const status = outcome === 'sent' ? 'completed' : 'ready_to_send';
    store.transaction(() => { finish(run, status); audit('send-reconciled', run, { actor: digest(actor), reasonHash: digest(reason), outcome }); });
    return safeResult(run);
  }

  async function recordsCommand(input, operation) {
    requireRecovered(store);
    await latest();
    await purge();
    return operation({ store, config: current.config, input, clock, audit });
  }

  async function pollOnce() {
    await latest();
    await purge();
    await drain();
    if (operations.sync().retryNotBefore > clock()) return {deferred:true};
    const cursor = store.getMeta('cursor');
    const baseline = !cursor || !JSON.parse(cursor).initialComplete;
    operations.attempt();
    const page = await boundary('mailbox', async () => (await mailClient()).poll({cursor,baseline,maxMessages:Math.min(1000,config.limits.queue_messages),signal:controller.signal}));
    store.transaction(() => {
      if (!baseline) for (const message of page.messages) queue(message);
      store.setMeta('cursor', page.cursor);
      operations.polled();
    });
    await drain();
    return { baseline, admitted: baseline ? 0 : page.messages.length };
  }

  function status(params = {}) {
    if (closedStatus) return closedStatus;
    const page = store.runPage(pageOptions(params));
    const summary = store.summary();
    return {agent:config.id, mailbox:config.mailbox.address,
      dependencyError:store.getMeta('last_poll_error') || null,
      runs:page.items,nextCursor:encodeCursor(page.nextCursor),counts:summary.counts,
      backlog:summary.backlog,approvals:summary.approvals,uncertainty:summary.uncertainty,
      sync:operations.sync(),failures:operations.failures(),recovery:recoveryState(store)};
  }

  function health() {
    if (closedHealth) return closedHealth;
    const report=operations.health(running,stopped),recovery=recoveryState(store);
    return recovery?{...report,ready:false,reason:'recovery-required',recovery}:report;
  }

  async function purge() {
    const settings = {contentHours:current.config.retention.content_hours,auditDays:current.config.retention.audit_days};
    let failed=0;
    while (!stopped && store.hasExpiredContent(settings)) {
      const expired=store.purge(settings);
      const result=await documents.collectExpiredRuns(expired.expiredRunIds??[],{signal:controller.signal});
      failed+=result.failed;
      await yieldControl();
    }
    if (!stopped) {
      const result=await documents.collect({signal:controller.signal});
      if (result.failed+failed) operations.failed('artifacts',diagnosticError('Private artifact cleanup requires attention.','dependency-failed'));
      else operations.succeeded('artifacts');
    }
  }

  async function drain() {
    let after;
    do {
      const page = store.activeBatch({limit:100,after});
      for (const run of page.items) if (!stopped) await execute(run);
      after = page.nextCursor;
    } while (after && !stopped);
  }

  function approvals(params = {}) {
    const page = store.approvalPage(pageOptions(params));
    if (!Object.keys(params).length) return page.items;
    return {items:page.items,nextCursor:encodeCursor(page.nextCursor)};
  }

  async function liveCheck() {
    requireRecovered(store);
    const active = await latest();
    const mailbox = await (await mailClient()).check({ signal: controller.signal });
    const tools = await (await mcpClient()).listTools({ signal: controller.signal });
    for (const name of Object.keys(active.config.policy.tools)) if (!tools.has(name)) throw new Error('Configured MCP tool is unavailable.');
    const client = await modelClient();
    const sample = new Map([...tools].filter(([name]) => active.config.policy.tools[name]));
    const result = await client.step({ messages: [{ role: 'user', content: 'Synthetic compatibility check: reply OK. Do not call any tool.' }], tools: sample, maxOutputTokens: 64, signal: controller.signal });
    if (result.toolCalls.length || !result.text) throw new Error('Synthetic model probe did not return a text reply.');
    if (config.model.capabilities.tools) await probeTools(client);
    return { ready: true, mailbox, model: config.model.name, tools: sample.size, toolCallingVerified: config.model.capabilities.tools, externalMutations: false };
  }

  async function probeTools(client) {
    const tools = new Map([['compatibility.probe', { description: 'Harmless compatibility probe, no external effect.', inputSchema: { type: 'object', properties: { marker: { const: 'probe' } }, required: ['marker'], additionalProperties: false } }]]);
    const result = await client.step({ messages: [{ role: 'user', content: 'Call compatibility.probe exactly once with marker "probe". This is a synthetic compatibility check.' }], tools, maxOutputTokens: 128, signal: controller.signal });
    if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== 'compatibility.probe' || digest(result.toolCalls[0].args) !== digest({ marker: 'probe' })) throw new Error('Model tool calling compatibility check failed.');
  }

  async function wait(ms) {
    if (controller.signal.aborted) return;
    await new Promise(done => {
      const onAbort = () => { clearTimeout(timer); done(); };
      const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); done(); }, ms);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function pollSafely() {
    try {await exclusive(pollOnce);}
    catch(error) {
      operations.defer(error);
      if (controller.signal.aborted) return;
      const name = error.diagnosticCode === 'configuration' ? 'configuration' : 'mailbox';
      operations.failed(name,error);
      store.setMeta('last_poll_error','mailbox-or-configuration-failed');
    }
  }

  async function start({once = false} = {}) {
    requireRecovered(store);
    if (running || stopped) throw new Error('Runtime is already running or stopped.');
    running = true;
    try {
      if (!once) {
        const {listenControl} = await import('./control.mjs');
        control = await (options.listenControl ?? listenControl)(stateRoot, api);
      }
      do {
        await pollSafely();
        if (!once && !stopped) await wait((config.mailbox.poll_seconds ?? 30) * 1000);
      } while (!once && !stopped);
      return status();
    } finally {running = false;}
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    stopped = true; controller.abort();
    stopPromise = (async () => {
      await tail;
      await control?.close();
      await mcp?.close?.();
      await mail?.close?.();
      closedStatus = status();
      closedHealth = health();
      store.close();
      if (previewRoot) await rm(previewRoot, { recursive: true, force: true });
    })();
    return stopPromise;
  }

  const api = {
    start, stop, status, health, approvals, liveCheck,
    approve: input => exclusive(async () => {requireRecovered(store); await purge(); return approve(input);}),
    resolve: input => exclusive(async () => {requireRecovered(store); await purge(); return resolveSend(input);}),
    recordsIntent: input => exclusive(() => recordsCommand(input, inspectRecordsIntent)),
    reconcileRecords: input => exclusive(() => recordsCommand(input, reconcileRecords)),
    processMessage: message => exclusive(async () => {
      requireRecovered(store);
      await latest();
      await purge();
      mail?.rememberMessage?.(message);
      return execute(queue(message));
    })
  };
  await purge();
  return api;
}
