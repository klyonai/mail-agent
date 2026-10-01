import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';

function output(){let value='';return {write:text=>{value+=text;},value:()=>value};}
test('release CLI forwards private manifest, reviewed attribution and Graph-only environment without a runtime',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-release-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'bundle');
  assert.equal(await runCli(['init','--directory',directory,'--recipe','text-inbox'],{stdout:output()}),0);
  const filename=join(directory,'agent.yaml'),plan={synthetic:'manifest'},calls=[];
  const settings={env:{SYNTHETIC_GRAPH_SECRET:'private'},stdout:output(),stderr:output(),
    createRuntime(){throw new Error('No runtime');},readRecoveryPlanFile:async()=>plan,
    previewRecoveryRelease:async request=>{calls.push(request);return {reviewDigest:'a'.repeat(64)};},
    applyRecoveryRelease:async request=>{calls.push(request);return {released:true};}};
  const base=['--config',filename,'--plan','synthetic-private-plan','--actor','operator@example.org','--reason','Synthetic review'];
  assert.equal(await runCli(['recovery-release-preview',...base],settings),0);
  assert.equal(await runCli(['recovery-release-apply',...base,'--digest','a'.repeat(64)],settings),0);
  assert.equal(calls.length,2);assert.equal(calls[0].plan,plan);assert.equal(calls[0].env,settings.env);
  assert.ok(calls[0].config.mailbox);assert.match(calls[0].identity,/^[a-f0-9]{64}$/);
  assert.equal(calls[1].expectedReviewDigest,'a'.repeat(64));assert.equal(calls[1].actor,'operator@example.org');
});

test('release CLI validates attribution/digest before reading files and sanitizes private failures',async()=>{
  let reads=0;const stderr=output(),settings={stderr,readRecoveryPlanFile(){reads++;throw new Error('PRIVATE_PLAN');}};
  for(const args of [['recovery-release-preview','--config','PRIVATE_PATH','--plan','PRIVATE_PLAN'],
    ['recovery-release-apply','--config','PRIVATE_PATH','--plan','PRIVATE_PLAN','--actor','operator@example.org','--reason','review','--digest','invalid']]) {
    assert.equal(await runCli(args,settings),1);
  }
  assert.equal(reads,0);assert.doesNotMatch(stderr.value(),/PRIVATE_PATH|PRIVATE_PLAN/);
});
