import {diagnosticError} from './diagnostics-errors.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const time=value=>Number.isSafeInteger(value)&&value>=0;

export function recoveryState(store) {
  const raw=store.getMeta('restore_hold');
  if (raw===undefined) return null;
  try {
    if (raw.length>1024) throw new Error('Invalid recovery record.');
    const value=JSON.parse(raw);
    if (!validHold(value)) throw new Error('Invalid recovery record.');
    return {required:true,snapshotId:value.snapshotId,snapshotCreatedAt:value.snapshotCreatedAt,restoredAt:value.restoredAt,reason:'restore-reconciliation'};
  } catch {
    return {required:true,snapshotId:null,snapshotCreatedAt:null,restoredAt:null,reason:'invalid-record'};
  }
}

function validHold(value) {
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3
    &&uuid.test(value.snapshotId)&&time(value.snapshotCreatedAt)&&time(value.restoredAt);
}

export function requireRecovered(store) {
  if (recoveryState(store)) throw diagnosticError('Restored state requires provider reconciliation before execution.', 'configuration');
}
