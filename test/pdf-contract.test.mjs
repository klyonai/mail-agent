import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PDF_BOUNDS,PdfError,createPdfRequest,pdfRequestByteLimit,pdfResponseByteLimit,validatePdfLimits,validatePdfRequest,validatePdfResponse} from '../src/pdf-contract.mjs';

const now=1000,expiresAt=5000,processorDigest='a'.repeat(64),jobId=randomUUID();
const pdf=Buffer.from('%PDF-1.7\nsynthetic fixture');
const png=await readFile(new URL('./fixtures/images/synthetic-note.png',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function request(options={}) {return createPdfRequest({bytes:pdf,jobId,processorDigest,expiresAt,limits:{},...options},{now});}
function response(value=request()) {return {version:1,complete:true,jobId:value.jobId,inputSha256:value.inputSha256,processorDigest:value.processorDigest,pageCount:1,encrypted:false,pages:[{pageNumber:1,mediaType:'image/png',data:png.toString('base64')}]};}
function fails(code,operation) {assert.throws(operation,error=>error instanceof PdfError&&error.code===code);}

test('PDF limits normalize to the fixed safe defaults and only allow stricter bounds',()=>{
  assert.deepEqual(validatePdfLimits(),{maxBytes:PDF_BOUNDS.sourceBytes,maxPages:4,maxPageBytes:PDF_BOUNDS.pageBytes,maxTotalBytes:PDF_BOUNDS.totalBytes,maxPixels:12000000,dpi:300,timeoutMs:60000});
  assert.deepEqual(validatePdfLimits({maxPages:2,maxBytes:1024,maxPageBytes:2048,maxTotalBytes:2048,maxPixels:1000,timeoutMs:2000}).maxPages,2);
  for(const limits of [{maxPages:5},{maxBytes:PDF_BOUNDS.sourceBytes+1},{maxPageBytes:PDF_BOUNDS.pageBytes+1},{maxTotalBytes:PDF_BOUNDS.totalBytes+1},{maxPixels:PDF_BOUNDS.hardPixels+1},{dpi:301},{timeoutMs:60001},{extra:true},{maxPages:0},{maxBytes:null},{maxBytes:undefined}]) fails('PDF_INVALID_LIMITS',()=>validatePdfLimits(limits));
});

test('request binds canonical PDF bytes, processor, expiry, UUID and limits without a path',()=>{
  const value=request();
  assert.deepEqual(value,{version:1,jobId,inputSha256:hash(pdf),processorDigest,expiresAt,limits:validatePdfLimits(),data:pdf.toString('base64')});
  assert.equal(validatePdfRequest(value,{now}).inputSha256,hash(pdf));
  assert.equal(pdfRequestByteLimit(value),Math.ceil(PDF_BOUNDS.sourceBytes/3)*4+4096);
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=pdfRequestByteLimit(value));
  for(const mutation of [v=>({...v,path:'/tmp/x'}),v=>({...v,data:`${v.data}=`}),v=>({...v,inputSha256:'b'.repeat(64)}),v=>({...v,jobId:'not-a-uuid'})]) fails('PDF_INVALID_INPUT',()=>validatePdfRequest(mutation(value),{now}));
});

test('source bytes must be a bounded PDF with supported header and a valid identity',()=>{
  fails('PDF_UNSUPPORTED',()=>request({bytes:Buffer.from('not a pdf')}));
  fails('PDF_TOO_LARGE',()=>request({bytes:Buffer.alloc(PDF_BOUNDS.sourceBytes+1)}));
  fails('PDF_INVALID_INPUT',()=>request({jobId:'bad'}));
  fails('PDF_INVALID_INPUT',()=>request({processorDigest:'x'}));
  fails('PDF_EXPIRED',()=>createPdfRequest({bytes:pdf,jobId,processorDigest,expiresAt:now,limits:{}},{now}));
});

test('response returns verified pages with hash and dimensions only after complete validation',()=>{
  const req=request(),result=validatePdfResponse(response(req),{request:req,now});
  assert.equal(result.jobId,jobId);assert.equal(result.inputSha256,hash(pdf));assert.equal(result.processorDigest,processorDigest);
  assert.equal(result.pageCount,1);assert.deepEqual(result.pages,[{pageNumber:1,mediaType:'image/png',bytes:png,width:128,height:48,sha256:hash(png)}]);
  assert.ok(Buffer.byteLength(JSON.stringify(response(req)))<=pdfResponseByteLimit(req));
});

test('response rejects identity drift, extras, encryption, partial pages and noncanonical bytes',()=>{
  const req=request(),base=response(req);
  const changed=[v=>({...v,extra:'x'}),v=>({...v,complete:false}),v=>({...v,jobId:randomUUID()}),v=>({...v,inputSha256:'b'.repeat(64)}),v=>({...v,processorDigest:'b'.repeat(64)}),v=>({...v,pageCount:2}),v=>({...v,pages:[{...v.pages[0],pageNumber:2}]}),v=>({...v,pages:[{...v.pages[0],mediaType:'image/jpeg'}]}),v=>({...v,pages:[{...v.pages[0],data:v.pages[0].data+'='}]})];
  for(const alter of changed) fails('PDF_INVALID_OUTPUT',()=>validatePdfResponse(alter(base),{request:req,now}));
  fails('PDF_UNSUPPORTED',()=>validatePdfResponse({...base,encrypted:true},{request:req,now}));
  fails('PDF_INVALID_OUTPUT',()=>validatePdfResponse({...base,pages:[{...base.pages[0],data:Buffer.from('bad').toString('base64')}]},{request:req,now}));
  fails('PDF_EXPIRED',()=>validatePdfResponse(base,{request:req,now:expiresAt}));
});

test('response enforces page, aggregate, pixel and encoded-output bounds before returning pages',()=>{
  const req=request({limits:{maxPageBytes:png.length-1,maxTotalBytes:png.length-1}}),value=response(req);
  fails('PDF_TOO_LARGE',()=>validatePdfResponse(value,{request:req,now}));
  const aggregate=request({limits:{maxPageBytes:png.length,maxTotalBytes:png.length*2-1}}),one=response(aggregate);
  fails('PDF_TOO_LARGE',()=>validatePdfResponse({...one,pageCount:2,pages:[...one.pages,{...one.pages[0],pageNumber:2}]},{request:aggregate,now}));
  const pixels=request({limits:{maxPixels:128*48-1}});
  fails('PDF_TOO_LARGE',()=>validatePdfResponse(response(pixels),{request:pixels,now}));
  const oversized={...value,pages:Array.from({length:5},(_,index)=>({...value.pages[0],pageNumber:index+1})),pageCount:5};
  fails('PDF_INVALID_OUTPUT',()=>validatePdfResponse(oversized,{request:req,now}));
});
