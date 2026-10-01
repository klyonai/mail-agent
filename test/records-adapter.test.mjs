import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import test from 'node:test';
import {promisify} from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecordsAdapter } from '../mcp/records/records.mjs';
import { createDomainContext } from '../src/domain-context.mjs';
import { createRecordsIntent } from '../src/records-reconciliation.mjs';
import { digest } from '../src/policy.mjs';
import {fileURLToPath} from 'node:url';

const actor = 'alice@example.test';
const approvalActor = 'admin@example.test';
const identity = { agentId: 'records-agent', mailbox: 'agent@example.test' };
const seed = { format: 1, id: 'record-a', revision: 1, type: 'note', title: 'Current title',
  content: 'Synthetic current content', tags: ['alpha'], source: { kind: 'operator', referenceHash: 'a'.repeat(64) },
  createdAt: 100, updatedAt: 100, updatedByHash: 'b'.repeat(64), deleted: false };
const domainPolicy = { version: 1, ...identity, connection: 'records',
  members: { [actor]: { read: ['record-a'], edit: ['record-a'], delete: ['record-a'] } }, approvers: [approvalActor] };
const execFile=promisify(execFileCallback);

function runtimeConfig() {
  return { id: identity.agentId, mailbox: { address: identity.mailbox,
    sender_authentication: { mode: 'exchange-authenticated' } }, retention: { content_hours: 24 },
    mcp: { records: { transport: 'stdio', actor_context: 'mail-agent-v1' } },
    policy: { approvers: [approvalActor], tools: {
      'records.search': { effect: 'read', authorization: 'automatic' },
      'records.get': { effect: 'read', authorization: 'automatic' },
      'records.propose_update': { effect: 'read', authorization: 'automatic' },
      'records.apply_approved_update': { effect: 'write', authorization: 'approval' },
      'records.propose_delete': { effect: 'read', authorization: 'automatic' },
      'records.apply_approved_delete': { effect: 'write', authorization: 'approval' },
      'records.operation_status': { effect: 'read', authorization: 'automatic' },
    } } };
}

function context(tool, args, authorization = 'automatic', approval = null, now = 200, requester = actor) {
  const config = runtimeConfig(), run = { id: 'synthetic-run-1', createdAt: 150,
    mail: { id: 'synthetic-message-1', conversationId: 'synthetic-conversation-1', sender: requester, authenticated: true } };
  const actionKey = digest([run.id, tool, args]);
  if (approval) approval = { ...approval, id: actionKey };
  return createDomainContext({ run, call: { name: tool, args }, actionKey, config, authorization,
    approval, clock: () => now });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'records-adapter-'));
  const records = join(root, 'records', seed.id);
  await mkdir(records, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700); await chmod(join(root, 'records'), 0o700); await chmod(records, 0o700);
  await writeFile(join(records, 'record.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  const adapter = createRecordsAdapter({ root, policy: domainPolicy, clock: () => 200, ...options });
  t.after(async()=>{await adapter.close();await rm(root,{recursive:true,force:true});});
  return { root, adapter, recordPath: join(records, 'record.json') };
}

test('lists a bounded read and approval-only records tool set', async t => {
  const { adapter } = await fixture(t);
  assert.deepEqual(adapter.listTools().map(tool => tool.name), [
    'search', 'get', 'propose_update', 'apply_approved_update', 'propose_delete', 'apply_approved_delete', 'operation_status',
  ]);
  assert.equal(adapter.listTools().find(tool => tool.name === 'apply_approved_update').inputSchema.additionalProperties, false);
});

test('reads and searches only the authenticated actor visible record', async t => {
  const { adapter } = await fixture(t);
  const result = await adapter.call('get', { recordId: seed.id }, context('records.get', { recordId: seed.id }));
  assert.equal(result.record.id, seed.id);
  assert.equal(result.record.content, seed.content);
  const found = await adapter.call('search', { query: 'current', limit: 10 }, context('records.search', { query: 'current', limit: 10 }));
  assert.deepEqual(found.items.map(item => item.id), [seed.id]);
  await assert.rejects(adapter.call('get', { recordId: seed.id },
    context('records.get', { recordId: seed.id }, 'automatic', null, 200, 'mallory@example.test')), { code: 'RECORDS_DENIED' });
});

test('proposal is read-only and exact local approval commits one revision idempotently', async t => {
  const { adapter, recordPath } = await fixture(t);
  const proposalArgs = { recordId: seed.id, expectedRevision: 1, patch: { title: 'Updated title', content: 'Approved new content' } };
  const before = await readFile(recordPath, 'utf8');
  const proposal = await adapter.call('propose_update', proposalArgs, context('records.propose_update', proposalArgs));
  assert.equal(await readFile(recordPath, 'utf8'), before);
  const args = { ...proposalArgs, expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest };
  const grant = { actor: approvalActor, origin: 'local-operator', reasonHash: digest('approved synthetic change'), expiresAt: 50_000 };
  const approvedContext = context('records.apply_approved_update', args, 'approval', grant);
  const first = await adapter.call('apply_approved_update', args, approvedContext);
  assert.equal(first.status, 'committed');
  assert.equal(first.revision, 2);
  assert.deepEqual(await adapter.call('apply_approved_update', args, approvedContext), first);
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(saved.revision, 2); assert.equal(saved.title, 'Updated title');
  assert.equal(saved.content, 'Approved new content');
  const operation = await adapter.call('operation_status', { operationId: approvedContext.operationId },
    context('records.operation_status', { operationId: approvedContext.operationId }));
  assert.equal(operation.status, 'committed');
});

test('mutation rejects model identity fields, automatic authorization, bad proposal digest and stale revision', async t => {
  const { adapter, recordPath } = await fixture(t);
  const proposalArgs = { recordId: seed.id, expectedRevision: 1, patch: { title: 'Safe update' } };
  const proposal = await adapter.call('propose_update', proposalArgs, context('records.propose_update', proposalArgs));
  const args = { ...proposalArgs, expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest };
  const before = await readFile(recordPath, 'utf8');
  await assert.rejects(adapter.call('apply_approved_update', { ...args, actor }, context('records.apply_approved_update', { ...args, actor }, 'approval',
    { actor: approvalActor, origin: 'local-operator', reasonHash: digest('reason'), expiresAt: 50_000 })));
  const automatic = context('records.apply_approved_update', args, 'approval', { actor: approvalActor, origin: 'local-operator', reasonHash: digest('reason'), expiresAt: 50_000 });
  await assert.rejects(adapter.call('apply_approved_update', args, { ...automatic, authorization: 'automatic', approval: null }), { code: 'RECORDS_DENIED' });
  await assert.rejects(adapter.call('apply_approved_update', { ...args, proposalDigest: 'f'.repeat(64) },
    context('records.apply_approved_update', { ...args, proposalDigest: 'f'.repeat(64) }, 'approval',
      { actor: approvalActor, origin: 'local-operator', reasonHash: digest('reason'), expiresAt: 50_000 })));
  await adapter.call('apply_approved_update', args, context('records.apply_approved_update', args, 'approval',
    { actor: approvalActor, origin: 'local-operator', reasonHash: digest('reason'), expiresAt: 50_000 }));
  await assert.rejects(adapter.call('propose_update', proposalArgs, context('records.propose_update', proposalArgs)), { code: 'RECORDS_CONFLICT' });
  assert.notEqual(await readFile(recordPath, 'utf8'), before);
});

test('post-publication interruption is reconciled from durable operation evidence without a second revision', async t => {
  let interrupt = true;
  const { adapter, recordPath } = await fixture(t, { afterPublish: async () => { if (interrupt) { interrupt = false; throw new Error('private crash detail'); } } });
  const proposalArgs = { recordId: seed.id, expectedRevision: 1, patch: { title: 'Committed before interruption' } };
  const proposal = await adapter.call('propose_update', proposalArgs, context('records.propose_update', proposalArgs));
  const args = { ...proposalArgs, expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest };
  const callContext = context('records.apply_approved_update', args, 'approval',
    { actor: approvalActor, origin: 'local-operator', reasonHash: digest('reason'), expiresAt: 50_000 });
  await assert.rejects(adapter.call('apply_approved_update', args, callContext), { code: 'RECORDS_UNCERTAIN' });
  const status = await adapter.call('operation_status', { operationId: callContext.operationId },
    context('records.operation_status', { operationId: callContext.operationId }));
  assert.equal(status.status, 'committed');
  const retry = await adapter.call('apply_approved_update', args, callContext);
  assert.equal(retry.status, 'committed');
  assert.equal(retry.revision, 2);
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).revision, 2);
});

test('committed receipts are immutable and local inspection reports the original revision', async t => {
  const { adapter, root, recordPath } = await fixture(t);
  const firstInput = { recordId: seed.id, expectedRevision: 1, patch: { title: 'First commit' } };
  const firstProposal = await adapter.call('propose_update', firstInput, context('records.propose_update', firstInput));
  const firstArgs = { ...firstInput, expectedRecordHash: firstProposal.expectedRecordHash, proposalDigest: firstProposal.proposalDigest };
  const firstContext = context('records.apply_approved_update', firstArgs, 'approval',
    { actor: approvalActor, origin: 'local-operator', reasonHash: digest('first approval'), expiresAt: 50_000 });
  const first = await adapter.call('apply_approved_update', firstArgs, firstContext);
  assert.deepEqual(Object.keys(first).sort(), ['argsHash', 'operationId', 'recordHash', 'recordId', 'revision', 'status']);
  const originalReceipt = await readFile(join(root, 'operations', `${first.operationId}.receipt.json`), 'utf8');

  const secondInput = { recordId: seed.id, expectedRevision: 2, patch: { title: 'Second commit' } };
  const secondProposal = await adapter.call('propose_update', secondInput, context('records.propose_update', secondInput));
  const secondArgs = { ...secondInput, expectedRecordHash: secondProposal.expectedRecordHash, proposalDigest: secondProposal.proposalDigest };
  const second = await adapter.call('apply_approved_update', secondArgs, context('records.apply_approved_update', secondArgs, 'approval',
    { actor: approvalActor, origin: 'local-operator', reasonHash: digest('second approval'), expiresAt: 50_000 }));
  assert.equal(second.revision, 3);
  assert.equal(await readFile(join(root, 'operations', `${first.operationId}.receipt.json`), 'utf8'), originalReceipt);
  const status = await adapter.call('operation_status', { operationId: first.operationId },
    context('records.operation_status', { operationId: first.operationId }));
  assert.equal(status.revision, 2);

  const intent = JSON.parse(await readFile(join(root, 'operations', `${first.operationId}.intent.json`), 'utf8'));
  const inspected = await adapter.inspectOperation({ intent, actor: approvalActor, reason: 'verify first commit' });
  assert.equal(inspected.status, 'committed');
  assert.equal(inspected.revision, 2);
  assert.equal(inspected.recordHash, first.recordHash);
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).revision, 3);
});

test('stale content at the same revision conflicts and local inspection never clears a pending fence', async t => {
  const { adapter, root, recordPath } = await fixture(t);
  const input = { recordId: seed.id, expectedRevision: 1, patch: { title: 'Approved title' } };
  const proposal = await adapter.call('propose_update', input, context('records.propose_update', input));
  const args = { ...input, expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest };
  const approval = { actor: approvalActor, origin: 'local-operator', reasonHash: digest('approved'), expiresAt: 50_000 };
  const approved = context('records.apply_approved_update', args, 'approval', approval);
  const changed = { ...seed, title: 'Unexpected concurrent edit' };
  await writeFile(recordPath, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(adapter.call('apply_approved_update', args, approved), { code: 'RECORDS_CONFLICT' });

  const operationId = approved.operationId;
  const intent = { format: 1, agentId: identity.agentId, mailbox: identity.mailbox, connection: 'records', operationId,
    tool: 'records.apply_approved_update', argsHash: digest(args), recordId: seed.id, expectedRevision: 1,
    expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest,
    policyHash: digest('policy'), actorHash: digest(actor), approverHash: digest(approvalActor),
    approvalReasonHash: approval.reasonHash, approvalExpiresAt: approval.expiresAt, issuedAt: 200 };
  const pending = join(root, 'records', seed.id, 'pending.json');
  await writeFile(pending, JSON.stringify({ operationId, argsHash: digest(args), expectedRevision: 1,
    expectedRecordHash: proposal.expectedRecordHash, createdAt: 200 }), { mode: 0o600 });
  const operations = join(root, 'operations');
  await writeFile(join(operations, `${operationId}.intent.json`), JSON.stringify(intent), { mode: 0o600 });
  const result = await adapter.inspectOperation({ intent, actor: approvalActor, reason: 'check unchanged intent' });
  assert.equal(result.status, 'unresolved');
  assert.equal(JSON.parse(await readFile(pending, 'utf8')).operationId, operationId);
});

test('fresh exact approval repairs a pre-journal crash and rebinds a not-applied intent', async t => {
  let currentTime=200;
  const { adapter, root } = await fixture(t,{clock:()=>currentTime});
  const input = { recordId: seed.id, expectedRevision: 1, patch: { title: 'Freshly approved' } };
  const proposal = await adapter.call('propose_update', input, context('records.propose_update', input));
  const args = { ...input, expectedRecordHash: proposal.expectedRecordHash, proposalDigest: proposal.proposalDigest };
  const firstGrant = { actor: approvalActor, origin: 'local-operator', reasonHash: digest('first approval'), expiresAt: 50_000 };
  const firstContext = context('records.apply_approved_update', args, 'approval', firstGrant, 200);
  const firstIntent = createRecordsIntent(firstContext, { name: 'records.apply_approved_update', args });
  const pendingPath = join(root, 'records', seed.id, 'pending.json');
  await writeFile(pendingPath, JSON.stringify({ operationId: firstContext.operationId, argsHash: digest(args),
    expectedRevision: 1, expectedRecordHash: proposal.expectedRecordHash, createdAt: 200 }), { mode: 0o600 });
  const intentPath = join(root, 'operations', `${firstContext.operationId}.intent.json`);
  await writeFile(intentPath, JSON.stringify(firstIntent), { mode: 0o600 });
  const notApplied = await adapter.inspectOperation({ intent: firstIntent, actor: approvalActor, reason: 'verify no publication' });
  assert.equal(notApplied.status, 'not-applied');

  const nextGrant = { actor: approvalActor, origin: 'local-operator', reasonHash: digest('renewed approval'), expiresAt: 60_000 };
  currentTime=300;
  const nextContext = context('records.apply_approved_update', args, 'approval', nextGrant, 300);
  const result = await adapter.call('apply_approved_update', args, nextContext);
  assert.equal(result.status, 'committed');
  const persisted = JSON.parse(await readFile(intentPath, 'utf8'));
  assert.equal(persisted.approvalReasonHash, nextGrant.reasonHash);
  assert.equal(persisted.issuedAt, 300);
  const archived = join(root, 'operations', `${firstContext.operationId}.attempt-${digest(firstIntent).slice(0, 32)}.json`);
  assert.deepEqual(JSON.parse(await readFile(archived, 'utf8')), firstIntent);
});

test('same-process calls serialize and close waits for queued work before releasing the lease', async t => {
  let releasePublish;
  let publishStarted;
  const started=new Promise(resolve=>{publishStarted=resolve;});
  const blocked=new Promise(resolve=>{releasePublish=resolve;});
  const {adapter}=await fixture(t,{afterPublish:async()=>{publishStarted();await blocked;}});
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Serialized update'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const grant={actor:approvalActor,origin:'local-operator',reasonHash:digest('serialize'),expiresAt:50_000};
  const approved=context('records.apply_approved_update',args,'approval',grant);
  const first=adapter.call('apply_approved_update',args,approved);
  await started;
  const second=adapter.call('apply_approved_update',args,approved);
  let closeComplete=false;
  const closing=adapter.close().then(()=>{closeComplete=true;});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(closeComplete,false);
  releasePublish();
  const [one,two]=await Promise.all([first,second]);
  await closing;
  assert.deepEqual(two,one);
  assert.equal(closeComplete,true);
  assert.throws(()=>adapter.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id})),{code:'RECORDS_UNAVAILABLE'});
});

test('stdio entrypoint inspect mode reads a private plan and returns a content-free receipt', async t => {
  const {adapter,root}=await fixture(t);
  const args={recordId:seed.id,expectedRevision:1,expectedRecordHash:digest(seed),patch:{title:'Not applied'},proposalDigest:'c'.repeat(64)};
  const grant={actor:approvalActor,origin:'local-operator',reasonHash:digest('inspect'),expiresAt:50_000};
  const intent=createRecordsIntent(context('records.apply_approved_update',args,'approval',grant),
    {name:'records.apply_approved_update',args});
  const policyPath=join(root,'actor-policy.json'),intentPath=join(root,'intent.json');
  await mkdir(join(root,'operations'),{mode:0o700});
  await writeFile(policyPath,JSON.stringify(domainPolicy),{mode:0o600});
  await writeFile(intentPath,JSON.stringify(intent),{mode:0o600});
  await writeFile(join(root,'operations',`${intent.operationId}.intent.json`),JSON.stringify(intent),{mode:0o600});
  await adapter.close();
  const serverPath=fileURLToPath(new URL('../mcp/records/server.mjs',import.meta.url));
  const {stdout}=await execFile(process.execPath,[serverPath,'inspect','--root',root,'--policy',policyPath,
    '--intent',intentPath,'--actor',approvalActor,'--reason','test local inspection'],{timeout:5000});
  const receipt=JSON.parse(stdout);
  assert.equal(receipt.status,'not-applied');
  assert.equal(receipt.operationId,intent.operationId);
  assert.equal(Object.hasOwn(receipt,'content'),false);
});

test('revision ceiling rejects updates before writing a fence or unsafe increment', async t => {
  const {adapter,recordPath,root}=await fixture(t);
  const ceiling={...seed,revision:Number.MAX_SAFE_INTEGER};
  await writeFile(recordPath,`${JSON.stringify(ceiling,null,2)}\n`,{mode:0o600});
  const input={recordId:seed.id,expectedRevision:ceiling.revision,patch:{title:'Must remain unchanged'}};
  await assert.rejects(adapter.call('propose_update',input,context('records.propose_update',input)),{code:'RECORDS_CONFLICT'});
  assert.equal((await readFile(recordPath,'utf8')),`${JSON.stringify(ceiling,null,2)}\n`);
  await assert.rejects(readFile(join(root,'records',seed.id,'pending.json')),{code:'ENOENT'});
});

test('local inspection rejects future-dated intent', async t => {
  const {adapter}=await fixture(t);
  const args={recordId:seed.id,expectedRevision:1,expectedRecordHash:digest(seed),patch:{title:'Future'},proposalDigest:'d'.repeat(64)};
  const intent=createRecordsIntent(context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('future'),expiresAt:50_000},500),
  {name:'records.apply_approved_update',args});
  await assert.rejects(adapter.inspectOperation({intent,actor:approvalActor,reason:'future intent'}),{code:'RECORDS_DENIED'});
});

test('approved deletion publishes a content-free tombstone and exact replay cannot resurrect it', async t => {
  let policy=structuredClone(domainPolicy);
  const {adapter,root,recordPath}=await fixture(t,{policy:()=>policy});
  const proposalArgs={recordId:seed.id,expectedRevision:1};
  const proposal=await adapter.call('propose_delete',proposalArgs,context('records.propose_delete',proposalArgs));
  const args={...proposalArgs,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const approved=context('records.apply_approved_delete',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('delete synthetic record'),expiresAt:50_000});
  const committed=await adapter.call('apply_approved_delete',args,approved);
  const tombstone=JSON.parse(await readFile(recordPath,'utf8'));
  assert.equal(committed.status,'committed');
  assert.equal(tombstone.revision,2);
  assert.equal(tombstone.deleted,true);
  assert.deepEqual({title:tombstone.title,content:tombstone.content,tags:tombstone.tags},{title:'',content:'',tags:[]});
  assert.equal(tombstone.lastExpectedRecordHash,proposal.expectedRecordHash);
  await adapter.close();

  policy.members[actor].read=[];
  const restarted=createRecordsAdapter({root,policy:()=>policy,clock:()=>200});
  t.after(()=>restarted.close());
  await assert.rejects(restarted.call('apply_approved_delete',args,approved),{code:'RECORDS_DENIED'});
  policy=structuredClone(domainPolicy);
  const replay=await restarted.call('apply_approved_delete',args,approved);
  assert.deepEqual(replay,committed);
  await assert.rejects(restarted.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id})),{code:'RECORDS_DENIED'});
  assert.deepEqual((await restarted.call('search',{query:'Current',limit:10},context('records.search',{query:'Current',limit:10}))).items,[]);
  await assert.rejects(restarted.call('propose_update',{recordId:seed.id,expectedRevision:2,patch:{title:'Resurrection'}},
    context('records.propose_update',{recordId:seed.id,expectedRevision:2,patch:{title:'Resurrection'}})),{code:'RECORDS_DENIED'});
  await assert.rejects(restarted.call('propose_delete',{recordId:seed.id,expectedRevision:2},
    context('records.propose_delete',{recordId:seed.id,expectedRevision:2})),{code:'RECORDS_DENIED'});
  assert.equal(await readFile(recordPath,'utf8'),`${JSON.stringify(tombstone,null,2)}\n`);
});

test('delete marker after publication recovers its receipt after restart without a second revision', async t => {
  let interrupt=true;
  const {adapter,root,recordPath}=await fixture(t,{afterPublish:async()=>{if(interrupt){interrupt=false;throw new Error('synthetic interruption');}}});
  const proposalArgs={recordId:seed.id,expectedRevision:1};
  const proposal=await adapter.call('propose_delete',proposalArgs,context('records.propose_delete',proposalArgs));
  const args={...proposalArgs,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const approved=context('records.apply_approved_delete',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('interrupted delete'),expiresAt:50_000});
  await assert.rejects(adapter.call('apply_approved_delete',args,approved),{code:'RECORDS_UNCERTAIN'});
  const published=JSON.parse(await readFile(recordPath,'utf8'));
  assert.equal(published.revision,2);
  assert.equal(published.deleted,true);
  await adapter.close();

  const restarted=createRecordsAdapter({root,policy:domainPolicy,clock:()=>200});
  t.after(()=>restarted.close());
  const recovered=await restarted.call('apply_approved_delete',args,approved);
  assert.equal(recovered.status,'committed');
  assert.equal(recovered.revision,2);
  const receipt=await restarted.call('operation_status',{operationId:approved.operationId},
    context('records.operation_status',{operationId:approved.operationId}));
  assert.equal(receipt.status,'committed');
  assert.equal(receipt.revision,2);
  assert.equal(JSON.parse(await readFile(recordPath,'utf8')).revision,2);
  await assert.rejects(restarted.call('propose_update',{recordId:seed.id,expectedRevision:2,patch:{title:'Restore'}},
    context('records.propose_update',{recordId:seed.id,expectedRevision:2,patch:{title:'Restore'}})),{code:'RECORDS_DENIED'});
});

test('a later approved write settles only a proven prior commit fence before proceeding', async t => {
  let interrupt=true;
  const {adapter,root,recordPath}=await fixture(t,{afterPublish:async()=>{if(interrupt){interrupt=false;throw new Error('synthetic interruption');}}});
  const firstInput={recordId:seed.id,expectedRevision:1,patch:{title:'First published update'}};
  const firstProposal=await adapter.call('propose_update',firstInput,context('records.propose_update',firstInput));
  const firstArgs={...firstInput,expectedRecordHash:firstProposal.expectedRecordHash,proposalDigest:firstProposal.proposalDigest};
  const firstContext=context('records.apply_approved_update',firstArgs,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('first update'),expiresAt:50_000});
  await assert.rejects(adapter.call('apply_approved_update',firstArgs,firstContext),{code:'RECORDS_UNCERTAIN'});
  const originalIntent=JSON.parse(await readFile(join(root,'operations',`${firstContext.operationId}.intent.json`),'utf8'));
  const oldPending=join(root,'records',seed.id,'pending.json');
  const inspected=await adapter.inspectOperation({intent:originalIntent,actor:approvalActor,reason:'verify prior commit'});
  assert.equal(inspected.status,'committed');
  assert.equal(JSON.parse(await readFile(oldPending,'utf8')).operationId,firstContext.operationId);
  await adapter.close();

  const restarted=createRecordsAdapter({root,policy:domainPolicy,clock:()=>200});
  t.after(()=>restarted.close());
  const current=await restarted.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id}));
  const nextInput={recordId:seed.id,expectedRevision:2,patch:{content:'Second approved update'}};
  const nextProposal=await restarted.call('propose_update',nextInput,context('records.propose_update',nextInput));
  assert.equal(nextProposal.expectedRecordHash,current.recordHash);
  const nextArgs={...nextInput,expectedRecordHash:nextProposal.expectedRecordHash,proposalDigest:nextProposal.proposalDigest};
  const nextContext=context('records.apply_approved_update',nextArgs,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('second update'),expiresAt:50_000});
  const second=await restarted.call('apply_approved_update',nextArgs,nextContext);
  assert.equal(second.status,'committed');
  assert.equal(second.revision,3);
  assert.equal(JSON.parse(await readFile(recordPath,'utf8')).revision,3);
  await assert.rejects(readFile(oldPending),{code:'ENOENT'});
  const audit=(await readFile(join(root,'audit.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const settlement=audit.findIndex(entry=>entry.event==='write-reconciled'&&entry.operationId===firstContext.operationId);
  const nextPrepared=audit.findIndex(entry=>entry.event==='write-prepared'&&entry.operationId===nextContext.operationId);
  assert.ok(settlement>=0&&settlement<nextPrepared);
  assert.equal(audit[settlement].approverHash,originalIntent.approverHash);
  assert.equal(audit[settlement].reasonHash,originalIntent.approvalReasonHash);
  const oldReceipt=await restarted.call('operation_status',{operationId:firstContext.operationId},
    context('records.operation_status',{operationId:firstContext.operationId}));
  assert.equal(oldReceipt.status,'committed');
  assert.equal(oldReceipt.revision,2);
});

test('a mismatched or unproven prior fence blocks a later write and remains intact', async t => {
  const {adapter,root,recordPath}=await fixture(t);
  const fence={operationId:'e'.repeat(64),argsHash:'f'.repeat(64),expectedRevision:1,
    expectedRecordHash:digest(seed),createdAt:200};
  const pendingPath=join(root,'records',seed.id,'pending.json');
  await writeFile(pendingPath,JSON.stringify(fence),{mode:0o600});
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Must remain blocked'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  await assert.rejects(adapter.call('apply_approved_update',args,context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('blocked'),expiresAt:50_000})),{code:'RECORDS_UNCERTAIN'});
  assert.equal(await readFile(recordPath,'utf8'),`${JSON.stringify(seed,null,2)}\n`);
  assert.deepEqual(JSON.parse(await readFile(pendingPath,'utf8')),fence);
});

test('a pending binding mismatch blocks settlement despite a valid prior marker', async t => {
  let interrupt=true;
  const {adapter,root,recordPath}=await fixture(t,{afterPublish:async()=>{if(interrupt){interrupt=false;throw new Error('synthetic interruption');}}});
  const firstInput={recordId:seed.id,expectedRevision:1,patch:{title:'Published before response loss'}};
  const firstProposal=await adapter.call('propose_update',firstInput,context('records.propose_update',firstInput));
  const firstArgs={...firstInput,expectedRecordHash:firstProposal.expectedRecordHash,proposalDigest:firstProposal.proposalDigest};
  const firstContext=context('records.apply_approved_update',firstArgs,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('first'),expiresAt:50_000});
  await assert.rejects(adapter.call('apply_approved_update',firstArgs,firstContext),{code:'RECORDS_UNCERTAIN'});
  const pendingPath=join(root,'records',seed.id,'pending.json');
  const mismatched={...JSON.parse(await readFile(pendingPath,'utf8')),argsHash:'9'.repeat(64)};
  await writeFile(pendingPath,JSON.stringify(mismatched),{mode:0o600});
  await adapter.close();

  const restarted=createRecordsAdapter({root,policy:domainPolicy,clock:()=>200});
  t.after(()=>restarted.close());
  const current=await restarted.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id}));
  const nextInput={recordId:seed.id,expectedRevision:2,patch:{content:'Must remain blocked'}};
  const nextProposal=await restarted.call('propose_update',nextInput,context('records.propose_update',nextInput));
  assert.equal(nextProposal.expectedRecordHash,current.recordHash);
  const nextArgs={...nextInput,expectedRecordHash:nextProposal.expectedRecordHash,proposalDigest:nextProposal.proposalDigest};
  await assert.rejects(restarted.call('apply_approved_update',nextArgs,context('records.apply_approved_update',nextArgs,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('blocked'),expiresAt:50_000})),{code:'RECORDS_UNCERTAIN'});
  assert.equal(JSON.parse(await readFile(recordPath,'utf8')).revision,2);
  assert.deepEqual(JSON.parse(await readFile(pendingPath,'utf8')),mismatched);
  await assert.rejects(readFile(join(root,'operations',`${firstContext.operationId}.receipt.json`)),{code:'ENOENT'});
});

test('committed replay rejects a noncommitted receipt without removing its same-operation fence', async t => {
  const {adapter,root}=await fixture(t);
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Receipt status check'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const approved=context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('receipt status'),expiresAt:50_000});
  const result=await adapter.call('apply_approved_update',args,approved);
  const receiptPath=join(root,'operations',`${result.operationId}.receipt.json`);
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  await writeFile(receiptPath,JSON.stringify({...receipt,status:'not-applied'}),{mode:0o600});
  const pending={operationId:result.operationId,argsHash:digest(args),expectedRevision:1,
    expectedRecordHash:proposal.expectedRecordHash,createdAt:200};
  const pendingPath=join(root,'records',seed.id,'pending.json');
  await writeFile(pendingPath,JSON.stringify(pending),{mode:0o600});
  await assert.rejects(adapter.call('apply_approved_update',args,approved),{code:'RECORDS_UNCERTAIN'});
  assert.deepEqual(JSON.parse(await readFile(pendingPath,'utf8')),pending);
});

test('committed replay does not retire a same-operation fence with mismatched args binding', async t => {
  const {adapter,root}=await fixture(t);
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Pending binding check'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const approved=context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('pending binding'),expiresAt:50_000});
  const result=await adapter.call('apply_approved_update',args,approved);
  const pending={operationId:result.operationId,argsHash:'a'.repeat(64),expectedRevision:1,
    expectedRecordHash:proposal.expectedRecordHash,createdAt:200};
  const pendingPath=join(root,'records',seed.id,'pending.json');
  await writeFile(pendingPath,JSON.stringify(pending),{mode:0o600});
  await assert.rejects(adapter.call('apply_approved_update',args,approved),{code:'RECORDS_UNCERTAIN'});
  assert.deepEqual(JSON.parse(await readFile(pendingPath,'utf8')),pending);
});

test('receipt replay requires audit success before it removes a confirmed pending fence', async t => {
  let fillAudit=false;
  const {adapter,root}=await fixture(t,{afterPublish:async()=>{
    if(fillAudit){fillAudit=false;await writeFile(join(root,'audit.ndjson'),Buffer.alloc(8_388_608),{mode:0o600});}
  }});
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Audit ordering'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const approved=context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('audit ordering'),expiresAt:50_000});
  fillAudit=true;
  await assert.rejects(adapter.call('apply_approved_update',args,approved),{code:'RECORDS_UNCERTAIN'});
  const receiptPath=join(root,'operations',`${approved.operationId}.receipt.json`);
  assert.equal(JSON.parse(await readFile(receiptPath,'utf8')).status,'committed');
  const pendingPath=join(root,'records',seed.id,'pending.json');
  assert.equal(JSON.parse(await readFile(pendingPath,'utf8')).operationId,approved.operationId);
  await assert.rejects(adapter.call('apply_approved_update',args,approved),{code:'RECORDS_UNAVAILABLE'});
  assert.equal(JSON.parse(await readFile(pendingPath,'utf8')).operationId,approved.operationId);
  await writeFile(join(root,'audit.ndjson'),'',{mode:0o600});
  const replay=await adapter.call('apply_approved_update',args,approved);
  assert.equal(replay.status,'committed');
  await assert.rejects(readFile(pendingPath),{code:'ENOENT'});
  const events=(await readFile(join(root,'audit.ndjson'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(event=>event.event==='write-reconciled'&&event.operationId===approved.operationId));
});

test('domain policy revocation takes effect before subsequent read and edit calls', async t => {
  let policy=structuredClone(domainPolicy);
  const {adapter}=await fixture(t,{policy:()=>policy});
  await adapter.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id}));
  policy.members[actor].read=[];
  await assert.rejects(adapter.call('get',{recordId:seed.id},context('records.get',{recordId:seed.id})),{code:'RECORDS_DENIED'});
  policy=structuredClone(domainPolicy);
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Approval pending'}};
  const proposal=await adapter.call('propose_update',input,context('records.propose_update',input));
  const args={...input,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  policy.members[actor].edit=[];
  await assert.rejects(adapter.call('apply_approved_update',args,context('records.apply_approved_update',args,'approval',
    {actor:approvalActor,origin:'local-operator',reasonHash:digest('approved'),expiresAt:50_000})),{code:'RECORDS_DENIED'});
});

test('domain policy revocation takes effect before delete and approver authority is rechecked', async t => {
  let policy=structuredClone(domainPolicy);
  const {adapter}=await fixture(t,{policy:()=>policy});
  const proposalArgs={recordId:seed.id,expectedRevision:1};
  const proposal=await adapter.call('propose_delete',proposalArgs,context('records.propose_delete',proposalArgs));
  const args={...proposalArgs,expectedRecordHash:proposal.expectedRecordHash,proposalDigest:proposal.proposalDigest};
  const grant={actor:approvalActor,origin:'local-operator',reasonHash:digest('approved'),expiresAt:50_000};
  policy.members[actor].delete=[];
  await assert.rejects(adapter.call('apply_approved_delete',args,context('records.apply_approved_delete',args,'approval',grant)),{code:'RECORDS_DENIED'});
  policy=structuredClone(domainPolicy);
  const input={recordId:seed.id,expectedRevision:1,patch:{title:'Approver revocation'}};
  const edit=await adapter.call('propose_update',input,context('records.propose_update',input));
  const update={...input,expectedRecordHash:edit.expectedRecordHash,proposalDigest:edit.proposalDigest};
  policy.approvers=[];
  await assert.rejects(adapter.call('apply_approved_update',update,context('records.apply_approved_update',update,'approval',grant)),{code:'RECORDS_DENIED'});
});
