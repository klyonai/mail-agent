import assert from 'node:assert/strict';
import test from 'node:test';
import {ambiguityCase,deniedCase,followupCase,followupMime,denySenderPolicy,ScenarioError} from '../scripts/live-email-scenarios.mjs';

const marker='MAILAGENT_LIVE_0123456789abcdef';
const parent={name:'arithmetic',subject:`${marker}_arithmetic`,answerMarker:`${marker}_arithmetic_answer`,expected:'95'};
const parentMessageId='<synthetic-parent-123@example.test>';
const from='sender@example.test',to='agent@example.test';

function fails(operation) {assert.throws(operation,error=>error instanceof ScenarioError&&error.code==='invalid-live-scenario'&&!/private|token|body/i.test(error.message));}

test('ambiguous request asks for missing context without supplying the desired clarification',()=>{
  const item=ambiguityCase(marker);
  assert.deepEqual({name:item.name,expected:item.expected,ambiguity:item.ambiguity},{name:'ambiguous',expected:'Which document and recipient?',ambiguity:true});
  assert.match(item.subject,/ambiguous/);assert.match(item.answerMarker,/ambiguous_answer/);
  assert.doesNotMatch(item.body,/Which document and recipient\?/i);
  assert.match(item.body,/no tools|do not.*tool/i);
});

test('follow-up case depends on parent identity and omits both answer values from its body',()=>{
  const item=followupCase(marker,parent);
  assert.deepEqual({name:item.name,subject:item.subject,answerMarker:item.answerMarker,expected:item.expected,followupOf:item.followupOf},
    {name:'follow-up',subject:`Re: ${parent.subject}`,answerMarker:`${marker}_follow-up_answer`,expected:'102',followupOf:'arithmetic'});
  assert.doesNotMatch(item.body,/95|102/);assert.match(item.body,/previous request|previous answer/i);
  assert.match(item.body,/no tools|do not.*tool/i);
});

test('denied case is unique, bounded, marked as denied and asks for no external action',()=>{
  const item=deniedCase(marker);
  assert.equal(item.name,'sender-denied');assert.equal(item.denied,true);
  assert.match(item.subject,/sender-denied/);assert.match(item.answerMarker,/sender-denied_answer/);
  assert.ok(item.body.length<=4096);assert.match(item.body,/no tools|do not.*tool/i);
});

test('followup MIME is base64 RFC822 text with exact safe subject, addresses and threading headers',()=>{
  const item=followupCase(marker,parent),encoded=followupMime({item,parentMessageId,from,to});
  assert.equal(typeof encoded,'string');
  const raw=Buffer.from(encoded,'base64').toString('utf8');
  assert.match(raw,/^MIME-Version: 1\.0\r\n/);assert.match(raw,/^Content-Type: text\/plain; charset=UTF-8\r\n/m);
  assert.match(raw,new RegExp(`^From: ${from.replaceAll('.','\\.')}\\r?$`,'m'));
  assert.match(raw,new RegExp(`^To: ${to.replaceAll('.','\\.')}\\r?$`,'m'));
  assert.match(raw,new RegExp(`^Subject: ${item.subject.replaceAll('.','\\.')}\\r?$`,'m'));
  assert.match(raw,new RegExp(`^In-Reply-To: ${parentMessageId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\r?$`,'m'));
  assert.match(raw,new RegExp(`^References: ${parentMessageId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\r?$`,'m'));
  assert.ok(raw.split('\r\n').every(line=>Buffer.byteLength(line)<=998));
  const sections=raw.split('\r\n\r\n');
  assert.equal(sections.length,2);assert.equal(sections[1],item.body);
});

test('followup MIME rejects unsafe identity, header injection and malformed cases',()=>{
  const item=followupCase(marker,parent);
  for(const value of [
    {parentMessageId:'<bad\r\nBcc:x@example.test>'},{parentMessageId:'x@example.test'},
    {parentMessageId:`<${'x'.repeat(600)}@example.test>`},{from:'sender@example.test\r\nBcc:x@example.test'},
    {to:'agent@example.test\nCc:x@example.test'},{from:'Jörg@example.test'},{to:'not-an-address'},
    {item:{...item,subject:'Re: safe\r\nBcc: x@example.test'}},{item:{...item,body:'private body'}},
    {item:{...item,subject:null}},{item:{...item,subject:undefined}},{item:{...item,subject:123}},
    {item:{...item,expected:'unsafe'}},
  ]) fails(()=>followupMime({item,parentMessageId,from,to,...value}));
});

test('denySenderPolicy clones and narrows the suite copy without widening other policy',()=>{
  const config={mailbox:{address:'agent@example.test'},policy:{senders:['sender@example.test','other@example.test'],recipients:['sender@example.test'],approvers:['approver@example.test'],reply:'sender'}};
  const narrowed=denySenderPolicy(config,'SENDER@example.test');
  assert.deepEqual(narrowed.policy.senders,['other@example.test']);
  assert.deepEqual(narrowed.policy.recipients,config.policy.recipients);
  assert.deepEqual(narrowed.policy.approvers,config.policy.approvers);
  assert.deepEqual(narrowed.mailbox,config.mailbox);assert.deepEqual(config.policy.senders,['sender@example.test','other@example.test']);
  assert.notEqual(narrowed,config);assert.notEqual(narrowed.policy,config.policy);
});

test('empty denied sender policy falls back to the runtime ignored self address and rejects malformed inputs',()=>{
  const config={mailbox:{address:'agent@example.test'},policy:{senders:['sender@example.test'],recipients:['sender@example.test']}};
  assert.deepEqual(denySenderPolicy(config,'sender@example.test').policy.senders,['agent@example.test']);
  for(const [value,sender] of [[{},'sender@example.test'],[config,'bad\r\n@example.test']]) fails(()=>denySenderPolicy(value,sender));
  assert.deepEqual(denySenderPolicy(config,'missing@example.test').policy.senders,config.policy.senders);
});
