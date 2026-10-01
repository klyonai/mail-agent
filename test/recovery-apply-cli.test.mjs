import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../src/cli.mjs';

function output(){let value='';return {write:text=>{value+=text;},value:()=>value};}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'ma-apply-cli-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'bundle');
  assert.equal(await runCli(['init','--directory',directory,'--recipe','text-inbox'],{stdout:output()}),0);
  return join(directory,'agent.yaml');
}

test('CLI preview and apply share configured scope and bounded file input without creating a runtime',async t=>{
  const filename=await fixture(t);
  const plan={synthetic:'plan'};
  const digest='a'.repeat(64);
  const calls=[];
  const settings={stdout:output(),env:{},createRuntime:()=>{throw new Error('No runtime');},
    readRecoveryPlanFile:async file=>{assert.match(file,/synthetic-plan$/);return plan;},
    previewRecovery:async value=>{calls.push(value);return {planDigest:digest};},
    applyRecovery:async value=>{calls.push(value);return {applied:true};}};
  assert.equal(await runCli(['recovery-preview','--config',filename,'--plan','synthetic-plan'],settings),0);
  assert.equal(await runCli(['recovery-apply','--config',filename,'--plan','synthetic-plan','--digest',digest,
    '--actor','operator@example.org','--reason','Synthetic review'],settings),0);
  assert.equal(calls[0].plan,plan);
  assert.match(calls[0].identity,/^[a-f0-9]{64}$/);assert.match(calls[0].configHash,/^[a-f0-9]{64}$/);
  assert.equal(calls[0].contentHours,24);assert.ok(calls[0].limits.model_calls>0);assert.equal(typeof calls[0].agentId,'string');
  assert.equal(calls[1].expectedPlanDigest,digest);assert.equal(calls[1].actor,'operator@example.org');
  assert.equal(calls[1].reason,'Synthetic review');
});

test('apply requires review digest and operator attribution before reading a plan',async()=>{
  let reads=0;
  const settings={stderr:output(),readRecoveryPlanFile:()=>{reads++;}};
  const base=['recovery-apply','--config','unused','--plan','unused'];
  for(const flags of [[],['--digest','bad','--actor','operator@example.org','--reason','review'],
    ['--digest','a'.repeat(64),'--reason','review'],['--digest','a'.repeat(64),'--actor','operator@example.org']]) {
    assert.equal(await runCli([...base,...flags],settings),1);
  }
  assert.equal(reads,0);
});

test('recovery plan failures never expose private file content or paths',async t=>{
  const filename=await fixture(t);
  const stderr=output();
  assert.equal(await runCli(['recovery-preview','--config',filename,'--plan','PRIVATE_PATH'],{
    stderr,readRecoveryPlanFile:()=>{throw new Error('PRIVATE_PLAN_BODY');}}),1);
  assert.doesNotMatch(stderr.value(),/PRIVATE_PATH|PRIVATE_PLAN_BODY/);
});
