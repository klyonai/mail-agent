import { randomUUID } from 'node:crypto';
import { digest } from './policy.mjs';
import { recoveryState } from './recovery-hold.mjs';
import { validateRecoveryPlan } from './recovery-plan.mjs';
import { withRecoveryStore } from './recovery-state.mjs';
import { readRecoveryReceipt } from './recovery-ledger.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const email = /^[^\s@<>]{1,128}@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;
const resumable = new Set(['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending', 'uncertain']);
const unresolved = new Set(['executing', 'uncertain']);
const receiptMaxBytes = 262_144;

export class RecoveryApplyError extends Error {
  constructor() {
    super('Recovery decisions are invalid or do not match the held state.');
    this.name = 'RecoveryApplyError';
    this.code = 'RECOVERY_APPLY_INVALID';
  }
}

function check(condition) { if (!condition) throw new RecoveryApplyError(); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function hash(value) { return typeof value === 'string' && hashPattern.test(value); }
function alive(signal) { check(!signal?.aborted); }

function options(value, apply) {
  const current = { clock: Date.now, ...value };
  check(hash(current.identity) && hash(current.configHash) && typeof current.clock === 'function');
  check(typeof current.agentId === 'string' && current.agentId.length > 0 && current.agentId.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(current.agentId));
  check(Number.isSafeInteger(current.contentHours) && current.contentHours > 0 && current.contentHours <= Number.MAX_SAFE_INTEGER / 3_600_000);
  check(current.limits && ['model_calls', 'tool_calls', 'run_seconds'].every(field => Number.isSafeInteger(current.limits[field]) && current.limits[field] > 0));
  check(current.limits.run_seconds <= Number.MAX_SAFE_INTEGER / 1000);
  if (current.signal) check(typeof current.signal.aborted === 'boolean' && typeof current.signal.addEventListener === 'function');
  if (apply) attribution(current);
  const now = current.clock();
  check(integer(now));
  return { ...current, now };
}

function attribution(value) {
  check(typeof value.actor === 'string' && email.test(value.actor) && value.actor.trim() === value.actor);
  check(typeof value.reason === 'string' && value.reason.trim().length > 0 && value.reason.length <= 2048);
  check(hash(value.expectedPlanDigest));
}

function held(store, descriptor, value) {
  alive(value.signal);
  const recovery = recoveryState(store);
  check(descriptor.stateSchema === 5 && store.getMeta('schema_version') === '5' && store.getMeta('identity') === value.identity);
  check(recovery?.reason === 'restore-reconciliation' && recovery.snapshotId === descriptor.recovery.snapshotId
    && recovery.snapshotCreatedAt === descriptor.recovery.snapshotCreatedAt);
  check(store.getMeta('restore_hold') === descriptor.rawHold && (store.getMeta('cursor') ?? null) === descriptor.rawCursor);
  check(descriptor.binding === digest([value.identity, descriptor.rawHold, descriptor.rawCursor]));
}

function batch(store, descriptor, value) {
  held(store, descriptor, value);
  const plan = validateRecoveryPlan(value.plan, { identity: value.identity, configHash: value.configHash, binding: descriptor.binding,
    snapshotId: descriptor.recovery.snapshotId, snapshotCreatedAt: descriptor.recovery.snapshotCreatedAt, now: value.now });
  const planDigest = digest(plan);
  return { plan, planDigest, snapshotId: plan.snapshotId, binding: plan.binding, identity: value.identity,
    configHash: value.configHash, snapshotCreatedAt: descriptor.recovery.snapshotCreatedAt };
}

function safeBatch(current, applied, idempotent = false) {
  const operations = current.plan.operations.map(operation => ({ kind: operation.kind,
    target: operation.kind === 'message' ? digest(operation.messageId) : operation.id ?? operation.key,
    outcome: operation.outcome, evidence: { ...operation.evidence } }));
  return { snapshotId: current.snapshotId, binding: current.binding, planDigest: current.planDigest, operations, applied, idempotent };
}

function marker(current, operation) {
  return { binding: current.binding, planDigest: current.planDigest, outcome: operation.outcome, evidenceHash: operation.evidence.recordHash };
}

function actionChange(store, operation, current) {
  const action = store.getAction(operation.key);
  check(action && action.key === operation.key && typeof action.runId === 'string' && ['read', 'write'].includes(action.effect));
  check(unresolved.has(action.state));
  check(!Object.hasOwn(action, 'result'));
  action.state = operation.outcome === 'no-effect' ? 'pending' : 'uncertain';
  action.recovery = marker(current, operation);
  return action;
}

function validBudget(run, required) {
  const numeric = run.budget && ['modelCalls', 'toolCalls', 'activeMs'].every(field => integer(run.budget[field]));
  if (!numeric) { check(!required); return; }
  if (!Object.hasOwn(run, 'activeOperation')) return;
  const reservation = run.activeOperation?.reservedMs;
  if (!integer(reservation) || !Number.isSafeInteger(run.budget.activeMs + reservation)) { check(!required); return; }
  run.budget.activeMs += run.activeOperation.reservedMs;
  delete run.activeOperation;
}

function retainedMail(run, value) {
  check(!run.contentExpired && integer(run.createdAt) && run.createdAt <= value.now);
  check(run.createdAt > value.now - value.contentHours * 3_600_000);
  const mail = run.mail;
  check(mail && typeof mail.id === 'string' && mail.id.length > 0 && typeof mail.sender === 'string' && email.test(mail.sender));
  check(Array.isArray(mail.to) && mail.to.length > 0 && mail.to.every(address => typeof address === 'string' && email.test(address)));
  check(typeof mail.body === 'string' && mail.authenticated === true && mail.autoGenerated === false);
}

function actionPlans(current) {
  return new Map(current.plan.operations.filter(operation => operation.kind === 'action').map(operation => [operation.key, operation]));
}

function noUnresolvedActions(store, run, planned) {
  const actions = store.unresolvedActions(run.id, { limit: 101 });
  check(Array.isArray(actions) && actions.length <= 100);
  for (const action of actions) check(planned.get(action.key)?.outcome === 'no-effect');
}

function toolAbsence(store, run, planned, current, value) {
  if (run.uncertainty?.kind !== 'tool') return;
  const key = run.uncertainty.key, action = store.getAction(key);
  check(action && action.key === key && action.runId === run.id);
  check(provenAbsence(store, action, planned, current, value));
  check(Array.isArray(run.pending) && run.pending.length > 0 && run.pending.length <= 100);
  check(run.pending.some(call => call && typeof call.name === 'string' && digest([run.id, call.name, call.args]) === key));
}

function provenAbsence(store, action, planned, current, value) {
  if (planned.get(action.key)?.outcome === 'no-effect') return true;
  const recovery = action.recovery;
  if (action.state !== 'pending' || recovery?.binding !== current.binding || recovery?.outcome !== 'no-effect'
    || !hash(recovery.planDigest) || !hash(recovery.evidenceHash)) return false;
  const prior = readRecoveryReceipt(store, recovery.planDigest, { ...current, now: value.now });
  return Boolean(prior?.actions.some(decision => decision.key === action.key && decision.outcome === 'no-effect'
    && decision.evidenceHash === recovery.evidenceHash && decision.appliedFingerprint === store.actionFingerprint(action.key)));
}

function hasSendIntent(run) {
  return run.status === 'ready_to_send' || run.status === 'sending' || run.status === 'uncertain' && run.uncertainty?.kind === 'send';
}

function resumeStatus(run) {
  if (run.status === 'awaiting_approval') return 'awaiting_approval';
  if (hasSendIntent(run)) { check(typeof run.reply === 'string' && run.reply.length > 0); return 'ready_to_send'; }
  return typeof run.reply === 'string' && run.reply.length > 0 && !run.pending?.length ? 'ready_to_send' : 'queued';
}

function resume(store, run, operation, current, value, planned) {
  check(resumable.has(run.status));
  retainedMail(run, value);
  // The snapshot cannot establish absence of effects after its creation, including queued zero-budget work.
  check(operation.evidence.source === 'graph' || operation.evidence.source === 'adapter');
  check(run.budget.modelCalls <= value.limits.model_calls && run.budget.toolCalls <= value.limits.tool_calls
    && run.budget.activeMs < value.limits.run_seconds * 1000);
  noUnresolvedActions(store, run, planned);
  toolAbsence(store, run, planned, current, value);
  run.status = resumeStatus(run);
  delete run.uncertainty;
}

function abandon(store, run, operation, planned) {
  check(run.status !== 'sending' && run.status !== 'uncertain' && !run.uncertainty);
  check(operation.evidence.source === 'graph' || operation.evidence.source === 'adapter');
  if (run.status === 'ready_to_send') check(operation.evidence.source === 'graph');
  noUnresolvedActions(store, run, planned);
  run.status = 'failed';
}

function runChange(store, operation, current, value, planned) {
  const run = store.getRun(operation.id);
  check(run && run.id === operation.id);
  check(run.status !== 'completed' && run.status !== 'ignored');
  validBudget(run, operation.outcome === 'resume');
  if (operation.outcome === 'resume') resume(store, run, operation, current, value, planned);
  else if (operation.outcome === 'sent') { check(hasSendIntent(run)); run.status = 'completed'; delete run.uncertainty; }
  else if (operation.outcome === 'fenced') { run.status = 'uncertain'; run.uncertainty ??= { kind: 'restore' }; }
  else abandon(store, run, operation, planned);
  run.recovery = marker(current, operation);
  return run;
}

function validateTargets(store, current, value, planned) {
  for (const operation of current.plan.operations) {
    alive(value.signal);
    if (operation.kind === 'message') check(!store.byMessage(digest([value.agentId, operation.messageId])));
    else if (operation.kind === 'action') {
      check(store.actionFingerprint(operation.key) === operation.fingerprint);
      actionChange(store, operation, current);
    } else {
      check(store.runFingerprint(operation.id) === operation.fingerprint);
      runChange(store, operation, current, value, planned);
    }
  }
}

function messageFence(store, operation, current, value) {
  const raw = store.getMeta('queue_sequence') ?? '0';
  check(typeof raw === 'string' && /^\d{1,16}$/.test(raw));
  const sequence = Number(raw) + 1;
  check(Number.isSafeInteger(sequence));
  const id = randomUUID();
  check(!store.getRun(id));
  const run = { id, messageKey: digest([value.agentId, operation.messageId]), conversationKey: digest(operation.conversationId),
    sequence, status: operation.outcome === 'sent' ? 'completed' : 'uncertain', createdAt: value.now, contentExpired: true,
    budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, recovery: marker(current, operation) };
  if (operation.outcome === 'fenced') run.uncertainty = { kind: 'restore' };
  store.setMeta('queue_sequence', String(sequence));
  return run;
}

function audit(store, operation, record, current, value) {
  const target = operation.kind === 'message' ? digest(operation.messageId) : operation.id ?? operation.key;
  store.audit('recovery-decision', operation.kind === 'action' ? undefined : record, { actor: digest(value.actor), target,
    reasonHash: digest(value.reason), binding: current.binding, planDigest: current.planDigest, kind: operation.kind,
    outcome: operation.outcome, evidenceSource: operation.evidence.source, evidenceHash: operation.evidence.recordHash, observedAt: operation.evidence.observedAt });
}

function writeOperations(store, current, value, planned) {
  for (const operation of current.plan.operations.filter(operation => operation.kind === 'action')) {
    alive(value.signal);
    const action = actionChange(store, operation, current);
    store.saveAction(action);
    audit(store, operation, action, current, value);
  }
  for (const operation of current.plan.operations.filter(operation => operation.kind !== 'action')) {
    alive(value.signal);
    const run = operation.kind === 'run' ? runChange(store, operation, current, value, planned) : messageFence(store, operation, current, value);
    store.saveRun(run);
    audit(store, operation, run, current, value);
  }
}

function receiptRecords(current, store, kind) {
  const field = kind === 'action' ? 'key' : 'id';
  return current.plan.operations.filter(operation => operation.kind === kind).map(operation => {
    const appliedFingerprint = kind === 'action' ? store.actionFingerprint(operation.key) : store.runFingerprint(operation.id);
    check(hash(appliedFingerprint));
    return { [field]: operation[field], originalFingerprint: operation.fingerprint, appliedFingerprint,
      outcome: operation.outcome, evidenceHash: operation.evidence.recordHash };
  });
}

function receipt(current, value, store) {
  return { format: 1, mailboxIdentity: value.identity, snapshotId: current.snapshotId, binding: current.binding,
    configHash: value.configHash, planDigest: current.planDigest, actorHash: digest(value.actor ?? 'preview'), reasonHash: digest(value.reason ?? 'preview'),
    appliedAt: value.now, operationCount: current.plan.operations.length, actions: receiptRecords(current, store, 'action'), runs: receiptRecords(current, store, 'run') };
}

function serializeReceipt(current, value, store) {
  const raw = JSON.stringify(receipt(current, value, store));
  check(Buffer.byteLength(raw, 'utf8') <= receiptMaxBytes);
  return raw;
}

function existingReceipt(store, current, value) {
  const prior = readRecoveryReceipt(store, current.planDigest, { ...current, now: value.now });
  if (!prior) return false;
  check(prior.actorHash === digest(value.actor) && prior.reasonHash === digest(value.reason) && prior.operationCount === current.plan.operations.length);
  sameDecisions(prior.actions, current.plan.operations.filter(operation => operation.kind === 'action'), 'key');
  sameDecisions(prior.runs, current.plan.operations.filter(operation => operation.kind === 'run'), 'id');
  return true;
}

function sameDecisions(decisions, operations, field) {
  check(decisions.length === operations.length);
  for (const [index, operation] of operations.entries()) {
    const decision = decisions[index];
    check(decision[field] === operation[field] && decision.originalFingerprint === operation.fingerprint
      && decision.outcome === operation.outcome && decision.evidenceHash === operation.evidence.recordHash);
  }
}

export async function previewRecovery(request, { withStore = withRecoveryStore } = {}) {
  try {
    const value = options(request, false);
    alive(value.signal);
    return await withStore(value, (store, descriptor) => {
      const current = batch(store, descriptor, value), planned = actionPlans(current);
      validateTargets(store, current, value, planned);
      serializeReceipt(current, value, store);
      held(store, descriptor, value);
      return safeBatch(current, false);
    });
  } catch { throw new RecoveryApplyError(); }
}

export async function applyRecovery(request, { withStore = withRecoveryStore } = {}) {
  try {
    const value = options(request, true);
    alive(value.signal);
    return await withStore(value, (store, descriptor) => store.transaction(() => {
      const current = batch(store, descriptor, value);
      check(value.expectedPlanDigest === current.planDigest);
      if (existingReceipt(store, current, value)) return safeBatch(current, true, true);
      const planned = actionPlans(current);
      validateTargets(store, current, value, planned);
      serializeReceipt(current, value, store);
      writeOperations(store, current, value, planned);
      held(store, descriptor, value);
      store.setMeta(`recovery_batch:${current.planDigest}`, serializeReceipt(current, value, store));
      alive(value.signal);
      return safeBatch(current, true);
    }));
  } catch { throw new RecoveryApplyError(); }
}
