import {constants} from 'node:fs';
import {lstat, mkdir, open, readdir, rename, unlink, link} from 'node:fs/promises';
import {chmodSync, lstatSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {TextDecoder} from 'node:util';
import {randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import Ajv from 'ajv';
import {DOMAIN_CONTEXT_CAPABILITY, DOMAIN_CONTEXT_KEY, validateDomainContext} from '../../src/domain-context.mjs';
import {digest} from '../../src/policy.mjs';
import {bindRecordsReceipt,createRecordsIntent,validateRecordsIntent,validateRecordsReceipt} from '../../src/records-reconciliation.mjs';

const idPattern=/^[a-z0-9][a-z0-9-]{0,63}$/;
const hashPattern=/^[a-f0-9]{64}$/;
const emailPattern=/^[^\s@<>]{1,128}@[a-z0-9.-]+$/;
const recordFields=['format','id','revision','type','title','content','tags','source','createdAt','updatedAt','updatedByHash','deleted'];
const optionalRecordFields=['lastOperationId','lastArgsHash','lastProposalDigest','lastExpectedRecordHash'];
const resultBytes=65_536, maxRecords=100, maxRecordBytes=65_536, maxQuery=256, maxContent=32_768;
const maxOperationEntries=20_000,maxAuditBytes=8_388_608;

const errors={
  RECORDS_INVALID:'The records request is invalid.', RECORDS_DENIED:'The record was not found or is not available to this requester.',
  RECORDS_CONFLICT:'The record changed; create a new proposal against its current revision.',
  RECORDS_UNCERTAIN:'The record update outcome is unresolved; check operation status before any further action.',
  RECORDS_UNAVAILABLE:'The records store is unavailable or unsafe.', RECORDS_BUSY:'The records folder is already owned by another server process.',
};

export class RecordsError extends Error {
  constructor(code='RECORDS_INVALID') { super(errors[code]??errors.RECORDS_INVALID); this.name='RecordsError'; this.code=code; }
}
function fail(code) { throw new RecordsError(code); }
function exact(value,keys) { return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)); }
function boundedText(value,max) { return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\p{Cc}\p{Cf}]/u.test(value); }
function sortedUnique(values,maxItems,maxLength) { return Array.isArray(values)&&values.length<=maxItems&&values.every((value,index)=>boundedText(value,maxLength)&&(!index||values[index-1]<value)); }
function validEmail(value) { return typeof value==='string'&&emailPattern.test(value)&&value===value.toLowerCase(); }

function validPolicyEnvelope(policy) {
  return exact(policy,['version','agentId','mailbox','connection','members','approvers'])&&policy.version===1
    &&boundedText(policy.agentId,64)&&validEmail(policy.mailbox)&&policy.connection==='records'
    &&policy.members&&typeof policy.members==='object'&&!Array.isArray(policy.members)&&Object.keys(policy.members).length<=1000;
}
function validApprovers(values) { return Array.isArray(values)&&values.length<=1000&&values.every(validEmail)&&new Set(values).size===values.length; }
function validMember(actor,scope) {
  return validEmail(actor)&&exact(scope,['read','edit','delete'])&&Object.values(scope).every(values=>
    sortedUnique(values,1000,64)&&values.every(value=>idPattern.test(value)));
}
function validatePolicy(policy) {
  if(!validPolicyEnvelope(policy)||!validApprovers(policy.approvers)||!Object.entries(policy.members).every(([actor,scope])=>validMember(actor,scope))) fail('RECORDS_INVALID');
  return structuredClone(policy);
}

function validRecordKeys(record) {const keys=Object.keys(record);return recordFields.every(key=>keys.includes(key))&&keys.every(key=>recordFields.includes(key)||optionalRecordFields.includes(key));}
function validRecordIdentity(record,id) {return record.format===1&&record.id===id&&idPattern.test(id)&&Number.isSafeInteger(record.revision)&&record.revision>0;}
function validRecordContent(record) {return boundedText(record.type,32)&&/^[-a-z0-9]+$/.test(record.type)
  &&(record.deleted?record.title==='':boundedText(record.title,256))&&typeof record.content==='string'
  &&Buffer.byteLength(record.content)<=maxContent&&sortedUnique(record.tags,20,64);}
function validRecordSource(record) {return exact(record.source,['kind','referenceHash'])&&['operator','email','import'].includes(record.source.kind)&&hashPattern.test(record.source.referenceHash);}
function validRecordTimes(record) {return Number.isSafeInteger(record.createdAt)&&record.createdAt>=0&&Number.isSafeInteger(record.updatedAt)
  &&record.updatedAt>=record.createdAt&&hashPattern.test(record.updatedByHash)&&typeof record.deleted==='boolean';}
function validRecordOperations(record) {return optionalRecordFields.every(key=>!Object.hasOwn(record,key)||hashPattern.test(record[key]));}
function validateRecord(record,id) {
  const validators=[validRecordKeys,validRecordContent,validRecordSource,validRecordTimes,validRecordOperations];
  if(!record||typeof record!=='object'||Array.isArray(record)||!validRecordIdentity(record,id)
    ||validators.some(validate=>!validate(record))||(record.deleted&&(record.title||record.content||record.tags.length))) fail('RECORDS_UNAVAILABLE');
  return record;
}

function tool(name,description,inputSchema) { return {name,description,inputSchema}; }
const idSchema={type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,63}$'};
const revision={type:'integer',minimum:1};
const patchSchema={type:'object',properties:{title:{type:'string',minLength:1,maxLength:256},content:{type:'string',maxLength:maxContent},tags:{type:'array',maxItems:20,uniqueItems:true,items:{type:'string',minLength:1,maxLength:64,pattern:'^[a-z0-9][a-z0-9-]*$'}}},minProperties:1,additionalProperties:false};
const definitions=[
  tool('search','Search records visible to the authenticated sender; results are bounded.',{type:'object',properties:{query:{type:'string',maxLength:maxQuery},limit:{type:'integer',minimum:1,maximum:20}},required:['query','limit'],additionalProperties:false}),
  tool('get','Read one record visible to the authenticated sender.',{type:'object',properties:{recordId:idSchema,revision},required:['recordId'],additionalProperties:false}),
  tool('propose_update','Validate a change against a visible record revision; does not write.',{type:'object',properties:{recordId:idSchema,expectedRevision:revision,patch:patchSchema},required:['recordId','expectedRevision','patch'],additionalProperties:false}),
  tool('apply_approved_update','Apply an exact locally approved proposal against its reviewed revision.',{type:'object',properties:{recordId:idSchema,expectedRevision:revision,expectedRecordHash:{type:'string',pattern:'^[a-f0-9]{64}$'},patch:patchSchema,proposalDigest:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['recordId','expectedRevision','expectedRecordHash','patch','proposalDigest'],additionalProperties:false}),
  tool('propose_delete','Review a tombstone against a visible record revision; does not write.',{type:'object',properties:{recordId:idSchema,expectedRevision:revision},required:['recordId','expectedRevision'],additionalProperties:false}),
  tool('apply_approved_delete','Tombstone a record only under exact local approval.',{type:'object',properties:{recordId:idSchema,expectedRevision:revision,expectedRecordHash:{type:'string',pattern:'^[a-f0-9]{64}$'},proposalDigest:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['recordId','expectedRevision','expectedRecordHash','proposalDigest'],additionalProperties:false}),
  tool('operation_status','Inspect one previously authorized operation without returning record content.',{type:'object',properties:{operationId:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['operationId'],additionalProperties:false}),
];
const ajv=new Ajv({allErrors:false,strict:false});
const inputValidators=new Map(definitions.map(definition=>[definition.name,ajv.compile(definition.inputSchema)]));

function permission(policy,actor,kind,id) { return policy.members[actor]?.[kind]?.includes(id)===true; }
function proposalDigest(kind,args) { return digest({format:1,kind,recordId:args.recordId,expectedRevision:args.expectedRevision,
  expectedRecordHash:args.expectedRecordHash,...(args.patch?{patch:args.patch}:{})}); }
function validPatchField([key,value]) {
  if(key==='title')return boundedText(value,256);
  if(key==='content')return typeof value==='string'&&Buffer.byteLength(value)<=maxContent;
  return key==='tags'&&sortedUnique(value,20,64);
}
function validatePatch(patch) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length
    ||Object.entries(patch).some(entry=>!validPatchField(entry))) fail('RECORDS_INVALID');
}

async function privateDirectory(path,create=false) {
  if(create) await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const value=await lstat(path);
  if(!value.isDirectory()||value.isSymbolicLink()||value.uid!==process.getuid()||(value.mode&0o077)) fail('RECORDS_UNAVAILABLE');
}
function leaseFile(path) {
  try {const value=lstatSync(path);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1||value.uid!==process.getuid()||(value.mode&0o077))fail('RECORDS_UNAVAILABLE');}
  catch(error){if(error.code!=='ENOENT')jsonError(error);}
}
function openLease(root) {
  const path=join(root,'.records-lease.sqlite');
  for(const suffix of ['','-journal','-wal','-shm'])leaseFile(`${path}${suffix}`);
  let db;
  try {
    db=new DatabaseSync(path);chmodSync(path,0o600);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS lease (slot INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
    leaseFile(path);return db;
  } catch(error) {
    db?.close();if(error.errcode===5||error.errcode===6||/database is locked/i.test(error.message))fail('RECORDS_BUSY');
    jsonError(error);
  }
}
async function boundedHandleText(handle,maximum) {
  const stat=await handle.stat();
  if(!safeFileStat(stat,maximum)) fail('RECORDS_UNAVAILABLE');
  const data=Buffer.alloc(stat.size+1),offset=await readExact(handle,data,stat.size);
  const after=await handle.stat();
  if(offset!==stat.size||after.size!==stat.size||after.ino!==stat.ino||after.nlink!==1) fail('RECORDS_UNAVAILABLE');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,offset));}catch{fail('RECORDS_UNAVAILABLE');}
}
function safeFileStat(stat,maximum) {return stat.isFile()&&stat.uid===process.getuid()&&stat.nlink===1&&!(stat.mode&0o077)&&stat.size<=maximum;}
async function readExact(handle,data,size) {
  let offset=0;
  while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  return Math.min(offset,size+1);
}
async function privateFile(path,maximum,{missing=false}={}) {
  let handle;
  try { handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW); }
  catch(error) { if(missing&&error.code==='ENOENT') return null; fail('RECORDS_UNAVAILABLE'); }
  try {
    return await boundedHandleText(handle,maximum);
  } finally { await handle.close(); }
}
async function readJson(path,maximum,options) {
  const raw=await privateFile(path,maximum,options);if(raw===null)return null;
  try{return JSON.parse(raw);}catch{fail('RECORDS_UNAVAILABLE');}
}
async function syncDirectory(path) { const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();} }
async function atomicJson(path,value,directory) {
  const temporary=join(directory,`.${randomUUID()}.tmp`),handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { await handle.writeFile(`${JSON.stringify(value,null,2)}\n`);await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary,path);await syncDirectory(directory); }
  catch(error) { await unlink(temporary).catch(()=>{});throw error; }
}
async function createJson(path,value,directory) {
  const temporary=join(directory,`.${randomUUID()}.tmp`),handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {await handle.writeFile(`${JSON.stringify(value,null,2)}\n`);await handle.sync();}finally{await handle.close();}
  try {await link(temporary,path);await unlink(temporary);await syncDirectory(directory);}
  catch(error){await unlink(temporary).catch(()=>{});if(error.code==='EEXIST')fail('RECORDS_BUSY');jsonError(error);}
}
async function removePrivate(path,directory) {
  const value=await lstat(path);
  if(!value.isFile()||value.isSymbolicLink()||value.uid!==process.getuid()||value.nlink!==1||(value.mode&0o077))fail('RECORDS_UNAVAILABLE');
  await unlink(path);await syncDirectory(directory);
}
function jsonError(error) { if(error instanceof RecordsError)throw error;fail('RECORDS_UNAVAILABLE'); }

/** Files are authoritative. This adapter never executes model-supplied paths or writes automatically. */
export function createRecordsAdapter({root,policy,clock=Date.now,afterPublish}={}) {
  if(typeof root!=='string'||!root||root.includes('\0')||typeof clock!=='function')fail('RECORDS_INVALID');
  const base=resolve(root),recordsRoot=join(base,'records'),operationsRoot=join(base,'operations');
  let fixedPolicy=typeof policy==='function'?undefined:validatePolicy(policy);let lease,closed=false,lockPromise,closing;
  let tail=Promise.resolve();
  async function refreshPolicy() { if(typeof policy==='function')fixedPolicy=validatePolicy(await policy()); }
  function defs(){return structuredClone(definitions);}
  async function acquire() {
    if(closed)fail('RECORDS_UNAVAILABLE');if(lease)return;
    if(lockPromise)return lockPromise;
    lockPromise=(async()=>{
      await privateDirectory(base);await privateDirectory(recordsRoot);await privateDirectory(operationsRoot,true);
      lease=openLease(base);
    })().catch(error=>{lockPromise=null;jsonError(error);});
    return lockPromise;
  }
  async function cleanupLock() {
    if(!lease)return;
    try{lease.exec('ROLLBACK');}catch{lease=null;return;}
    try{lease.close();}catch{lease=null;return;}
    lease=null;
  }
  async function loadRecord(id) {
    if(!idPattern.test(id))fail('RECORDS_INVALID');
    const directory=join(recordsRoot,id);await privateDirectory(directory);
    const record=await readJson(join(directory,'record.json'),maxRecordBytes);
    if(!record)fail('RECORDS_DENIED');return validateRecord(record,id);
  }
  function actorContext(name,args,raw) {
    const toolName=`records.${name}`;
    let context;try{context=validateDomainContext(raw,{now:clock(),agentId:fixedPolicy.agentId,mailbox:fixedPolicy.mailbox,tool:toolName,args,connection:fixedPolicy.connection});}
    catch{fail('RECORDS_DENIED');}
    const expected=name.startsWith('apply_approved_')?'approval':'automatic';
    if(context.authorization!==expected)fail('RECORDS_DENIED');
    return context;
  }
  function visible(actor,record) { if(!permission(fixedPolicy,actor,'read',record.id)||record.deleted)fail('RECORDS_DENIED'); }
  async function records() {
    const names=await readdir(recordsRoot,{withFileTypes:true});
    if(names.length>maxRecords||names.some(entry=>!entry.isDirectory()||entry.isSymbolicLink()||!idPattern.test(entry.name)))fail('RECORDS_UNAVAILABLE');
    const values=[];for(const entry of names)values.push(await loadRecord(entry.name));return values;
  }
  async function list(args,context) {
    const actor=actorContext('search',args,context).actor;
    const query=args.query.trim().toLowerCase(),limit=args.limit;
    if(args.query.length>maxQuery||!Number.isInteger(limit)||limit<1||limit>20)fail('RECORDS_INVALID');
    const items=(await records()).filter(record=>permission(fixedPolicy,actor,'read',record.id)&&!record.deleted
      &&(!query||`${record.title}\n${record.content}\n${record.tags.join(' ')}`.toLowerCase().includes(query)))
      .slice(0,limit).map(record=>({id:record.id,revision:record.revision,type:record.type,title:record.title,excerpt:record.content.slice(0,512),sourceHash:record.source.referenceHash}));
    return {items};
  }
  async function get(args,context) {
    const actor=actorContext('get',args,context).actor,record=await loadRecord(args.recordId);visible(actor,record);
    if(args.revision!==undefined&&args.revision!==record.revision)fail('RECORDS_CONFLICT');
    return {record:structuredClone(record),recordHash:digest(record)};
  }
  async function proposeUpdate(args,context) {
    const actor=actorContext('propose_update',args,context).actor;validatePatch(args.patch);
    if(!permission(fixedPolicy,actor,'edit',args.recordId))fail('RECORDS_DENIED');
    const record=await loadRecord(args.recordId);visible(actor,record);checkRevision(record,args.expectedRevision);
    const expectedRecordHash=digest(record),proposal={...args,expectedRecordHash};
    return {proposalDigest:proposalDigest('update',proposal),recordId:record.id,expectedRevision:record.revision,expectedRecordHash,patch:structuredClone(args.patch)};
  }
  async function proposeDelete(args,context) {
    const actor=actorContext('propose_delete',args,context).actor;
    if(!permission(fixedPolicy,actor,'delete',args.recordId))fail('RECORDS_DENIED');
    const record=await loadRecord(args.recordId);visible(actor,record);checkRevision(record,args.expectedRevision);
    const expectedRecordHash=digest(record),proposal={...args,expectedRecordHash};
    return {proposalDigest:proposalDigest('delete',proposal),recordId:record.id,expectedRevision:record.revision,expectedRecordHash};
  }
  function checkRevision(record,expected) {
    if(!Number.isSafeInteger(expected)||record.revision!==expected||record.revision>=Number.MAX_SAFE_INTEGER)fail('RECORDS_CONFLICT');
  }
  function exactApproval(context) { if(!context.approval||!fixedPolicy.approvers.includes(context.approval.actor))fail('RECORDS_DENIED'); }
  const operationFile=(operationId,suffix)=>join(operationsRoot,`${operationId}.${suffix}.json`);
  const pendingFile=recordId=>join(recordsRoot,recordId,'pending.json');
  async function operation(operationId,suffix) {
    if(!hashPattern.test(operationId))fail('RECORDS_INVALID');
    return readJson(operationFile(operationId,suffix),8192,{missing:true});
  }
  function receiptResult(receipt) {
    return {status:receipt.status,operationId:receipt.operationId,recordId:receipt.recordId,
      revision:receipt.revision,argsHash:receipt.argsHash,recordHash:receipt.recordHash};
  }
  function markerMatches(record,intent) {
    return record.lastOperationId===intent.operationId&&record.lastArgsHash===intent.argsHash
      &&record.lastProposalDigest===intent.proposalDigest&&record.lastExpectedRecordHash===intent.expectedRecordHash
      &&record.revision===intent.expectedRevision+1;
  }
  function validateIntent(intent,operationId) {try{const value=validateRecordsIntent(intent);if(value.operationId!==operationId)fail('RECORDS_UNAVAILABLE');return value;}catch{fail('RECORDS_UNAVAILABLE');} }
  function validateReceipt(receipt,operationId) {try{const value=validateRecordsReceipt(receipt);if(value.operationId!==operationId)fail('RECORDS_UNAVAILABLE');return value;}catch{fail('RECORDS_UNAVAILABLE');} }
  async function operationStatus(args,rawContext) {
    const context=actorContext('operation_status',args,rawContext),receipt=await operation(args.operationId,'receipt');
    if(receipt) {
      validateReceipt(receipt,args.operationId);
      if(!permission(fixedPolicy,context.actor,'read',receipt.recordId))fail('RECORDS_DENIED');
      return receiptResult(receipt);
    }
    const intent=await operation(args.operationId,'intent');
    if(!intent)return {operationId:args.operationId,status:'unknown'};
    validateIntent(intent,args.operationId);
    if(!permission(fixedPolicy,context.actor,'read',intent.recordId))fail('RECORDS_DENIED');
    const record=await loadRecord(intent.recordId),fingerprint=digest(record);
    if(markerMatches(record,intent))return receiptFromIntent(intent,'committed',record);
    const status=record.revision===intent.expectedRevision&&fingerprint===intent.expectedRecordHash?'not-applied':'unresolved';
    return receiptFromIntent(intent,status,record);
  }
  function validateInspector(intent,actor,reason) {
    if(intent.agentId!==fixedPolicy.agentId||intent.mailbox!==fixedPolicy.mailbox||intent.connection!==fixedPolicy.connection
      ||intent.issuedAt>clock()||!validEmail(actor)||!fixedPolicy.approvers.includes(actor)||!boundedText(reason,2048))fail('RECORDS_DENIED');
  }
  async function inspectReceipt(intent) {
    const saved=await operation(intent.operationId,'intent');
    if(saved&&digest(saved)!==digest(intent))fail('RECORDS_UNCERTAIN');
    const committed=await operation(intent.operationId,'receipt');
    let receipt;
    if(committed) {
      validateReceipt(committed,intent.operationId);
      try { receipt=bindRecordsReceipt(intent,committed,clock()); }
      catch { fail('RECORDS_UNCERTAIN'); }
    } else {
      receipt=await inspectUnreceipted(intent,saved);
    }
    return structuredClone(receipt);
  }
  async function inspectUnreceipted(intent,saved) {
    const pending=await pendingFor(intent.recordId);
    if(!saved&&!pending)return receiptFromIntent(intent,'unknown',null);
    if(pending&&(pending.operationId!==intent.operationId||pending.argsHash!==intent.argsHash
      ||pending.expectedRevision!==intent.expectedRevision||pending.expectedRecordHash!==intent.expectedRecordHash)) {
      return unresolvedReceipt(intent);
    }
    return inspectRecordState(intent,saved);
  }
  async function unresolvedReceipt(intent) { return receiptFromIntent(intent,'unresolved',await loadRecord(intent.recordId)); }
  async function inspectRecordState(intent,saved) {
    const record=await loadRecord(intent.recordId);
    if(saved&&markerMatches(record,intent))return receiptFromIntent(intent,'committed',record);
    if(record.revision===intent.expectedRevision&&digest(record)===intent.expectedRecordHash) {
      const unchanged=receiptFromIntent(intent,'not-applied',record);
      try { return bindRecordsReceipt(intent,unchanged,clock()); }
      catch { fail('RECORDS_UNCERTAIN'); }
    }
    return receiptFromIntent(intent,'unresolved',record);
  }
  async function inspectOperationInternal({intent:rawIntent,actor,reason}={}) {
    await acquire();await refreshPolicy();const intent=validateRecordsIntent(rawIntent);validateInspector(intent,actor,reason);
    const receipt=await inspectReceipt(intent);
    await appendAudit('operation-inspected',{actor},intent.recordId,intent.operationId,intent.argsHash);
    return receipt;
  }
  function receiptFromIntent(intent,status,record) {
    return {format:1,source:'mail-agent-records',agentId:intent.agentId,mailbox:intent.mailbox,connection:intent.connection,
      operationId:intent.operationId,tool:intent.tool,argsHash:intent.argsHash,recordId:intent.recordId,
      expectedRevision:intent.expectedRevision,expectedRecordHash:intent.expectedRecordHash,proposalDigest:intent.proposalDigest,
      status,revision:record?.revision??null,recordHash:record?digest(record):null,inspectedAt:clock()};
  }
  async function pendingFor(recordId) {
    const value=await readJson(pendingFile(recordId),4096,{missing:true});
    if(!value)return null;
    if(!exact(value,['operationId','argsHash','expectedRevision','expectedRecordHash','createdAt'])||!hashPattern.test(value.operationId)||!hashPattern.test(value.argsHash)
      ||!hashPattern.test(value.expectedRecordHash)
      ||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1||!Number.isSafeInteger(value.createdAt)||value.createdAt<0)fail('RECORDS_UNAVAILABLE');
    return value;
  }
  function auditLine(event,context,recordId,operationId,argsHash) {
    const attribution={actorHash:context.actorHash??digest(context.actor)};
    const approverHash=context.approverHash??(context.approval?digest(context.approval.actor):undefined);
    const reasonHash=context.reasonHash??context.approval?.reasonHash;
    if(approverHash)attribution.approverHash=approverHash;
    if(reasonHash)attribution.reasonHash=reasonHash;
    return `${JSON.stringify({event,at:clock(),...attribution,recordId,operationId,argsHash})}\n`;
  }
  async function appendAudit(event,context,recordId,operationId,argsHash) {
    const file=join(base,'audit.ndjson'),line=auditLine(event,context,recordId,operationId,argsHash);
    let handle;
    try {
      handle=await open(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      const stat=await handle.stat();if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&0o077)
        ||stat.size+Buffer.byteLength(line)>maxAuditBytes)fail('RECORDS_UNAVAILABLE');
      await handle.writeFile(line);await handle.sync();
    } catch(error){jsonError(error);} finally{await handle?.close();}
  }
  async function prepareOperation(record,context,args,kind,name) {
    const toolName=`records.${name}`,argsHash=digest(args),intentPath=operationFile(context.operationId,'intent'),receipt=await operation(context.operationId,'receipt');
    if(receipt)return prepareReceipt(record,context,args,toolName,argsHash,receipt);
    let intent=await operation(context.operationId,'intent');
    if(intent)return prepareExisting(record,context,args,toolName,argsHash,intent);
    return prepareNew(record,context,args,toolName,argsHash,intentPath);
  }
  async function prepareReceipt(record,context,args,toolName,argsHash,receipt) {
      validateReceipt(receipt,context.operationId);
      if(receipt.argsHash!==argsHash||receipt.recordId!==args.recordId||receipt.tool!==toolName||receipt.proposalDigest!==args.proposalDigest)fail('RECORDS_UNCERTAIN');
      return {argsHash,receipt};
  }
  async function prepareExisting(record,context,args,toolName,argsHash,intent) {
      validateIntent(intent,context.operationId);
      if(intent.argsHash!==argsHash||intent.recordId!==args.recordId||intent.tool!==toolName||intent.proposalDigest!==args.proposalDigest)fail('RECORDS_UNCERTAIN');
      const pending=await pendingFor(record.id);
      if(markerMatches(record,intent))return finishExisting(record,context,intent,pending,argsHash);
      if(record.revision!==intent.expectedRevision||digest(record)!==intent.expectedRecordHash)fail('RECORDS_UNCERTAIN');
      verifyPending(pending,context,intent,argsHash);
      const refreshed=createRecordsIntent(context,{name:toolName,args});
      if(digest(refreshed)!==digest(intent))await rebindIntent(intent,refreshed,context,argsHash);
      if(!pending)await createJson(pendingFile(record.id),{operationId:context.operationId,argsHash,
        expectedRevision:record.revision,expectedRecordHash:digest(record),createdAt:clock()},join(recordsRoot,record.id));
      return {argsHash,intent:refreshed};
  }
  async function finishExisting(record,context,intent,pending,argsHash) {
    if(pending&&pending.operationId!==context.operationId)fail('RECORDS_UNCERTAIN');
    const committed=receiptFromIntent(intent,'committed',record);
    await createJson(operationFile(context.operationId,'receipt'),committed,operationsRoot);
    if(pending)await settleReceiptFence(record,pending,committed,intent);
    else await appendAudit('write-reconciled',receiptAttribution(intent),record.id,context.operationId,argsHash);
    return {argsHash,receipt:committed};
  }
  function verifyPending(pending,context,intent,argsHash) {
    if(pending&&(pending.operationId!==context.operationId||pending.argsHash!==argsHash||pending.expectedRevision!==intent.expectedRevision
      ||pending.expectedRecordHash!==intent.expectedRecordHash))fail('RECORDS_UNCERTAIN');
  }
  async function rebindIntent(previous,next,context,argsHash) {
    const archive=operationFile(previous.operationId,`attempt-${digest(previous).slice(0,32)}`);
    const saved=await readJson(archive,8192,{missing:true});
    if(saved&&digest(saved)!==digest(previous))fail('RECORDS_UNCERTAIN');
    if(!saved)await createJson(archive,previous,operationsRoot);
    await atomicJson(operationFile(previous.operationId,'intent'),next,operationsRoot);
    await appendAudit('write-reapproved',{actor:context.actor,approverHash:digest(context.approval.actor),
      reasonHash:context.approval.reasonHash},next.recordId,next.operationId,argsHash);
  }
  async function prepareNew(record,context,args,toolName,argsHash,intentPath) {
    const previous=await pendingFor(record.id);
    if(previous?.operationId===context.operationId) {
      if(previous.argsHash!==argsHash||previous.expectedRevision!==record.revision
        ||previous.expectedRecordHash!==digest(record))fail('RECORDS_UNCERTAIN');
      const recovered=createRecordsIntent(context,{name:toolName,args});
      await createJson(intentPath,recovered,operationsRoot);
      await appendAudit('write-reapproved',{actor:context.actor,approverHash:digest(context.approval.actor),
        reasonHash:context.approval.reasonHash},record.id,context.operationId,argsHash);
      return {argsHash,intent:recovered};
    }
    if(previous)await settleProvenPriorCommit(record,previous);
    checkRevision(record,args.expectedRevision);
    const expectedRecordHash=digest(record);
    if(args.expectedRecordHash!==expectedRecordHash)fail('RECORDS_CONFLICT');
    await checkOperationCapacity();
    const exactIntent=createRecordsIntent(context,{name:toolName,args});
    const intent=validateIntent(exactIntent,context.operationId);
    const pending={operationId:context.operationId,argsHash,expectedRevision:record.revision,expectedRecordHash,createdAt:clock()};
    await createJson(intentPath,intent,operationsRoot);
    await createJson(pendingFile(record.id),pending,join(recordsRoot,record.id));
    await appendAudit('write-prepared',context,record.id,context.operationId,argsHash);
    return {argsHash,intent};
  }
  async function settleProvenPriorCommit(record,pending) {
    const intent=await operation(pending.operationId,'intent');
    if(!intent)fail('RECORDS_UNCERTAIN');
    validateIntent(intent,pending.operationId);
    verifyPriorMarker(record,pending,intent);
    const priorReceipt=await operation(pending.operationId,'receipt');
    const receipt=priorReceipt?validateReceipt(priorReceipt,pending.operationId):receiptFromIntent(intent,'committed',record);
    if(!matchesPriorReceipt(receipt,record))fail('RECORDS_UNCERTAIN');
    if(!priorReceipt)await createJson(operationFile(intent.operationId,'receipt'),receipt,operationsRoot);
    await settleReceiptFence(record,pending,receipt,intent);
  }
  async function settleReceiptFence(record,pending,receipt,intent) {
    if(pending.operationId!==intent.operationId)fail('RECORDS_UNCERTAIN');
    validateIntent(intent,pending.operationId);validateReceipt(receipt,pending.operationId);
    verifyPriorMarker(record,pending,intent);
    if(!matchesPriorReceipt(receipt,record))fail('RECORDS_UNCERTAIN');
    try {bindRecordsReceipt(intent,receipt,clock());}catch{fail('RECORDS_UNCERTAIN');}
    await appendAudit('write-reconciled',receiptAttribution(intent),record.id,intent.operationId,intent.argsHash);
    await removePrivate(pendingFile(record.id),join(recordsRoot,record.id));
  }
  function receiptAttribution(intent) {
    return {actorHash:intent.actorHash,approverHash:intent.approverHash,reasonHash:intent.approvalReasonHash};
  }
  function verifyPriorMarker(record,pending,intent) {
    if(intent.recordId!==record.id||intent.argsHash!==pending.argsHash||intent.expectedRevision!==pending.expectedRevision
      ||intent.expectedRecordHash!==pending.expectedRecordHash||!markerMatches(record,intent))fail('RECORDS_UNCERTAIN');
  }
  function matchesPriorReceipt(receipt,record) {
    return receipt.status==='committed'&&receipt.revision===record.revision&&receipt.recordHash===digest(record);
  }
  async function checkOperationCapacity() {
    const entries=await readdir(operationsRoot);
    if(entries.length+2>maxOperationEntries)fail('RECORDS_UNAVAILABLE');
  }
  async function publishOperation(record,context,args,kind,prepared) {
    const updated=kind==='delete'?deleted(record,context,prepared.argsHash,context.operationId):updatedRecord(record,args.patch,context,prepared.argsHash,context.operationId);
    try {
      actorContext(context.tool.slice('records.'.length),args,context);
      await atomicJson(join(recordsRoot,record.id,'record.json'),updated,join(recordsRoot,record.id));
      await afterPublish?.({recordId:record.id,operationId:context.operationId});
      const intent=await operation(context.operationId,'intent');
      const receipt=receiptFromIntent(validateIntent(intent,context.operationId),'committed',updated);
      await createJson(operationFile(context.operationId,'receipt'),receipt,operationsRoot);
      await appendAudit('write-committed',context,record.id,context.operationId,prepared.argsHash);
      await removePrivate(pendingFile(record.id),join(recordsRoot,record.id));
      return receiptResult(receipt);
    } catch { fail('RECORDS_UNCERTAIN'); }
  }
  async function apply(args,rawContext,kind) {
    const name=kind==='update'?'apply_approved_update':'apply_approved_delete';
    const context=actorContext(name,args,rawContext);exactApproval(context);
    if(!permission(fixedPolicy,context.actor,kind==='update'?'edit':'delete',args.recordId))fail('RECORDS_DENIED');
    if(kind==='update')validatePatch(args.patch);
    if(args.proposalDigest!==proposalDigest(kind,args))fail('RECORDS_INVALID');
    const replay=await committedReplay(args,context,name);
    if(replay)return replay;
    const record=await loadRecord(args.recordId);
    const recovered=await committedMarkerReplay(record,args,context,name);
    if(recovered)return recovered;
    visible(context.actor,record);
    const prepared=await prepareOperation(record,context,args,kind,name);
    if(prepared.receipt) {await settleAnyPendingForReceipt(record,prepared.receipt);return receiptResult(prepared.receipt);}
    if(record.revision!==args.expectedRevision||digest(record)!==args.expectedRecordHash)fail('RECORDS_CONFLICT');
    return publishOperation(record,context,args,kind,prepared);
  }
  async function committedReplay(args,context,name) {
    const receipt=await operation(context.operationId,'receipt');
    if(!receipt)return null;
    validateReceipt(receipt,context.operationId);
    if(!receiptMatchesReplay(receipt,args,context,name))fail('RECORDS_UNCERTAIN');
    if(!permission(fixedPolicy,context.actor,'read',args.recordId))fail('RECORDS_DENIED');
    await settleMatchingPending(args,context,receipt);
    return receiptResult(receipt);
  }
  function receiptMatchesReplay(receipt,args,context,name) {
    return receipt.status==='committed'&&receipt.argsHash===digest(args)&&receipt.recordId===args.recordId
      &&receipt.tool===`records.${name}`&&receipt.expectedRevision===args.expectedRevision
      &&receipt.expectedRecordHash===args.expectedRecordHash&&receipt.proposalDigest===args.proposalDigest
      &&receipt.agentId===context.agentId&&receipt.mailbox===context.mailbox&&receipt.connection==='records';
  }
  async function settleMatchingPending(args,context,receipt) {
    const pending=await pendingFor(args.recordId);
    if(pending?.operationId!==context.operationId)return;
    const intent=await operation(context.operationId,'intent');
    if(!intent)fail('RECORDS_UNCERTAIN');
    const record=await loadRecord(args.recordId);
    await settleReceiptFence(record,pending,receipt,validateIntent(intent,context.operationId));
  }
  async function committedMarkerReplay(record,args,context,name) {
    const intent=await operation(context.operationId,'intent');
    if(!intent||!record.deleted)return null;
    validateIntent(intent,context.operationId);
    const current=createRecordsIntent(context,{name:`records.${name}`,args});
    if(digest(current)!==digest(intent)||!markerMatches(record,intent))fail('RECORDS_UNCERTAIN');
    if(!permission(fixedPolicy,context.actor,'read',record.id))fail('RECORDS_DENIED');
    const pending=await pendingFor(record.id);
    if(pending&&pending.operationId!==context.operationId)fail('RECORDS_UNCERTAIN');
    const receipt=receiptFromIntent(intent,'committed',record);
    await createJson(operationFile(context.operationId,'receipt'),receipt,operationsRoot);
    if(pending)await settleReceiptFence(record,pending,receipt,intent);
    else await appendAudit('write-reconciled',receiptAttribution(intent),record.id,intent.operationId,intent.argsHash);
    return receiptResult(receipt);
  }
  async function settleAnyPendingForReceipt(record,receipt) {
    const pending=await pendingFor(record.id);
    if(pending?.operationId===receipt.operationId) {
      const intent=await operation(receipt.operationId,'intent');
      if(!intent)fail('RECORDS_UNCERTAIN');
      await settleReceiptFence(record,pending,receipt,validateIntent(intent,receipt.operationId));
    }
  }
  function updatedRecord(record,patch,context,argsHash,operationId) {
    return {...record,...structuredClone(patch),revision:record.revision+1,updatedAt:clock(),updatedByHash:digest(context.actor),
      lastOperationId:operationId,lastArgsHash:argsHash,lastExpectedRecordHash:digest(record),
      lastProposalDigest:proposalDigest('update',{recordId:record.id,expectedRevision:record.revision,expectedRecordHash:digest(record),patch})};
  }
  function deleted(record,context,argsHash,operationId) {
    return {...record,title:'',content:'',tags:[],revision:record.revision+1,updatedAt:clock(),updatedByHash:digest(context.actor),deleted:true,
      lastOperationId:operationId,lastArgsHash:argsHash,lastExpectedRecordHash:digest(record),
      lastProposalDigest:proposalDigest('delete',{recordId:record.id,expectedRevision:record.revision,expectedRecordHash:digest(record)})};
  }
  const routes={search:list,get,propose_update:proposeUpdate,apply_approved_update:(args,ctx)=>apply(args,ctx,'update'),
    propose_delete:proposeDelete,apply_approved_delete:(args,ctx)=>apply(args,ctx,'delete'),operation_status:operationStatus};
  async function callInternal(name,args,rawContext) {
    await acquire();await refreshPolicy();
    const route=routes[name];if(!route||!inputValidators.get(name)?.(args))fail('RECORDS_INVALID');
    try { const result=await route(args,rawContext);if(Buffer.byteLength(JSON.stringify(result))>resultBytes)fail('RECORDS_UNAVAILABLE');return result; }
    catch(error){jsonError(error);}
  }
  function serialize(work) {
    if(closed||closing)fail('RECORDS_UNAVAILABLE');
    const result=tail.then(work);tail=result.catch(()=>{});return result;
  }
  const call=(...args)=>serialize(()=>callInternal(...args));
  const inspectOperation=(...args)=>serialize(()=>inspectOperationInternal(...args));
  async function close(){
    if(closing)return closing;
    closing=(async()=>{await tail;closed=true;await cleanupLock();})();
    return closing;
  }
  return {listTools:defs,call,inspectOperation,close,extension:{[DOMAIN_CONTEXT_KEY]:DOMAIN_CONTEXT_CAPABILITY}};
}
