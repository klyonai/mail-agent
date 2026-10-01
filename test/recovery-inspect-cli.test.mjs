import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../src/cli.mjs';

function output(){let value='';return {write:text=>{value+=text;},value:()=>value};}

test('recovery inspection CLI forwards typed pagination without constructing a runtime or requiring secrets',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-inspect-cli-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'bundle');
  assert.equal(await runCli(['init','--directory',directory,'--recipe','text-inbox'],{stdout:output()}),0);
  let received;
  const stdout=output();
  assert.equal(await runCli(['recovery-inspect','--config',join(directory,'agent.yaml'),'--kind','actions','--limit','10','--after','cursor'],{
    stdout,env:{},createRuntime:()=>{throw new Error('Must not construct a runtime');},
    inspectRecovery:settings=>{received=settings;return {kind:'actions',items:[],nextCursor:null};}
  }),0);
  assert.equal(received.kind,'actions');assert.equal(received.limit,10);assert.equal(received.after,'cursor');
  assert.match(received.stateRoot,/bundle\/state$/);assert.match(received.identity,/^[a-f0-9]{64}$/);
  const report=JSON.parse(stdout.value());
  assert.match(report.configHash,/^[a-f0-9]{64}$/);
  assert.equal(report.mailboxIdentity,received.identity);
  assert.equal(typeof report.agentId,'string');
  assert.deepEqual({kind:report.kind,items:report.items,nextCursor:report.nextCursor},{kind:'actions',items:[],nextCursor:null});
});

test('inspection CLI rejects invalid bounds/kinds and sanitizes unexpected recovery errors',async()=>{
  let calls=0;
  const stderr=output();
  const settings={stderr,inspectRecovery:()=>{calls++;}};
  for(const flags of [['--kind','private'],['--limit','101'],['--state','queued']]) {
    assert.equal(await runCli(['recovery-inspect','--config','unused',...flags],settings),1);
  }
  assert.equal(calls,0);
  assert.equal(await runCli(['recovery-inspect','--config','PRIVATE_CONFIG_SENTINEL'],settings),1);
  assert.doesNotMatch(stderr.value(),/PRIVATE_CONFIG_SENTINEL/);
});
