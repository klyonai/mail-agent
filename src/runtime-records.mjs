import { admitted, address, digest, policyDigest } from './policy.mjs';
import { domainContextEnabled } from './domain-context.mjs';
import { RecordsReconciliationError, createRecordsIntent, validateRecordsIntent, validateRecordsReceipt, bindRecordsReceipt } from './records-reconciliation.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const fail = () => { throw new RecordsReconciliationError(); };

export function recordDomainIntent(action, context, call) {
  const intent = createRecordsIntent(context, call);
  if (intent) action.domainIntent = intent;
  return action;
}

function authorize(input, config) {
  const actor = address(input?.actor);
  if (typeof input?.actionKey !== 'string' || !hashPattern.test(input.actionKey)
    || !config.policy.approvers.includes(actor) || typeof input.reason !== 'string'
    || !input.reason.trim() || input.reason.length > 2048) fail();
  return { actorHash: digest(actor), reasonHash: digest(input.reason) };
}

function loadAction(store, input, config) {
  const action = store.getAction(input.actionKey);
  const intent = validateRecordsIntent(action?.domainIntent);
  if (action.effect !== 'write' || action.key !== intent.operationId || action.tool !== intent.tool
    || intent.agentId !== config.id || intent.mailbox !== address(config.mailbox.address)
    || !domainContextEnabled(config, intent.tool)) fail();
  const run = store.getRun(action.runId);
  if (!run) fail();
  return { action, intent, run };
}

function requireUncertain(action, run) {
  if (action.state !== 'uncertain' || run.status !== 'uncertain' || run.uncertainty?.kind !== 'tool' || run.activeOperation) fail();
}

export function inspectRecordsIntent({ store, config, input, audit }) {
  const attribution = authorize(input, config);
  const { action, intent, run } = loadAction(store, input, config);
  requireUncertain(action, run);
  audit('records-intent-inspected', run, { target: action.key, ...attribution });
  return intent;
}

function validBudget(run, config, outcome) {
  const budget = run.budget;
  if (!budget || run.activeOperation) return false;
  if (['modelCalls', 'toolCalls', 'activeMs'].some(key => !Number.isSafeInteger(budget[key]) || budget[key] < 0)) return false;
  const tools = outcome === 'not-applied' ? budget.toolCalls < config.limits.tool_calls : budget.toolCalls <= config.limits.tool_calls;
  return tools && budget.modelCalls < config.limits.model_calls && budget.activeMs < config.limits.run_seconds * 1000;
}

function pendingCall(run, intent) {
  return Array.isArray(run.pending) && run.pending.some(call => call.name === intent.tool && digest(call.args) === intent.argsHash);
}

function continuable(run, intent, config, receipt, now) {
  const policy = config.policy.tools[intent.tool];
  const content = !run.contentExpired && run.createdAt + config.retention.content_hours * 3_600_000 > now && Boolean(run.mail);
  const authority = policy?.effect === 'write' && policy.authorization === 'approval' && policyDigest(config) === intent.policyHash;
  return content && authority && admitted(run.mail, config) && pendingCall(run, intent) && validBudget(run, config, receipt.status);
}

function fingerprint(action) {
  const copy = { ...action };
  delete copy.recordsResolution;
  delete copy.result;
  return digest(copy);
}

function replay(action, receipt) {
  const resolution = action.recordsResolution;
  if (!resolution) return false;
  if (resolution.receiptHash !== digest(receipt) || resolution.fingerprint !== fingerprint(action)) fail();
  if (action.result !== undefined && digest(action.result) !== resolution.resultHash) fail();
  return true;
}

function resultFor(receipt) {
  const { status, operationId, recordId, revision, argsHash, recordHash } = receipt;
  return { content: [{ type: 'text', text: JSON.stringify({ status, operationId, recordId, revision, argsHash, recordHash }) }] };
}

function resolveAction(action, run, receipt, resume) {
  delete action.result;
  if (receipt.status === 'committed') {
    action.state = 'completed';
    if (!run.contentExpired) action.result = resultFor(receipt);
  } else action.state = resume ? 'pending' : 'failed';
}

function resolveRun(store, run, action, resume) {
  if (run.grants) delete run.grants[action.key];
  run.approval = null;
  const remaining = store.findUncertainAction(run.id);
  run.uncertainty = remaining ? { kind: 'tool', key: remaining.key } : null;
  run.status = remaining ? 'uncertain' : resume ? 'queued' : 'failed';
  store.saveRun(run);
}

export function reconcileRecords({ store, config, input, clock = Date.now, audit }) {
  const attribution = authorize(input, config);
  const { action, intent, run } = loadAction(store, input, config);
  const receipt = validateRecordsReceipt(input.receipt);
  if (replay(action, receipt)) return { runId: run.id, status: run.status };
  requireUncertain(action, run);
  bindRecordsReceipt(intent, receipt, clock());
  const resume = continuable(run, intent, config, receipt, clock());
  store.transaction(() => {
    resolveAction(action, run, receipt, resume);
    action.recordsResolution = { receiptHash: digest(receipt), outcome: receipt.status, at: clock(),
      ...attribution, fingerprint: fingerprint(action), resultHash: digest(action.result ?? null) };
    store.saveAction(action);
    resolveRun(store, run, action, resume);
    audit('records-action-reconciled', run, { target: action.key, outcome: receipt.status, receiptHash: digest(receipt), ...attribution });
  });
  return { runId: run.id, status: run.status };
}
