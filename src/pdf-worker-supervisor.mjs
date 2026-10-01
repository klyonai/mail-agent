import {TextDecoder} from 'node:util';
import {PdfError,validatePdfRequest,validatePdfResponse,pdfRequestByteLimit,pdfResponseByteLimit} from './pdf-contract.mjs';

const STDERR_LIMIT=8192;
const eventSource=value=>value&&typeof value.on==='function'&&typeof value.off==='function';
function handleValid(handle) {
  return handle&&typeof handle.terminate==='function'&&typeof handle.release==='function'
    &&eventSource(handle.child)&&eventSource(handle.child.stdout)&&eventSource(handle.child.stderr)
    &&eventSource(handle.child.stdin)&&typeof handle.child.stdin.end==='function';
}
function time(clock) {
  let value;
  try {value=clock();}catch{throw new PdfError('PDF_PROCESSOR_FAILED');}
  if(!Number.isSafeInteger(value)||value<0)throw new PdfError('PDF_PROCESSOR_FAILED');
  return value;
}
function cleanupError(state) {state.cleanupFailed=true;terminate(state);}
function terminate(state) {
  if(!state.handle||state.termination)return;
  state.termination=Promise.resolve().then(()=>state.handle.terminate()).catch(()=>cleanupError(state));
}
function fail(state,code) {
  state.failure??=new PdfError(code);
  state.controller.abort();terminate(state);
}
function fresh(state) {
  const now=time(state.clock);
  if(now>=state.request.expiresAt)fail(state,'PDF_EXPIRED');
  else if(now>=state.deadline)fail(state,'PDF_TIMEOUT');
}
function collect(state,stream,chunk) {
  if(state.failure)return;
  if(!(chunk instanceof Uint8Array)){fail(state,'PDF_PROCESSOR_FAILED');return;}
  if(stream==='stderr') {
    state.stderrBytes+=chunk.byteLength;
    if(state.stderrBytes>STDERR_LIMIT)fail(state,'PDF_PROCESSOR_FAILED');
    return;
  }
  state.stdoutBytes+=chunk.byteLength;
  if(state.stdoutBytes>state.maximum){fail(state,'PDF_TOO_LARGE');return;}
  state.chunks.push(Buffer.from(chunk));
}
function attach(state) {
  const child=state.handle.child;
  state.listeners=[
    [child.stdout,'data',chunk=>collect(state,'stdout',chunk)],
    [child.stderr,'data',chunk=>collect(state,'stderr',chunk)],
    ...[child,child.stdin,child.stdout,child.stderr].map(source=>[source,'error',()=>fail(state,'PDF_PROCESSOR_FAILED')]),
    [child,'close',(code,signal)=>{
      if(state.closed)return;
      state.closed=true;
      if(code!==0||signal)fail(state,'PDF_PROCESSOR_FAILED');
      state.closeResolve();
    }],
  ];
  for(const [source,event,listener] of state.listeners)source.on(event,listener);
}
function dispose(state) {
  state.clearTimer(state.timer);
  state.signal?.removeEventListener('abort',state.onAbort);
  for(const [source,event,listener] of state.listeners)source.off(event,listener);
  state.chunks.length=0;
}
function createState(request,options,startedAt) {
  const state={request,...options,controller:new AbortController(),chunks:[],stdoutBytes:0,stderrBytes:0,
    maximum:pdfResponseByteLimit(request),listeners:[],deadline:Math.min(startedAt+request.limits.timeoutMs,request.expiresAt)};
  state.closePromise=new Promise(resolve=>{state.closeResolve=resolve;});
  state.onAbort=()=>fail(state,'PDF_CANCELLED');
  state.signal?.addEventListener('abort',state.onAbort,{once:true});
  const deadlineCode=state.deadline===request.expiresAt?'PDF_EXPIRED':'PDF_TIMEOUT';
  state.timer=state.setTimer(()=>fail(state,deadlineCode),state.deadline-startedAt);
  return state;
}
function start(state,startWorker,input) {
  const handle=startWorker({jobId:state.request.jobId,request:structuredClone(state.request),signal:state.controller.signal});
  if(handle?.then){void Promise.resolve(handle).catch(()=>{});throw new PdfError('PDF_PROCESSOR_FAILED');}
  if(!handleValid(handle))throw new PdfError('PDF_PROCESSOR_FAILED');
  state.handle=handle;attach(state);fresh(state);
  if(state.signal?.aborted)fail(state,'PDF_CANCELLED');
  if(state.failure){terminate(state);return;}
  handle.child.stdin.end(input);
}
function decodeResponse(state) {
  let response;
  try {response=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(state.chunks,state.stdoutBytes)));}
  catch {throw new PdfError('PDF_INVALID_OUTPUT');}
  return validatePdfResponse(response,{request:state.request,now:time(state.clock)});
}
async function release(state) {
  if(state.released)return;
  state.released=true;
  try {await state.handle.release();}catch{cleanupError(state);}
}
async function finish(state) {
  await state.closePromise;
  await state.termination;
  await release(state);
  let result;
  try {
    fresh(state);
    if(!state.failure&&!state.cleanupFailed)result=decodeResponse(state);
    fresh(state);
  } catch(error) {fail(state,error instanceof PdfError?error.code:'PDF_INVALID_OUTPUT');}
  await state.termination;
  if(state.failure)throw state.failure;
  if(state.cleanupFailed)throw new PdfError('PDF_CLEANUP_FAILED');
  return result;
}

/** The trusted launcher must synchronously return an owned handle before native work.
 * Its terminate/release promises establish tree termination and resource quiescence.
 * This supervisor proves orchestration; it supplies no host sandbox or subprocess fallback. */
export async function runPdfWorker(request,{
  startWorker,signal,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,
}={}) {
  if(signal?.aborted)throw new PdfError('PDF_CANCELLED');
  const startedAt=time(clock),checked=validatePdfRequest(request,{now:startedAt});
  if(typeof startWorker!=='function')throw new PdfError('PDF_PROCESSOR_UNAVAILABLE');
  const input=Buffer.from(JSON.stringify(checked),'utf8');
  if(input.length>pdfRequestByteLimit(checked))throw new PdfError('PDF_TOO_LARGE');
  const state=createState(checked,{signal,clock,setTimer,clearTimer},startedAt);
  try {
    try {start(state,startWorker,input);}catch{fail(state,'PDF_PROCESSOR_FAILED');}
    if(!state.handle)throw state.failure;
    return await finish(state);
  } finally {dispose(state);}
}
