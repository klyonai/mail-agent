import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openStore} from '../src/store.mjs';

test('recovery target fingerprints and unresolved selections are exact, bounded and content-free',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-ledger-'));
  const store=openStore(root,{identity:'synthetic',clock:()=>100});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  store.saveRun({id:'run',messageKey:'message',conversationKey:'conversation',sequence:1,createdAt:100,status:'queued',mail:{body:'PRIVATE_LEDGER_BODY'}});
  for(let index=0;index<110;index++) store.saveAction({key:`action-${index}`,runId:'run',state:'uncertain',effect:'write',result:'PRIVATE_LEDGER_RESULT'});
  store.saveAction({key:'completed',runId:'run',state:'completed',effect:'write'});
  store.saveAction({key:'other-run',runId:'other',state:'executing',effect:'read'});
  assert.equal(store.runFingerprint('absent'),undefined);
  assert.equal(store.actionFingerprint('absent'),undefined);
  const db=new DatabaseSync(join(root,'agent.sqlite'),{readOnly:true});
  try {
    const raw=db.prepare('SELECT data FROM runs WHERE id=?').get('run').data;
    const actionRaw=db.prepare('SELECT data FROM actions WHERE key=?').get('action-0').data;
    assert.equal(store.runFingerprint('run'),createHash('sha256').update(raw).digest('hex'));
    assert.equal(store.actionFingerprint('action-0'),createHash('sha256').update(actionRaw).digest('hex'));
  } finally {db.close();}
  const unresolved=store.unresolvedActions('run',{limit:101});
  assert.equal(unresolved.length,101);
  assert.ok(unresolved.every(row=>row.state==='uncertain'&&row.effect==='write'&&!Object.hasOwn(row,'result')));
  assert.doesNotMatch(JSON.stringify(unresolved),/PRIVATE_LEDGER/);
  assert.equal(store.unresolvedActions('run',{limit:100000}).length,101);
  assert.equal(store.unresolvedActions('run',{limit:1}).length,1);
  assert.deepEqual(store.unresolvedActions('other'),[{key:'other-run',state:'executing',effect:'read'}]);
});
