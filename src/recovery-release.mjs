import { digest } from './policy.mjs';
import { mailboxIdentity } from './state-identity.mjs';
import { withRecoveryStore } from './recovery-state.mjs';
import { recoveryState } from './recovery-hold.mjs';
import { validateRecoveryReleasePlan } from './recovery-release-plan.mjs';
import { verifyRecoveryLedger } from './recovery-ledger.mjs';
import { stageRecoveryBaseline } from './recovery-baseline.mjs';
import { createGraph, validateGraphCheckpoint } from './graph.mjs';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const time=value=>Number.isSafeInteger(value)&&value>=0;
const stageFields=['format','plan','actorHash','reasonHash','ledgerDigest','executableRuns','oldCursorDigest','newCursorDigest',
  'baseline','stagedAt','restoredAt','cursor','reviewDigest'];
const metadataBytes=262144;

export class RecoveryReleaseError extends Error {
  constructor() { super('Recovery release is invalid or does not match the reviewed held state.');
    this.name='RecoveryReleaseError';this.code='RECOVERY_RELEASE_INVALID'; }
}
function check(condition) { if(!condition) throw new RecoveryReleaseError(); }

function options(request,apply) {
  const value={clock:Date.now,env:process.env,timeoutMs:60000,maxRuns:10000,...request};
  check(typeof value.clock==='function'&&hash(value.identity)&&hash(value.configHash));
  check(mailboxIdentity(value.config)===value.identity);
  check(Number.isSafeInteger(value.timeoutMs)&&value.timeoutMs>=1&&value.timeoutMs<=60000);
  check(Number.isSafeInteger(value.maxRuns)&&value.maxRuns>=1&&value.maxRuns<=10000);
  attribution(value);
  if(apply) check(hash(value.expectedReviewDigest));
  value.now=value.clock();check(time(value.now));
  value.deadline=value.now+value.timeoutMs;check(time(value.deadline));
  value.signal=value.signal?AbortSignal.any([value.signal,AbortSignal.timeout(value.timeoutMs)]):AbortSignal.timeout(value.timeoutMs);
  active(value);
  return value;
}

function attribution(value) {
  check(typeof value.actor==='string'&&value.actor.length<=254&&/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.actor));
  check(typeof value.reason==='string'&&value.reason.trim().length>0&&value.reason.length<=2048);
}

function active(value) {
  const now=value.clock();
  check(!value.signal.aborted&&time(now)&&now>=value.now&&now<=value.deadline);
  return now;
}

function held(store,descriptor,value) {
  active(value);
  check(store.getMetaBounded('identity',64)===value.identity&&store.getMetaBounded('schema_version',16)==='5');
  check(store.getMetaBounded('restore_hold',1024)===descriptor.rawHold);
  const cursor=store.getMetaBounded('cursor',65536);
  check(cursor===undefined||typeof cursor==='string');
  check((cursor??null)===descriptor.rawCursor);
  check(recoveryState(store)?.reason==='restore-reconciliation');
}

function context(value,descriptor) {
  return {identity:value.identity,binding:descriptor.binding,snapshotId:descriptor.recovery.snapshotId,configHash:value.configHash,
    snapshotCreatedAt:descriptor.recovery.snapshotCreatedAt,restoredAt:descriptor.recovery.restoredAt,now:active(value)};
}

function ledger(store,value,descriptor) {
  return verifyRecoveryLedger(store,{...context(value,descriptor),config:value.config,maxRuns:value.maxRuns,checkCancelled:()=>active(value)});
}

function reviewMaterial(stage) {
  return Object.fromEntries(Object.entries(stage).filter(([key])=>!['cursor','reviewDigest'].includes(key)));
}

function report(stage,released,idempotent=false) {
  return {mode:stage.plan.mode,snapshotId:stage.plan.snapshotId,binding:stage.plan.binding,reviewDigest:stage.reviewDigest,
    executableRuns:stage.executableRuns,oldCursorDigest:stage.oldCursorDigest,newCursorDigest:stage.newCursorDigest,
    coverage:{...stage.plan.coverage},baseline:{...stage.baseline},skippedHistory:skippedHistory(stage),released,idempotent};
}

function skippedHistory(stage) {
  return stage.plan.mode==='history-gap'?{from:stage.plan.coverage.from,through:stage.baseline.observedAt}:null;
}

function checkpointReadAllowed(store,value) {
  const raw=store.getMetaBounded('sync.retry',32);
  if(raw===undefined||raw==='') return;
  check(typeof raw==='string'&&/^\d{1,16}$/.test(raw)&&Number.isSafeInteger(Number(raw))&&Number(raw)<=active(value));
}

async function checkpoint(store,value,descriptor,plan,{baseline,graphFactory}) {
  if(plan.mode==='continuity') return {cursor:validateGraphCheckpoint(value.config.mailbox,descriptor.rawCursor),
    pages:0,messages:0,observedAt:active(value)};
  checkpointReadAllowed(store,value);
  const graph=graphFactory({...value,onRetryNotBefore:retry=>recordRetry(store,value,retry)});
  active(value);
  const result=await baseline({graph,signal:value.signal,clock:value.clock,timeoutMs:Math.max(1,value.deadline-active(value))});
  validateGraphCheckpoint(value.config.mailbox,result.cursor);
  return result;
}

function recordRetry(store,value,retry) {
  check(time(retry));
  if(retry<=active(value)) return;
  const raw=store.getMetaBounded('sync.retry',32);
  check(raw===undefined||raw===''||typeof raw==='string'&&/^\d{1,16}$/.test(raw)&&time(Number(raw)));
  store.setMeta('sync.retry',String(Math.max(retry,Number(raw??0))));
}

function defaultGraphFactory(value) {
  return createGraph(value.config.mailbox,{env:value.env,clock:value.clock,onRetryNotBefore:value.onRetryNotBefore});
}

function makeStage(value,descriptor,plan,work,baseline) {
  const stage={format:1,plan,actorHash:digest(value.actor),reasonHash:digest(value.reason),ledgerDigest:work.ledgerDigest,
    executableRuns:work.count,oldCursorDigest:descriptor.cursorDigest,newCursorDigest:digest(baseline.cursor),
    baseline:{pages:baseline.pages,messages:baseline.messages,observedAt:baseline.observedAt},stagedAt:active(value),
    restoredAt:descriptor.recovery.restoredAt,cursor:baseline.cursor};
  stage.reviewDigest=digest(reviewMaterial(stage));
  return stage;
}

function serialize(value) {
  const raw=JSON.stringify(value);check(Buffer.byteLength(raw,'utf8')<=metadataBytes);return raw;
}

function exact(value,keys) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}

function validateStage(stage,value) {
  check(exact(stage,stageFields)&&stage.format===1);
  check([stage.actorHash,stage.reasonHash,stage.ledgerDigest,stage.oldCursorDigest,stage.newCursorDigest,stage.reviewDigest].every(hash));
  check(stage.actorHash===digest(value.actor)&&stage.reasonHash===digest(value.reason));
  check(time(stage.stagedAt)&&time(stage.restoredAt)&&stage.restoredAt<=stage.stagedAt&&stage.stagedAt<=active(value));
  check(Number.isSafeInteger(stage.executableRuns)&&stage.executableRuns>=0&&stage.executableRuns<=value.maxRuns);
  validateBaseline(stage.baseline,stage.plan.mode,stage.stagedAt);
  check(stage.baseline.observedAt>=stage.plan.coverage.through);
  validateGraphCheckpoint(value.config.mailbox,stage.cursor);
  check(stage.newCursorDigest===digest(stage.cursor)&&stage.reviewDigest===digest(reviewMaterial(stage)));
}

function validateBaseline(baseline,mode,stagedAt) {
  check(exact(baseline,['pages','messages','observedAt'])&&time(baseline.observedAt)&&baseline.observedAt<=stagedAt);
  check(Number.isSafeInteger(baseline.messages)&&baseline.messages>=0&&baseline.messages<=10000);
  check(Number.isSafeInteger(baseline.pages)&&baseline.pages>=0&&baseline.pages<=100);
  if(mode==='continuity') check(baseline.pages===0&&baseline.messages===0);
  else check(baseline.pages>0);
}

function readStage(store,key,value) {
  const raw=store.getMetaBounded(key,metadataBytes);check(typeof raw==='string');
  const stage=JSON.parse(raw);validateStage(stage,value);return stage;
}

function stageMatches(stage,value,descriptor) {
  const plan=validateRecoveryReleasePlan(value.plan,context(value,descriptor));
  check(digest(stage.plan)===digest(plan)&&stage.restoredAt===descriptor.recovery.restoredAt);
  check(stage.oldCursorDigest===descriptor.cursorDigest&&stage.reviewDigest===value.expectedReviewDigest);
  if(plan.mode==='continuity') check(stage.cursor===descriptor.rawCursor);
}

function releasedReceipt(store,value,descriptor) {
  check(descriptor.recovery===null);
  const raw=store.getMetaBounded(`recovery_release_receipt:${value.expectedReviewDigest}`,metadataBytes);
  check(typeof raw==='string');const receipt=JSON.parse(raw);
  check(exact(receipt,['stage','releasedAt'])&&time(receipt.releasedAt)&&receipt.releasedAt<=active(value));
  const stage=receipt.stage;validateStage(stage,value);
  const plan=validateRecoveryReleasePlan(value.plan,{identity:value.identity,binding:stage.plan.binding,snapshotId:stage.plan.snapshotId,
    configHash:value.configHash,snapshotCreatedAt:stage.plan.coverage.from,restoredAt:stage.restoredAt,now:active(value)});
  check(digest(stage.plan)===digest(plan)&&stage.reviewDigest===value.expectedReviewDigest&&receipt.releasedAt>=stage.stagedAt);
  check(descriptor.cursorDigest===stage.newCursorDigest&&descriptor.rawCursor===stage.cursor);
  return report(stage,true,true);
}

export async function previewRecoveryRelease(request,{withStore=withRecoveryStore,baseline=stageRecoveryBaseline,graphFactory=defaultGraphFactory}={}) {
  try {
    const value=options(request,false);
    return await withStore({...value,allowReleased:false},async(store,descriptor)=>{
      held(store,descriptor,value);
      const plan=validateRecoveryReleasePlan(value.plan,context(value,descriptor));
      const before=ledger(store,value,descriptor);
      const baselineResult=await checkpoint(store,value,descriptor,plan,{baseline,graphFactory});
      held(store,descriptor,value);
      const after=ledger(store,value,descriptor);check(before.ledgerDigest===after.ledgerDigest&&before.count===after.count);
      const stage=makeStage(value,descriptor,plan,after,baselineResult);validateStage(stage,value);
      store.transaction(()=>{held(store,descriptor,value);store.setMeta(`recovery_release_stage:${descriptor.binding}`,serialize(stage));active(value);});
      return report(stage,false);
    });
  } catch { throw new RecoveryReleaseError(); }
}

function commitRelease(store,descriptor,value,stage) {
  held(store,descriptor,value);stageMatches(stage,value,descriptor);
  const work=ledger(store,value,descriptor);check(work.ledgerDigest===stage.ledgerDigest&&work.count===stage.executableRuns);
  const releasedAt=active(value);
  store.setMeta('cursor',stage.cursor);
  store.audit('recovery-release',undefined,{actor:stage.actorHash,target:stage.plan.snapshotId,reasonHash:stage.reasonHash,
    binding:stage.plan.binding,reviewDigest:stage.reviewDigest,mode:stage.plan.mode,coverage:stage.plan.coverage,
    oldCursorDigest:stage.oldCursorDigest,newCursorDigest:stage.newCursorDigest,ledgerDigest:stage.ledgerDigest,executableRuns:stage.executableRuns,
    baseline:stage.baseline,skippedHistory:skippedHistory(stage)});
  store.setMeta(`recovery_release_receipt:${stage.reviewDigest}`,serialize({stage,releasedAt}));
  store.deleteMeta(`recovery_release_stage:${descriptor.binding}`);
  store.deleteMeta('restore_hold');
  check(store.getMetaBounded('restore_hold',1024)===undefined);active(value);
  return report(stage,true);
}

export async function applyRecoveryRelease(request,{withStore=withRecoveryStore}={}) {
  try {
    const value=options(request,true);
    return await withStore({...value,allowReleased:true},(store,descriptor)=>{
      if(descriptor.recovery===null) return releasedReceipt(store,value,descriptor);
      const stage=readStage(store,`recovery_release_stage:${descriptor.binding}`,value);
      return store.transaction(()=>commitRelease(store,descriptor,value,stage));
    });
  } catch { throw new RecoveryReleaseError(); }
}
