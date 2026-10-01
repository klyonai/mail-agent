import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createPdfRequest,pdfResponseByteLimit,PdfError} from '../src/pdf-contract.mjs';
import {runPdfWorker} from '../src/pdf-worker-supervisor.mjs';

const now=1000,jobId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',processorDigest='b'.repeat(64);
const input=Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n');
const request=()=>createPdfRequest({bytes:input,jobId,processorDigest,expiresAt:61000,limits:{timeoutMs:1000}},{now});
async function response(value=request()) {
  const bytes=await readFile(new URL('./fixtures/images/synthetic-note.png',import.meta.url));
  return {version:1,complete:true,jobId:value.jobId,inputSha256:value.inputSha256,processorDigest:value.processorDigest,
    pageCount:1,encrypted:false,pages:[{pageNumber:1,mediaType:'image/png',data:bytes.toString('base64')}]};
}
function deferred() {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture({terminateWait,releaseWait,releaseError}={}) {
  const child=new EventEmitter(),events=[];
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=bytes=>{events.push('stdin');child.input=Buffer.from(bytes);};
  const handle={child,terminate:async()=>{
    events.push('terminate');child.emit('close',null,'SIGKILL');await terminateWait?.promise;
  },release:async()=>{events.push('release');await releaseWait?.promise;if(releaseError)throw new Error('private parser detail');}};
  let timer,delay;
  const options={startWorker:()=>handle,clock:()=>now,setTimer:(fn,ms)=>{timer=fn;delay=ms;return 1;},clearTimer:()=>events.push('clear')};
  return {child,handle,events,options,timeout:()=>timer(),delay:()=>delay};
}
function emitResponse(child,value) {child.stdout.emit('data',Buffer.from(JSON.stringify(value)));}
function safe(code) {return error=>error instanceof PdfError&&error.code===code&&!error.message.includes('private');}

test('PDF supervisor publishes validated pages only after close0 and resource release',async()=>{
  const wait=deferred(),f=fixture({releaseWait:wait}),value=request(),output=await response(value);
  const task=runPdfWorker(value,f.options);let settled=false;void task.then(()=>{settled=true;});
  assert.deepEqual(JSON.parse(f.child.input.toString()),value);
  emitResponse(f.child,output);await Promise.resolve();assert.equal(settled,false);
  f.child.emit('close',0,null);await Promise.resolve();assert.equal(settled,false);
  wait.resolve();const result=await task;
  assert.equal(result.inputSha256,value.inputSha256);assert.equal(result.pages[0].mediaType,'image/png');
  assert.deepEqual(f.events,['stdin','release','clear']);
});

test('cancellation waits for both owned termination and release, once, before safe failure',async()=>{
  const terminateWait=deferred(),releaseWait=deferred(),f=fixture({terminateWait,releaseWait}),controller=new AbortController();
  const task=runPdfWorker(request(),{...f.options,signal:controller.signal});let settled=false;
  void task.then(()=>{settled=true;},()=>{settled=true;});
  controller.abort(new Error('private'));f.timeout();await Promise.resolve();
  assert.equal(settled,false);assert.equal(f.events.filter(x=>x==='terminate').length,1);
  terminateWait.resolve();await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  releaseWait.resolve();await assert.rejects(task,safe('PDF_CANCELLED'));
  assert.equal(f.events.filter(x=>x==='release').length,1);
});

test('timeout uses the original expiry and requested deadline',async()=>{
  const f=fixture(),value=createPdfRequest({bytes:input,jobId,processorDigest,expiresAt:1050,limits:{timeoutMs:1000}},{now});
  const task=runPdfWorker(value,f.options);assert.equal(f.delay(),50);f.timeout();
  await assert.rejects(task,safe('PDF_EXPIRED'));
  const other=fixture(),pending=runPdfWorker(request(),other.options);assert.equal(other.delay(),1000);other.timeout();
  await assert.rejects(pending,safe('PDF_TIMEOUT'));
});

test('pre-aborted and expired requests never start a worker',async()=>{
  let calls=0;const options={clock:()=>now,startWorker:()=>{calls++;}};
  await assert.rejects(runPdfWorker(request(),{...options,signal:AbortSignal.abort()}),safe('PDF_CANCELLED'));
  await assert.rejects(runPdfWorker({...request(),expiresAt:now},options),safe('PDF_EXPIRED'));
  assert.equal(calls,0);
});

test('response overflow and bounded discarded stderr terminate without exposing parser data',async()=>{
  for(const [stream,size,code] of [['stdout',pdfResponseByteLimit(request())+1,'PDF_TOO_LARGE'],['stderr',8193,'PDF_PROCESSOR_FAILED']]) {
    const f=fixture(),task=runPdfWorker(request(),f.options);
    f.child[stream].emit('data',Buffer.alloc(size,120));
    await assert.rejects(task,safe(code));assert.equal(f.events.filter(x=>x==='terminate').length,1);
  }
});

test('malformed UTF8, multiple JSON responses and malformed pages fail after safe cleanup',async()=>{
  const output=await response();
  for(const bytes of [Buffer.from([0xff]),Buffer.from('{}\n{}'),Buffer.from(JSON.stringify({...output,jobId:'wrong'}))]) {
    const f=fixture(),task=runPdfWorker(request(),f.options);
    f.child.stdout.emit('data',bytes);f.child.emit('close',0,null);
    await assert.rejects(task,safe('PDF_INVALID_OUTPUT'));assert.equal(f.events.filter(x=>x==='release').length,1);
    assert.equal(f.events.filter(x=>x==='terminate').length,1);
  }
});

test('nonzero exit and stream errors discard even complete output and clean owned resources',async()=>{
  const output=await response();
  for(const type of ['exit','stdin','stdout','stderr','child']) {
    const f=fixture(),task=runPdfWorker(request(),f.options);emitResponse(f.child,output);
    if(type==='exit')f.child.emit('close',2,null);
    else if(type==='child')f.child.emit('error',new Error('private'));
    else f.child[type].emit('error',new Error('private'));
    await assert.rejects(task,safe('PDF_PROCESSOR_FAILED'));assert.equal(f.events.filter(x=>x==='release').length,1);
  }
});

test('release failure never publishes output; primary cancellation is preserved through cleanup failure',async()=>{
  const f=fixture({releaseError:true}),task=runPdfWorker(request(),f.options);
  emitResponse(f.child,await response());f.child.emit('close',0,null);
  await assert.rejects(task,safe('PDF_CLEANUP_FAILED'));
  assert.equal(f.events.filter(x=>x==='terminate').length,1);
  const other=fixture({releaseError:true}),controller=new AbortController();
  const cancelled=runPdfWorker(request(),{...other.options,signal:controller.signal});controller.abort();
  await assert.rejects(cancelled,safe('PDF_CANCELLED'));
});

test('termination resolution alone cannot release resources before child close',async()=>{
  const f=fixture(),controller=new AbortController();f.handle.terminate=async()=>{f.events.push('terminate');};
  const task=runPdfWorker(request(),{...f.options,signal:controller.signal});let settled=false;
  void task.then(()=>{settled=true;},()=>{settled=true;});controller.abort();
  await Promise.resolve();await Promise.resolve();assert.equal(settled,false);
  assert.equal(f.events.includes('release'),false);f.child.emit('close',null,'SIGKILL');
  await assert.rejects(task,safe('PDF_CANCELLED'));assert.equal(f.events.filter(x=>x==='release').length,1);
});

test('expiry after successful exit is checked after release and copied stream buffers cannot drift',async()=>{
  const output=await response(),f=fixture();let current=now;
  f.handle.release=async()=>{current=61000;f.events.push('release');};
  const expired=runPdfWorker(request(),{...f.options,clock:()=>current});emitResponse(f.child,output);f.child.emit('close',0,null);
  await assert.rejects(expired,safe('PDF_EXPIRED'));
  const good=fixture(),task=runPdfWorker(request(),good.options),buffer=Buffer.from(JSON.stringify(output));
  good.child.stdout.emit('data',buffer.subarray(0,20));good.child.stdout.emit('data',buffer.subarray(20));buffer.fill(0);
  good.child.emit('close',0,null);assert.equal((await task).pageCount,1);
});

test('stdin dispatch errors and startup budget consumption await owned cleanup',async()=>{
  const f=fixture();f.child.stdin.end=()=>{throw new Error('private');};
  await assert.rejects(runPdfWorker(request(),f.options),safe('PDF_PROCESSOR_FAILED'));
  assert.equal(f.events.filter(x=>x==='release').length,1);
  const other=fixture();let current=now;
  const task=runPdfWorker(request(),{...other.options,clock:()=>current,startWorker:()=>{current=2000;return other.handle;}});
  await assert.rejects(task,safe('PDF_TIMEOUT'));assert.equal(other.events.includes('stdin'),false);
});

test('clock errors never expose injected details or start a worker',async()=>{
  let starts=0;
  await assert.rejects(runPdfWorker(request(),{clock:()=>{throw new Error('private parser detail');},startWorker:()=>{starts++;}}),safe('PDF_PROCESSOR_FAILED'));
  assert.equal(starts,0);
});

test('time consumed by output validation cannot publish beyond original expiry',async()=>{
  const f=fixture();let reads=0;
  const task=runPdfWorker(request(),{...f.options,clock:()=>++reads<5?now:61000});
  emitResponse(f.child,await response());f.child.emit('close',0,null);
  await assert.rejects(task,safe('PDF_EXPIRED'));
});

test('expiry and abort during resource release prevent a successful result',async()=>{
  const wait=deferred(),f=fixture({releaseWait:wait}),controller=new AbortController();
  const task=runPdfWorker(request(),{...f.options,signal:controller.signal});emitResponse(f.child,await response());
  f.child.emit('close',0,null);controller.abort();wait.resolve();await assert.rejects(task,safe('PDF_CANCELLED'));
});

test('missing, throwing and asynchronous launcher contracts have no ordinary subprocess fallback',async()=>{
  for(const startWorker of [undefined,()=>{throw new Error('private');},()=>Promise.resolve({})]) {
    const code=startWorker===undefined?'PDF_PROCESSOR_UNAVAILABLE':'PDF_PROCESSOR_FAILED';
    await assert.rejects(runPdfWorker(request(),{startWorker,clock:()=>now}),safe(code));
  }
});
