import { createHash } from 'node:crypto';
import { canonical, digest, maySend, policyDigest } from './policy.mjs';
import { recoveryState } from './recovery-hold.mjs';
import { mailboxIdentity } from './state-identity.mjs';

const receiptFields = ['format', 'mailboxIdentity', 'snapshotId', 'binding', 'configHash', 'planDigest', 'actorHash', 'reasonHash', 'appliedAt', 'operationCount', 'actions', 'runs'];
const maxReceiptBytes = 262_144;
const controls = /[\p{Cc}\p{Cf}]/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const email = /^[^\s@<>]{1,128}@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;

export class RecoveryLedgerError extends Error {
  constructor() {
    super('Executable recovery work is unreconciled or unsafe.');
    this.name = 'RecoveryLedgerError';
    this.code = 'RECOVERY_LEDGER_INVALID';
  }
}

function check(condition) { if (!condition) throw new RecoveryLedgerError(); }
function hash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function text(value, maximum) { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !controls.test(value); }
function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function receiptContext(prior, planDigest, context) {
  check(prior.mailboxIdentity === context.identity && prior.snapshotId === context.snapshotId
    && prior.binding === context.binding && prior.configHash === context.configHash && prior.planDigest === planDigest);
  check(hash(prior.actorHash) && hash(prior.reasonHash) && integer(prior.appliedAt)
    && prior.appliedAt >= context.snapshotCreatedAt && prior.appliedAt <= context.now);
  check(Number.isInteger(prior.operationCount) && prior.operationCount > 0 && prior.operationCount <= 100);
}

function decisionRecords(records, kind, count) {
  check(Array.isArray(records) && records.length <= count);
  const field = kind === 'action' ? 'key' : 'id';
  const fields = [field, 'originalFingerprint', 'appliedFingerprint', 'outcome', 'evidenceHash'];
  const outcomes = kind === 'action' ? ['no-effect', 'fenced'] : ['resume', 'sent', 'fenced', 'skip'];
  const targets = new Set();
  for (const record of records) {
    check(exact(record, fields) && text(record[field], 256));
    check([record.originalFingerprint, record.appliedFingerprint, record.evidenceHash].every(hash));
    check(outcomes.includes(record.outcome) && !targets.has(record[field]));
    targets.add(record[field]);
  }
}

/** Shared bounded committed receipt parser. It never returns mail, tool arguments or results. */
export function readRecoveryReceipt(store, planDigest, context) {
  try {
    check(hash(planDigest));
    const raw = store.getMetaBounded(`recovery_batch:${planDigest}`, maxReceiptBytes);
    if (raw === undefined) return null;
    check(typeof raw === 'string' && raw.length <= maxReceiptBytes && Buffer.byteLength(raw, 'utf8') <= maxReceiptBytes);
    const prior = JSON.parse(raw);
    check(exact(prior, receiptFields) && prior.format === 1);
    receiptContext(prior, planDigest, context);
    decisionRecords(prior.actions, 'action', prior.operationCount);
    decisionRecords(prior.runs, 'run', prior.operationCount);
    check(prior.actions.length + prior.runs.length <= prior.operationCount);
    return prior;
  } catch { throw new RecoveryLedgerError(); }
}

function configuration(context) {
  const config = context.config;
  check(config && mailboxIdentity(config) === context.identity);
  check(config.limits && ['model_calls', 'tool_calls', 'run_seconds'].every(field => Number.isSafeInteger(config.limits[field]) && config.limits[field] > 0));
  check(config.limits.run_seconds <= Number.MAX_SAFE_INTEGER / 1000);
  const hours = config.retention?.content_hours;
  check(Number.isSafeInteger(hours) && hours > 0 && hours <= Number.MAX_SAFE_INTEGER / 3_600_000);
}

function contextRecord(store, value) {
  const context = { maxRuns: 10_000, checkCancelled: () => {}, ...value };
  check([context.identity, context.configHash, context.binding].every(hash) && typeof context.snapshotId === 'string' && uuid.test(context.snapshotId));
  check(integer(context.snapshotCreatedAt) && integer(context.now) && context.snapshotCreatedAt <= context.now);
  check(Number.isInteger(context.maxRuns) && context.maxRuns > 0 && context.maxRuns <= 10_000 && typeof context.checkCancelled === 'function');
  configuration(context);
  heldContext(store, context);
  return context;
}

function heldContext(store, context) {
  const rawHold = store.getMetaBounded('restore_hold', 1024), cursor = store.getMetaBounded('cursor', 65_536);
  check(cursor === undefined || typeof cursor === 'string');
  const rawCursor = cursor ?? null;
  const hold = recoveryState({ getMeta: () => rawHold });
  check(hold?.reason === 'restore-reconciliation' && hold.snapshotId === context.snapshotId && hold.snapshotCreatedAt === context.snapshotCreatedAt);
  check(store.getMetaBounded('identity', 64) === context.identity && store.getMetaBounded('schema_version', 1) === '5');
  check(context.binding === digest([context.identity, rawHold, rawCursor]));
}

function envelope(mail) {
  check(mail && text(mail.id, 1024) && text(mail.conversationId, 1024));
  check(typeof mail.sender === 'string' && email.test(mail.sender));
  check(Array.isArray(mail.to) && mail.to.length > 0 && mail.to.every(address => typeof address === 'string' && email.test(address)));
  check(Array.isArray(mail.cc) && mail.cc.every(address => typeof address === 'string' && email.test(address)));
  mailContent(mail);
}

function mailContent(mail) {
  check(typeof mail.subject === 'string' && mail.subject.length <= 4_000_000 && typeof mail.body === 'string' && mail.body.length <= 4_000_000);
  check(typeof mail.receivedAt === 'string' && Number.isFinite(Date.parse(mail.receivedAt)) && typeof mail.attachments === 'boolean');
  check(mail.authenticated === true && mail.autoGenerated === false);
}

function usableRun(store, run, context) {
  check(['queued', 'awaiting_approval', 'ready_to_send'].includes(run.status));
  check(!Object.hasOwn(run, 'activeOperation') && !run.contentExpired && !run.uncertainty);
  check(integer(run.createdAt) && run.createdAt <= context.now && run.createdAt > context.now - context.config.retention.content_hours * 3_600_000);
  check(run.budget && ['modelCalls', 'toolCalls', 'activeMs'].every(field => integer(run.budget[field])));
  // Runtime guards each future model/tool call. Exact caps can still produce a saved or deterministic reply.
  check(run.budget.modelCalls <= context.config.limits.model_calls && run.budget.toolCalls <= context.config.limits.tool_calls
    && run.budget.activeMs < context.config.limits.run_seconds * 1000);
  envelope(run.mail);
  check(maySend(run, context.config));
  if (run.status === 'ready_to_send') check(typeof run.reply === 'string' && run.reply.length > 0);
  waitingApproval(run, context);
  const unresolved = store.unresolvedActions(run.id, { limit: 1 });
  check(Array.isArray(unresolved) && unresolved.length === 0);
}

function objectArgs(value) { return value && typeof value === 'object' && !Array.isArray(value); }

function waitingApproval(run, context) {
  if (run.status !== 'awaiting_approval') return;
  const approval = run.approval;
  check(exact(approval, ['id', 'tool', 'args', 'policyHash', 'expiresAt']));
  check(hash(approval.id) && integer(approval.expiresAt) && approval.expiresAt > context.now);
  check(context.config.model?.capabilities?.tools === true);
  check(text(approval.tool, 256) && Object.hasOwn(context.config.policy.tools, approval.tool) && objectArgs(context.config.policy.tools[approval.tool]));
  check(approval.policyHash === policyDigest(context.config) && objectArgs(approval.args));
  check(approval.id === digest([run.id, approval.tool, approval.args]));
  check(Array.isArray(run.pending) && run.pending.length > 0 && run.pending.length <= 100);
  check(run.pending.some(call => matchingPendingCall(call, run.id, approval)));
}

function matchingPendingCall(call, runId, approval) {
  return call && call.name === approval.tool && objectArgs(call.args) && digest([runId, call.name, call.args]) === approval.id;
}

function reconciledRun(store, run, fingerprint, context) {
  const marker = run.recovery;
  check(exact(marker, ['binding', 'planDigest', 'outcome', 'evidenceHash']));
  check(marker.binding === context.binding && marker.outcome === 'resume' && hash(marker.planDigest) && hash(marker.evidenceHash));
  const receipt = readRecoveryReceipt(store, marker.planDigest, context);
  check(receipt?.runs.some(decision => decision.id === run.id && decision.outcome === 'resume'
    && decision.evidenceHash === marker.evidenceHash && decision.appliedFingerprint === fingerprint));
}

function ordered(row, previous) {
  check(row && text(row.id, 256) && integer(row.sequence) && hash(row.fingerprint));
  if (!previous) return;
  check(row.sequence > previous.sequence || row.sequence === previous.sequence && Buffer.compare(Buffer.from(row.id), Buffer.from(previous.id)) > 0);
}

function pageCursor(page) {
  check(page && Array.isArray(page.items) && page.items.length <= 100);
  if (!page.nextCursor) return null;
  const last = page.items.at(-1);
  check(last && exact(page.nextCursor, ['sequence', 'id']) && page.nextCursor.sequence === last.sequence && page.nextCursor.id === last.id);
  return page.nextCursor;
}

/** Verify only executable indexed rows, one full record at a time, without mutating the ledger. */
export function verifyRecoveryLedger(store, value) {
  try {
    const context = contextRecord(store, value);
    const accumulator = createHash('sha256').update(canonical([context.identity, context.configHash, context.binding, context.snapshotId]));
    let after, previous, count = 0;
    do {
      context.checkCancelled();
      const page = store.activeRecoveryPage({ limit: 100, after });
      const next = pageCursor(page);
      for (const row of page.items) {
        context.checkCancelled();
        check(count < context.maxRuns);
        ordered(row, previous);
        const run = store.getRun(row.id);
        check(run?.id === row.id && run.sequence === row.sequence && store.runFingerprint(row.id) === row.fingerprint);
        usableRun(store, run, context);
        reconciledRun(store, run, row.fingerprint, context);
        accumulator.update(`\n${canonical([row.sequence, row.id, row.fingerprint])}`);
        previous = row;
        count++;
      }
      after = next;
    } while (after);
    context.checkCancelled();
    return { ledgerDigest: accumulator.digest('hex'), count };
  } catch { throw new RecoveryLedgerError(); }
}
