import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {TextDecoder} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {DOMAIN_CONTEXT_CAPABILITY,DOMAIN_CONTEXT_KEY} from '../../src/domain-context.mjs';
import {readRecoveryPlanFile} from '../../src/recovery-io.mjs';
import {validateRecordsIntent} from '../../src/records-reconciliation.mjs';
import {createRecordsAdapter,RecordsError} from './records.mjs';

const maxPolicyBytes=65_536;

async function privatePolicy(filename) {
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const before=await handle.stat();
    if(!safePolicyStat(before))throw new Error();
    const data=Buffer.alloc(before.size+1),offset=await readPolicyBytes(handle,data);
    const after=await handle.stat();
    if(offset!==before.size||after.ino!==before.ino||after.size!==before.size||after.nlink!==1)throw new Error();
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,offset)));
  } catch { throw new Error('Records policy unavailable.'); }
  finally { await handle.close(); }
}
function safePolicyStat(value) {return value.isFile()&&value.uid===process.getuid()&&value.nlink===1&&!(value.mode&0o077)&&value.size<=maxPolicyBytes;}
async function readPolicyBytes(handle,data) {
  let offset=0;
  while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  return offset;
}

function options(argv) {
  const inspect=argv[0]==='inspect',mode=inspect?'inspect':'serve';
  const parsed=parseOptions(inspect?argv.slice(1):argv,inspect);
  if(!parsed['--root']||!parsed['--policy'])throw new Error('Invalid records server options.');
  if(inspect)return inspectOptions(parsed);
  return {mode,root:resolve(parsed['--root']),policyPath:resolve(parsed['--policy']),intentPath:parsed['--intent']&&resolve(parsed['--intent']),
    actor:parsed['--actor'],reason:parsed['--reason']};
}
function parseOptions(values,inspect) {
  const parsed={},allowed=inspect?['--root','--policy','--intent','--actor','--reason']:['--root','--policy'];
  for(let index=0;index<values.length;index+=2) {
    const key=values[index],value=values[index+1];
    if(!allowed.includes(key)||!value||Object.hasOwn(parsed,key))throw new Error('Invalid records server options.');
    parsed[key]=value;
  }
  return parsed;
}
function inspectOptions(parsed) {
  if(!parsed['--intent']||!parsed['--actor']||!parsed['--reason'])throw new Error('Invalid records server options.');
  return {mode:'inspect',root:resolve(parsed['--root']),policyPath:resolve(parsed['--policy']),
    intentPath:resolve(parsed['--intent']),actor:parsed['--actor'],reason:parsed['--reason']};
}

async function inspectRecords(options) {
  let adapter;
  try {
    const intent=validateRecordsIntent(await readRecoveryPlanFile(options.intentPath,{maxBytes:8192}));
    adapter=createRecordsAdapter({root:options.root,policy:()=>privatePolicy(options.policyPath)});
    const receipt=await adapter.inspectOperation({intent,actor:options.actor,reason:options.reason});
    process.stdout.write(`${JSON.stringify(receipt,null,2)}\n`);
  } finally { await adapter?.close(); }
}

export async function serveRecords({root,policyPath,transport=new StdioServerTransport()}={}) {
  if(typeof root!=='string'||typeof policyPath!=='string')throw new Error('Invalid records server options.');
  const adapter=createRecordsAdapter({root,policy:()=>privatePolicy(policyPath)});
  const server=new Server({name:'mail-agent-records',version:'0.1.0'},
    {capabilities:{tools:{listChanged:false},experimental:{[DOMAIN_CONTEXT_KEY]:DOMAIN_CONTEXT_CAPABILITY}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:adapter.listTools()}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try {
      const output=await adapter.call(request.params.name,request.params.arguments,request.params._meta?.[DOMAIN_CONTEXT_KEY]);
      return {content:[{type:'text',text:JSON.stringify(output)}]};
    } catch(error) {
      const safe=error instanceof RecordsError?error:new RecordsError('RECORDS_UNAVAILABLE');
      return {isError:true,content:[{type:'text',text:`${safe.code}: ${safe.message}`}]};
    }
  });
  const stop=async()=>{await server.close().catch(()=>{});await adapter.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await server.connect(transport);
  return {server,adapter,close:stop};
}

async function isMainModule() {
  if(!process.argv[1])return false;
  try{return await realpath(resolve(process.argv[1]))===await realpath(fileURLToPath(import.meta.url));}
  catch{return false;}
}

if(await isMainModule()) {
  try {
    const parsed=options(process.argv.slice(2));
    if(parsed.mode==='inspect')await inspectRecords(parsed);
    else await serveRecords(parsed);
  } catch {
    process.stderr.write('Records server unavailable. Check private root, policy and options.\n');process.exitCode=1;
  }
}
