import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runMaintenanceWorker} from '../src/maintenance-worker.mjs';

const identity='a'.repeat(64);
function worker(schema) {
  const child=new EventEmitter();
  child.send=()=>Promise.resolve().then(()=>{
    child.emit('message',{ok:true,value:{stateSchema:schema,mailboxIdentity:identity,sha256:'b'.repeat(64)}});
    child.emit('close',0);
  });
  child.kill=()=>{};
  return child;
}
const request={operation:'validate',source:'/private/synthetic.sqlite',identity,maxBytes:1048576};

test('maintenance IPC accepts current artifact schema5 but rejects a future schema',async()=>{
  const result=await runMaintenanceWorker(request,{spawnImpl:()=>worker(5)});
  assert.equal(result.stateSchema,5);
  await assert.rejects(runMaintenanceWorker(request,{spawnImpl:()=>worker(6)}),{code:'MAINTENANCE_FAILED'});
});
