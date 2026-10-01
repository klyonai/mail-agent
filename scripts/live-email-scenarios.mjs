const MAX_MARKER=128;
const MAX_SUBJECT=250;
const MAX_MESSAGE_ID=512;
const markerPattern=/^[A-Za-z0-9_-]{1,128}$/;
const subjectPattern=/^[A-Za-z0-9_. :-]{1,250}$/;
const addressPattern=/^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const messageIdPattern=/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+>$/;
const safeMessage='Live acceptance scenario input is invalid.';

export class ScenarioError extends Error {
  constructor() {super(safeMessage);this.name='ScenarioError';this.code='invalid-live-scenario';}
}
function invalid() {throw new ScenarioError();}
function validMarker(value) {return typeof value==='string'&&value.length<=MAX_MARKER&&markerPattern.test(value);}
function validateMarker(value) {if(!validMarker(value))invalid();return value;}
function caseBody(marker,action,question) {
  return `This is an authorized synthetic email acceptance check. ${action} Reply with only the marker ${marker} followed by ${question}. Do not call tools or change any external records.`;
}
function followupBody(marker) {
  return `This is a follow-up to the previous request and answer. Add seven to the previous answer. Reply with only the marker ${marker} followed by the result. Do not call tools or change any external records.`;
}
function parentValid(parent) {
  return parent&&typeof parent==='object'&&parent.name==='arithmetic'&&typeof parent.subject==='string'
    &&parent.subject.length<=MAX_SUBJECT&&subjectPattern.test(parent.subject)&&parent.subject.endsWith('_arithmetic');
}

export function ambiguityCase(marker) {
  const id=validateMarker(marker),answerMarker=`${id}_ambiguous_answer`;
  return {name:'ambiguous',subject:`${id}_ambiguous`,answerMarker,
    body:caseBody(answerMarker,'Please send the document to them. Ask one concise clarification question before taking any action.','your question'),
    expected:'Which document and recipient?',ambiguity:true};
}

export function followupCase(marker,parent) {
  const id=validateMarker(marker);
  if(!parentValid(parent))invalid();
  const answerMarker=`${id}_follow-up_answer`;
  return {name:'follow-up',subject:`Re: ${parent.subject}`,answerMarker,body:followupBody(answerMarker),expected:'102',followupOf:parent.name};
}

export function deniedCase(marker) {
  const id=validateMarker(marker),answerMarker=`${id}_sender-denied_answer`;
  return {name:'sender-denied',subject:`${id}_sender-denied`,answerMarker,
    body:`This is a bounded synthetic sender-denial check. Do not process or reply to this request, call tools, or change any external records. Marker ${answerMarker}.`,
    denied:true};
}

function validAddress(value) {return typeof value==='string'&&value.length<=254&&addressPattern.test(value);}
function validMessageId(value) {return typeof value==='string'&&value.length<=MAX_MESSAGE_ID&&messageIdPattern.test(value);}
function validSubject(value) {return typeof value==='string'&&subjectPattern.test(value);}
function validFollowupItem(item) {
  const keys=['name','subject','answerMarker','body','expected','followupOf'];
  return item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===keys.length
    &&keys.every(key=>Object.hasOwn(item,key))&&item.name==='follow-up'&&validSubject(item.subject)
    &&item.subject.startsWith('Re: ')&&validMarker(item.answerMarker)&&item.expected==='102'
    &&item.followupOf==='arithmetic'&&item.body===followupBody(item.answerMarker);
}

export function followupMime({item,parentMessageId,from,to}={}) {
  if(!validFollowupItem(item)||!validMessageId(parentMessageId)||!validAddress(from)||!validAddress(to))invalid();
  const lines=['MIME-Version: 1.0',`From: ${from}`,`To: ${to}`,`Subject: ${item.subject}`,
    `In-Reply-To: ${parentMessageId}`,`References: ${parentMessageId}`,'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit','',item.body];
  const raw=lines.join('\r\n');
  if(raw.split('\r\n').some(line=>Buffer.byteLength(line)>998))invalid();
  return Buffer.from(raw,'utf8').toString('base64');
}

export function denySenderPolicy(config,sender) {
  if(!config||typeof config!=='object'||Array.isArray(config)||!validAddress(config.mailbox?.address)
    ||!config.policy||typeof config.policy!=='object'||!Array.isArray(config.policy.senders)
    ||config.policy.senders.some(value=>!validAddress(value))||!validAddress(sender))invalid();
  const result=structuredClone(config),normalized=sender.toLowerCase();
  result.policy.senders=result.policy.senders.filter(value=>value.toLowerCase()!==normalized);
  if(!result.policy.senders.length)result.policy.senders=[result.mailbox.address];
  return result;
}
