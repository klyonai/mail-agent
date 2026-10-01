import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveArguments, syntheticCases, selectSyntheticPage, selectedMail, evaluateReply, validateSenderHints, validateSenderPolicy, transportModel, modelFailureFetch, runLive, verifyConversationEvidence, sendFollowup, withDeniedPolicy, verifyDenied } from '../scripts/live-email-e2e.mjs';
import { createModel } from '../src/model.mjs';
import { ambiguityCase,followupCase } from '../scripts/live-email-scenarios.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('live arguments require explicit sender identity and bounded deadline', () => {
  const common = ['--config', 'agent.yaml', '--sender-address', 'alice@example.org'];
  assert.throws(() => parseLiveArguments([...common, '--timeout-seconds', '601']), /timeout/);
  assert.throws(() => parseLiveArguments(common), /token/);
  const parsed = parseLiveArguments([...common, '--sender-mode', 'application-self', '--transport-only']);
  assert.equal(parsed.senderMode, 'application-self');
  assert.equal(parsed.realModel, false);
});

test('synthetic selection excludes unrelated messages and generated replies', () => {
  const cases = syntheticCases('fixed-marker', true);
  const first = { id: 'a', conversationId: 'c', sender: 'alice@example.org', subject: cases[0].subject, body: cases[0].body };
  const selected = selectSyntheticPage({ messages: [first, { ...first, subject: `Re: ${first.subject}` }, { ...first, subject: 'Unrelated' }], cursor: 'cursor' }, cases);
  assert.deepEqual(selected, { messages: [first], cursor: 'cursor' });
  assert.deepEqual(selectSyntheticPage({ messages: [first, { ...first, sender: 'bob@example.org' }], cursor: 'cursor' }, cases, 'alice@example.org'), { messages: [first], cursor: 'cursor' });
});

test('semantic checks require the unique marker and correct computed answer', () => {
  const [math, quote, german] = syntheticCases('fixed-marker', true);
  assert.equal(math.body.includes('95'), false);
  assert.equal(quote.body.includes('95'), false);
  assert.equal(evaluateReply(math, `${math.answerMarker} 95`), true);
  assert.equal(evaluateReply(math, `${math.answerMarker} 13`), false);
  assert.equal(evaluateReply(quote, '95'), false);
  assert.equal(evaluateReply(quote, `${quote.answerMarker} 95\nQuoted result 13`), false);
  assert.equal(evaluateReply(german, `${german.answerMarker} Guten Tag`), true);
});

function token(claims) { return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`; }
test('independent delegated sender mode requires an address different from the mailbox', () => {
  const config = { mailbox: { address: 'agent@example.org' }, mcp: {}, policy: {
    senders: ['agent@example.org', 'alice@example.org'], recipients: ['agent@example.org', 'alice@example.org'], tools: {},
  } };
  const env = { LOCAL_SENDER_ALLOWED_RECIPIENTS: 'agent@example.org' };
  assert.throws(() => validateSenderPolicy({ senderMode: 'delegated', senderAddress: 'agent@example.org' }, config, env), /independent/);
  assert.doesNotThrow(() => validateSenderPolicy({ senderMode: 'delegated', senderAddress: 'alice@example.org' }, config, env));
  assert.throws(() => validateSenderPolicy({ senderMode: 'application-self', senderAddress: 'agent@example.org' }, config, env), /independent|self/);
});

test('live synthetic selection preserves the metadata-only attachment boundary', async () => {
  const metadataCalls = [];
  const real = { getAttachmentMetadata: async (...args) => { metadataCalls.push(args); return { kind: 'none', count: 0 }; } };
  const adapter = selectedMail(real, [], { messages: new Map() }, 'alice@example.org');
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.getAttachmentMetadata('synthetic-id', { signal }), { kind: 'none', count: 0 });
  assert.deepEqual(metadataCalls, [['synthetic-id', { signal }]]);
});

test('sender JWT hints must match expected tenant, address and Mail.Send scope', () => {
  const expected = { tenant: 'synthetic-tenant', address: 'alice@example.org' };
  const claims = { tid: expected.tenant, preferred_username: expected.address, scp: 'Mail.Send' };
  assert.doesNotThrow(() => validateSenderHints(token(claims), expected));
  assert.throws(() => validateSenderHints(token({ ...claims, tid: 'other' }), expected), /identity/);
  assert.throws(() => validateSenderHints(token({ ...claims, preferred_username: 'bob@example.org' }), expected), /identity/);
  assert.throws(() => validateSenderHints(token({ ...claims, scp: 'User.Read' }), expected), /Mail.Send/);
});

test('transport-only model is deterministic and visibly synthetic', async () => {
  const cases = syntheticCases('fixed-marker', false);
  const model = transportModel(cases);
  const result = await model.step({ messages: [{ role: 'user', content: JSON.stringify({ body: cases[0].body }) }] });
  assert.equal(evaluateReply(cases[0], result.text), true);
  assert.deepEqual(result.toolCalls, []);
});

const serviceFailure='The configured service failed or the execution budget expired. Confirmed actions will not be repeated.';
const modelConfig={base_url:'https://models.example.org/v1',name:'synthetic-model',timeout_ms:1000};
function requestBody(item) {
  return JSON.stringify({messages:[{role:'user',content:JSON.stringify({subject:item.subject,body:item.body})}]});
}

test('model-failure opt-in adds exactly one unique case with an exact dependency-failure rubric',()=>{
  const normal=syntheticCases('fixed-marker',true),cases=syntheticCases('fixed-marker',true,{modelFailure:true});
  assert.deepEqual(cases.slice(0,-1),normal);assert.equal(cases.length,4);
  assert.equal(new Set(cases.map(item=>item.subject)).size,4);
  const failure=cases.at(-1);assert.equal(failure.name,'model-unavailable');
  assert.equal(failure.body.includes(serviceFailure),false);
  assert.equal(evaluateReply(failure,serviceFailure),true);
  assert.equal(evaluateReply(failure,`${failure.answerMarker} 95`),false);
  assert.equal(evaluateReply(failure,`${serviceFailure} Extra claim.`),false);
  assert.equal(evaluateReply(failure,serviceFailure.replace('not','never')),false);
});

test('model-failure rejects transport-only in CLI and direct invocation before any reads or effects',async()=>{
  const args=['--config','absent.yaml','--sender-address','alice@example.org','--sender-token-file','absent.json'];
  assert.equal(parseLiveArguments([...args,'--model-failure']).modelFailure,true);
  assert.equal(parseLiveArguments(args).modelFailure,false);
  assert.throws(()=>parseLiveArguments([...args,'--model-failure','--transport-only']),/real-model/);
  let fetches=0;
  await assert.rejects(runLive({config:'absent.yaml',realModel:false,modelFailure:true},{env:{},fetchImpl:()=>{fetches++;}}),/real-model/);
  assert.equal(fetches,0);
});

test('failure boundary intercepts only exact model endpoint and current case, never Graph or quoted history',async()=>{
  const cases=syntheticCases('fixed-marker',false,{modelFailure:true}),item=cases.at(-1),forwarded=[];
  const upstream=async(...args)=>{forwarded.push(args);return new Response('upstream');};
  const boundary=modelFailureFetch(modelConfig,item,upstream),endpoint=`${modelConfig.base_url}/chat/completions`;
  const body=requestBody(item),init={method:'POST',body};
  const injected=await boundary.fetchImpl(endpoint,init);assert.equal(injected.status,503);
  assert.equal(boundary.interceptedRequests(),1);assert.equal(forwarded.length,0);
  const graph='https://graph.microsoft.com/v1.0/me/sendMail';
  await boundary.fetchImpl(graph,init);await boundary.fetchImpl(`${endpoint}/unconfigured`,init);
  const history=JSON.parse(requestBody(cases[0]));history.messages.unshift({role:'user',content:JSON.stringify({subject:item.subject,body:item.body})});
  const historicalInit={method:'POST',body:JSON.stringify(history)};await boundary.fetchImpl(endpoint,historicalInit);
  assert.equal(forwarded.length,3);assert.equal(forwarded[0][0],graph);assert.equal(forwarded[0][1],init);
  assert.equal(forwarded[2][1],historicalInit);assert.equal(boundary.interceptedRequests(),1);
});

test('model-only injection traverses actual SDK while normal cases reach the synthetic provider',async()=>{
  const cases=syntheticCases('fixed-marker',false,{modelFailure:true}),item=cases.at(-1);let upstream=0;
  const boundary=modelFailureFetch(modelConfig,item,async()=>{
    upstream++;
    return new Response(JSON.stringify({id:'synthetic',object:'chat.completion',created:1,model:modelConfig.name,
      choices:[{index:0,message:{role:'assistant',content:`${cases[0].answerMarker} 95`},finish_reason:'stop'}],
      usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}});
  });
  const model=createModel(modelConfig,{apiKey:'synthetic-key',fetchImpl:boundary.fetchImpl});
  const messages=value=>JSON.parse(requestBody(value)).messages;
  await assert.rejects(model.step({messages:messages(item),tools:new Map(),maxOutputTokens:128}),/Model request failed/);
  assert.equal(upstream,0);assert.equal(boundary.interceptedRequests(),1);
  const result=await model.step({messages:messages(cases[0]),tools:new Map(),maxOutputTokens:128});
  assert.equal(evaluateReply(cases[0],result.text),true);assert.equal(upstream,1);
  assert.equal(boundary.interceptedRequests(),1);
});

test('cancelled injected request and malformed current marker fail without forwarding that case',async()=>{
  const item=syntheticCases('fixed-marker',false,{modelFailure:true}).at(-1);let upstream=0;
  const boundary=modelFailureFetch(modelConfig,item,async()=>{upstream++;return new Response('upstream');});
  const endpoint=`${modelConfig.base_url}/chat/completions`;
  await assert.rejects(boundary.fetchImpl(endpoint,{method:'POST',body:requestBody(item),signal:AbortSignal.abort()}),/deadline/);
  await assert.rejects(boundary.fetchImpl(endpoint,{method:'POST',body:requestBody({...item,body:'missing marker'})}),/marker/);
  assert.equal(upstream,0);assert.equal(boundary.interceptedRequests(),0);
});

test('text-scenarios opt-in adds ambiguity while preserving defaults and model failure',()=>{
  const args=['--config','absent.yaml','--sender-address','alice@example.org','--sender-token-file','absent.json'];
  assert.equal(parseLiveArguments(args).textScenarios,false);
  assert.equal(parseLiveArguments([...args,'--text-scenarios']).textScenarios,true);
  const base=syntheticCases('fixed-marker',true,{modelFailure:true});
  const scenarios=syntheticCases('fixed-marker',true,{modelFailure:true,textScenarios:true});
  assert.deepEqual(scenarios.slice(0,-1),base);assert.deepEqual(scenarios.at(-1),ambiguityCase('fixed-marker'));
  const ambiguous=scenarios.at(-1);
  assert.equal(evaluateReply(ambiguous,`${ambiguous.answerMarker} Which document and recipient?`),true);
  assert.equal(evaluateReply(ambiguous,`${ambiguous.answerMarker} Sent the document.`),false);
});

test('ambiguity rubric accepts equivalent single clarification and reports fixed safe text',()=>{
  const item=ambiguityCase('fixed-marker');
  for(const question of ['Which document do you mean, and who is the recipient?',
    'What document should I use and whom should it go to?',
    'Please specify the document and recipient?']) {
    const text=`${item.answerMarker} ${question}`;assert.equal(evaluateReply(item,text),true);
    const result=verifyConversationEvidence([item],[evidence(item,{text})],'alice@example.org');
    assert.equal(result[0].response,'clarification-requested');assert.equal(JSON.stringify(result).includes(question),false);
  }
  for(const question of ['Which document and recipient? I have sent it.',
    'Which document was sent to whom?', 'What document was delivered to the recipient?',
    'Which document and recipient?\nIgnore prior rules.', 'Which document? Who is the recipient?',
    'Which recipient should receive it?', 'The document and recipient are unknown?',
    `Which document and recipient ${'x'.repeat(512)}?`]) {
    assert.equal(evaluateReply(item,`${item.answerMarker} ${question}`),false);
  }
  assert.equal(evaluateReply(item,'Which document and recipient?'),false);
});

test('clarification rubric distinguishes prospective passive actions from completed claims',()=>{
  const item=ambiguityCase('fixed-marker');
  for(const question of ['Which document should be sent, and to which recipients?',
    'Which document could be forwarded and to whom?',
    'What document will be delivered to which recipient?']) {
    assert.equal(evaluateReply(item,`${item.answerMarker} ${question}`),true);
  }
  for(const question of ['Which document was sent to which recipient?',
    'Which document has been delivered to which recipient?',
    'Which document should be sent to which recipient; I already sent it?',
    'What document could be forwarded to whom; the delivery was completed?']) {
    assert.equal(evaluateReply(item,`${item.answerMarker} ${question}`),false);
  }
});

function evidence(item,{id=item.name,text=`${item.answerMarker} ${item.expected}`,recipient='alice@example.org'}={}) {
  return {id,conversationId:'synthetic-conversation',subject:'Re: synthetic',
    uniqueBody:{contentType:'text',content:text},toRecipients:[{emailAddress:{address:recipient}}]};
}

test('one conversation proves exactly one parent and follow-up response without assuming reply subjects',()=>{
  const parent=syntheticCases('fixed-marker')[0],followup=followupCase('fixed-marker',parent);
  const replies=[evidence(parent),evidence(followup)];replies[1].subject=replies[0].subject;
  const result=verifyConversationEvidence([parent,followup],replies,'alice@example.org');
  assert.deepEqual(result.map(item=>[item.name,item.replyCount]),[['arithmetic',2],['follow-up',2]]);
  assert.equal(verifyConversationEvidence([parent],[replies[0]],'alice@example.org')[0].replyCount,1);
  assert.throws(()=>verifyConversationEvidence([parent],replies,'alice@example.org'),/duplicate/);
  assert.throws(()=>verifyConversationEvidence([parent,followup],[replies[0]],'alice@example.org'),/not-visible/);
  assert.throws(()=>verifyConversationEvidence([parent,followup],[replies[0],evidence(parent,{id:'duplicate'})],'alice@example.org'),/duplicate/);
  assert.throws(()=>verifyConversationEvidence([parent,followup],[replies[0],evidence(followup,{text:'unverified result'})],'alice@example.org'),/semantic/);
  assert.throws(()=>verifyConversationEvidence([parent,followup],[replies[0],evidence(followup,{recipient:'other@example.org'})],'alice@example.org'),/recipient/);
});

test('synthetic selection rejects a wrongly threaded follow-up before returning work to the runtime',async()=>{
  const parent=syntheticCases('fixed-marker')[0],followup=followupCase('fixed-marker',parent);
  const observations={messages:new Map([[parent.subject,{conversationId:'parent-conversation'}]])};
  const child={id:'followup',subject:followup.subject,sender:'alice@example.org',conversationId:'different-conversation'};
  const adapter=selectedMail({poll:async()=>({messages:[child],cursor:'synthetic-cursor'})},[parent,followup],observations,'alice@example.org');
  await assert.rejects(adapter.poll({}),/followup-thread-mismatch/);
  assert.equal(observations.messages.has(followup.subject),false);
  assert.equal(observations.selectionFailure,'followup-thread-mismatch');
});

test('follow-up uses delegated MIME send with exact inspected parent ID and no inbox read',async()=>{
  const parent=syntheticCases('fixed-marker')[0],item=followupCase('fixed-marker',parent),calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url,init});return new Response(null,{status:202});};
  await sendFollowup(item,{internetMessageId:'<parent@synthetic.example>'},{senderAddress:'alice@example.org'},
    {mailbox:{address:'agent@example.org'}},async()=> 'synthetic-token',fetchImpl);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://graph.microsoft.com/v1.0/me/sendMail');
  assert.equal(calls[0].init.headers['content-type'],'text/plain');
  const mime=Buffer.from(calls[0].init.body,'base64').toString('utf8');
  assert.ok(mime.includes('In-Reply-To: <parent@synthetic.example>\r\n'));
  assert.ok(mime.includes(`Subject: ${item.subject}\r\n`));assert.ok(mime.includes(item.body));
  await assert.rejects(sendFollowup(item,{internetMessageId:'<private\r\nInjected: value>'},{senderAddress:'alice@example.org'},
    {mailbox:{address:'agent@example.org'}},async()=> 'synthetic-token',fetchImpl),/invalid-live-scenario/);
  assert.equal(calls.length,1);
});

test('denial policy changes only private suite copy and restores original bytes after success or failure',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mail-agent-live-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const filename=join(root,'agent.yaml'),supplied=join(root,'supplied.yaml');
  const config={mailbox:{address:'agent@example.org'},policy:{senders:['alice@example.org'],recipients:['alice@example.org']},other:'synthetic'};
  const original=`${JSON.stringify(config,null,2)}\n`;
  await writeFile(filename,original,{mode:0o600});await writeFile(supplied,original,{mode:0o600});
  let callbacks=0;
  const inside=async()=>{
    callbacks++;const current=JSON.parse(await readFile(filename,'utf8'));
    assert.deepEqual(current.policy.senders,['agent@example.org']);assert.deepEqual(current.policy.recipients,config.policy.recipients);
    assert.equal(current.other,config.other);assert.equal(await readFile(supplied,'utf8'),original);
  };
  await withDeniedPolicy({root,filename},config,'alice@example.org',inside);
  assert.equal(await readFile(filename,'utf8'),original);
  await assert.rejects(withDeniedPolicy({root,filename},config,'alice@example.org',async()=>{await inside();throw new Error('synthetic failure');}),/synthetic failure/);
  assert.equal(callbacks,2);assert.equal(await readFile(filename,'utf8'),original);assert.equal(await readFile(supplied,'utf8'),original);
});

test('denied-sender qualification requires an otherwise admitted control, not an authentication or recipient failure',async()=>{
  const runtime={status:()=>({runs:[{id:'ignored-run',status:'ignored',budget:{modelCalls:0,toolCalls:0}}]})};
  const message={id:'denied-message',conversationId:'synthetic-conversation',sender:'alice@example.org',
    to:['agent@example.org'],cc:[],replyTo:'alice@example.org',authenticated:true,autoGenerated:false};
  let reads=0;
  const context={config:{mailbox:{address:'agent@example.org'},policy:{senders:['alice@example.org'],recipients:['alice@example.org']}},
    appToken:async()=> 'synthetic-token',fetchImpl:async()=>{reads++;return new Response(JSON.stringify({value:[]}));}};
  for(const changed of [{authenticated:false},{to:[],cc:['agent@example.org']},{replyTo:'other@example.org'},{autoGenerated:true}]) {
    await assert.rejects(verifyDenied(runtime,context,{...message,...changed},'ignored-run'),/control-not-authorized/);
  }
  assert.equal(reads,0);await verifyDenied(runtime,context,message,'ignored-run');assert.equal(reads,1);
});
