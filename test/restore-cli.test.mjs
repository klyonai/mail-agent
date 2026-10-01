import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {runCli} from '../src/cli.mjs';

function output() {
  let value='';
  return {write:text=>{value+=text;},value:()=>value};
}

async function configuration(t) {
  const parent=await mkdtemp(join(tmpdir(),'ma-restore-cli-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const directory=join(parent,'bundle');
  assert.equal(await runCli(['init','--directory',directory,'--recipe','text-inbox'],{stdout:output()}),0);
  return {filename:join(directory,'agent.yaml'),stateRoot:join(await realpath(directory),'state')};
}

test('restore CLI uses the configured fresh root and forwards audited bounded settings without a runtime',async t=>{
  const {filename,stateRoot}=await configuration(t);
  const stdout=output();
  let received;
  const argv=['restore','--config',filename,'--snapshot','synthetic-snapshot','--actor','operator@tenant.test','--reason','Synthetic restore drill',
    '--max-bytes','100000','--timeout-seconds','2'];
  assert.equal(await runCli(argv,{stdout,env:{},createRuntime:()=>{throw new Error('Must not construct a runtime');},
    restoreState:async settings=>{received=settings;return {stateSchema:4,recoveryRequired:true};}}),0);
  assert.deepEqual(received,{snapshot:resolve('synthetic-snapshot'),stateRoot,identity:received.identity,
    actor:'operator@tenant.test',reason:'Synthetic restore drill',maxBytes:100000,timeoutMs:2000});
  assert.match(received.identity,/^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(stdout.value()),{stateSchema:4,recoveryRequired:true});
});

test('restore rejects missing attribution, invalid limits and unsafe option overrides before snapshot access',async()=>{
  let calls=0;
  const settings={env:{},stderr:output(),restoreState:()=>{calls++;}};
  const base=['restore','--config','unused','--snapshot','unused'];
  for(const flags of [[],['--actor','invalid','--reason','drill'],['--actor','operator@tenant.test'],
    ['--actor','operator@tenant.test','--reason','drill','--max-bytes','0'],
    ['--actor','operator@tenant.test','--reason','drill','--timeout-seconds','601'],
    ['--actor','operator@tenant.test','--reason','drill','--state-root','unsafe']]) {
    assert.equal(await runCli([...base,...flags],settings),1);
  }
  assert.equal(calls,0);
});

test('restore errors cannot disclose raw snapshot or operator reason content',async t=>{
  const {filename}=await configuration(t);
  const stderr=output();
  assert.equal(await runCli(['restore','--config',filename,'--snapshot','unused','--actor','operator@tenant.test','--reason','PRIVATE_REASON'],
    {stderr,env:{},restoreState:()=>{throw new Error('PRIVATE_SNAPSHOT_AND_TOKEN');}}),1);
  assert.doesNotMatch(stderr.value(),/PRIVATE_REASON|PRIVATE_SNAPSHOT_AND_TOKEN/);
  assert.match(stderr.value(),/Restore could not complete/);
});
