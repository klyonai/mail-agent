import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createPdfProcessor} from '../src/pdf-processor.mjs';

const processorDigest='b'.repeat(64),jobId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now=1000;
const bytes=Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n');

test('PDF client binds exact input, generated job, processor, expiry and limits to validated page bytes',async()=>{
  const png=await readFile(new URL('./fixtures/images/synthetic-note.png',import.meta.url));let captured,ids=0,released=0;
  const processor=createPdfProcessor({processorDigest,clock:()=>now,idFactory:()=>{ids++;return jobId;},startWorker:({request,signal})=>{
    captured=request;assert.equal(signal.aborted,false);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.stdin.end=()=>Promise.resolve().then(()=>{
      child.stdout.emit('data',Buffer.from(JSON.stringify({version:1,complete:true,jobId,inputSha256:request.inputSha256,
        processorDigest,pageCount:1,encrypted:false,pages:[{pageNumber:1,mediaType:'image/png',data:png.toString('base64')}]})));
      child.emit('close',0,null);
    });
    return {child,terminate:async()=>child.emit('close',null,'SIGKILL'),release:async()=>{released++;}};
  }});
  const result=await processor.render({bytes,expiresAt:61000,limits:{timeoutMs:1000}});
  assert.equal(ids,1);assert.equal(released,1);assert.equal(captured.data,bytes.toString('base64'));
  assert.equal(captured.expiresAt,61000);assert.equal(captured.limits.timeoutMs,1000);
  assert.equal(result.inputSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(Buffer.from(result.pages[0].bytes),png);
});

test('invalid input, unqualified identity, expired input and cancellation never dispatch work',async()=>{
  let starts=0;const options={processorDigest,clock:()=>now,idFactory:()=>jobId,startWorker:()=>{starts++;}};
  const processor=createPdfProcessor(options);
  for(const item of [{bytes:Buffer.from('not PDF'),expiresAt:61000},{bytes,expiresAt:now},{bytes,expiresAt:61000,signal:AbortSignal.abort()}]) {
    await assert.rejects(processor.render(item),error=>error.name==='PdfError');
  }
  assert.throws(()=>createPdfProcessor({...options,processorDigest:'private'}),error=>error.name==='PdfError');
  assert.equal(starts,0);
});

test('missing launcher remains unavailable and invalid generated identities fail closed',async()=>{
  await assert.rejects(createPdfProcessor({processorDigest,clock:()=>now}).render({bytes,expiresAt:61000}),error=>error.name==='PdfError');
  let starts=0;
  const processor=createPdfProcessor({processorDigest,clock:()=>now,idFactory:()=> '../private',startWorker:()=>{starts++;}});
  await assert.rejects(processor.render({bytes,expiresAt:61000}),error=>error.name==='PdfError');assert.equal(starts,0);
});

test('client forwards injected deadline timers without a wall-clock crash position',async()=>{
  let timer,clears=0,terminations=0;
  const processor=createPdfProcessor({processorDigest,clock:()=>now,idFactory:()=>jobId,
    setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{clears++;},startWorker:()=>{
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};
      return {child,terminate:async()=>{terminations++;child.emit('close',null,'SIGKILL');},release:async()=>{}};
    }});
  const task=processor.render({bytes,expiresAt:61000,limits:{timeoutMs:1000}});
  assert.equal(typeof timer,'function');timer();
  await assert.rejects(task,{code:'PDF_TIMEOUT'});assert.equal(terminations,1);assert.equal(clears,1);
});
