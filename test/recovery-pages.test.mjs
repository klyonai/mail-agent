import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openStore} from '../src/store.mjs';

test('recovery pages expose bounded metadata and exact content fingerprints without parsing or exposing private rows',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-recovery-page-'));
  const store=openStore(root,{identity:'synthetic',clock:()=>100});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  for(let sequence=1;sequence<=3;sequence++) store.saveRun({id:`run-${sequence}`,sequence,messageKey:`message-${sequence}`,
    conversationKey:`conversation-${sequence}`,status:'queued',createdAt:100,budget:{modelCalls:1,toolCalls:2,activeMs:3},
    mail:{body:'PRIVATE_RECOVERY_BODY'},grants:sequence===1?{grant:{args:'PRIVATE_RECOVERY_ARGS'}}:{},activeOperation:sequence===2?{reservedMs:10}:undefined});
  store.saveAction({key:'action-1',runId:'run-1',state:'uncertain',effect:'write',tool:'records.append',result:'PRIVATE_RECOVERY_RESULT'});
  store.saveAction({key:'action-2',runId:'run-2',state:'completed',effect:'read',tool:'records.read'});
  const first=store.recoveryPage({limit:2});
  assert.deepEqual(first.items.map(row=>row.id),['run-1','run-2']);
  assert.equal(first.items[0].approved,true);
  assert.equal(first.items[1].activeOperation,true);
  assert.deepEqual(first.items[0].budget,{modelCalls:1,toolCalls:2,activeMs:3});
  assert.deepEqual(first.nextCursor,{sequence:2,id:'run-2'});
  assert.deepEqual(store.recoveryPage({limit:2,after:first.nextCursor}).items.map(row=>row.id),['run-3']);
  const actions=store.actionPage({limit:1});
  assert.equal(actions.items[0].key,'action-1');
  assert.equal(actions.items[0].effect,'write');
  assert.equal(actions.nextCursor,'action-1');
  assert.equal(store.actionPage({limit:1,after:actions.nextCursor}).items[0].key,'action-2');
  assert.doesNotMatch(JSON.stringify({first,actions}),/PRIVATE_RECOVERY/);
  const db=new DatabaseSync(join(root,'agent.sqlite'),{readOnly:true});
  try {
    const raw=db.prepare('SELECT data FROM runs WHERE id=?').get('run-1').data;
    assert.equal(first.items[0].fingerprint,createHash('sha256').update(raw).digest('hex'));
  } finally {db.close();}
  // Invalid row JSON still has a stable fingerprint; operational inspection never parses it.
  const writer=new DatabaseSync(join(root,'agent.sqlite'));
  writer.exec('DROP TRIGGER runs_projection_update;');
  writer.prepare('UPDATE runs SET data=? WHERE id=?').run('PRIVATE_MALFORMED_JSON','run-1');writer.close();
  const malformed=store.recoveryPage({limit:1}).items[0];
  assert.equal(malformed.approved,false);
  assert.equal(malformed.fingerprint,createHash('sha256').update('PRIVATE_MALFORMED_JSON').digest('hex'));
  assert.doesNotMatch(JSON.stringify(malformed),/PRIVATE_MALFORMED_JSON/);
});
