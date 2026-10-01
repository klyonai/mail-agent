import {createHash,randomUUID} from 'node:crypto';
import {validateImage} from './image-validation.mjs';

export const PDF_BOUNDS=Object.freeze({sourceBytes:5*1024*1024,pageBytes:5*1024*1024,totalBytes:10*1024*1024,
  maxPages:4,defaultPixels:12000000,hardPixels:20000000,dpi:300,timeoutMs:60000,requestOverhead:4096,responseOverhead:16384});
const limitKeys=['maxBytes','maxPages','maxPageBytes','maxTotalBytes','maxPixels','dpi','timeoutMs'];
const requestKeys=['version','jobId','inputSha256','processorDigest','expiresAt','limits','data'];
const responseKeys=['version','complete','jobId','inputSha256','processorDigest','pageCount','encrypted','pages'];
const pageKeys=['pageNumber','mediaType','data'];
const defaults=Object.freeze({maxBytes:PDF_BOUNDS.sourceBytes,maxPages:PDF_BOUNDS.maxPages,maxPageBytes:PDF_BOUNDS.pageBytes,
  maxTotalBytes:PDF_BOUNDS.totalBytes,maxPixels:PDF_BOUNDS.defaultPixels,dpi:PDF_BOUNDS.dpi,timeoutMs:PDF_BOUNDS.timeoutMs});
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
const messages=Object.freeze({
  'PDF_INVALID_INPUT':'PDF input is invalid.','PDF_INVALID_LIMITS':'PDF processing limits are invalid.',
  'PDF_EXPIRED':'PDF processing input has expired.','PDF_UNSUPPORTED':'PDF input is unsupported.',
  'PDF_TOO_LARGE':'PDF processing exceeds the configured size limits.','PDF_INVALID_OUTPUT':'PDF processor output is invalid.',
  'PDF_PROCESSOR_UNAVAILABLE':'The PDF processor is unavailable.','PDF_PROCESSOR_FAILED':'PDF processing failed.',
  'PDF_TIMEOUT':'PDF processing exceeded its time limit.','PDF_CANCELLED':'PDF processing was cancelled.',
  'PDF_CLEANUP_FAILED':'PDF processor resources could not be safely released.',
  'PDF_ARTIFACT_INVALID':'PDF artifact metadata is invalid.',
  'PDF_ARTIFACT_UNAVAILABLE':'PDF artifact is unavailable.',
  'PDF_ARTIFACT_UNSAFE':'PDF artifact storage is unsafe.',
});
export class PdfError extends Error {
  constructor(code='PDF_INVALID_INPUT') {const safe=Object.hasOwn(messages,code)?code:'PDF_INVALID_INPUT';super(messages[safe]);this.name='PdfError';this.code=safe;}
}
function fail(code) {throw new PdfError(code);}
function exact(value,keys) {return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));}
function positive(value,max) {return Number.isSafeInteger(value)&&value>0&&value<=max;}
function nowValue(value) {return Number.isSafeInteger(value)&&value>=0?value:fail('PDF_INVALID_INPUT');}
function validExpiry(expiry,now) {if(!Number.isSafeInteger(expiry)||expiry<0)fail('PDF_INVALID_INPUT');if(expiry<=now)fail('PDF_EXPIRED');}
function digest(bytes) {return createHash('sha256').update(bytes).digest('hex');}
function field(value,key) {return Object.hasOwn(value,key)?value[key]:defaults[key];}
function validRanges(value) {
  return [[value.maxBytes,PDF_BOUNDS.sourceBytes],[value.maxPages,PDF_BOUNDS.maxPages],[value.maxPageBytes,PDF_BOUNDS.pageBytes],
    [value.maxTotalBytes,PDF_BOUNDS.totalBytes],[value.maxPixels,PDF_BOUNDS.hardPixels],[value.timeoutMs,PDF_BOUNDS.timeoutMs]]
    .every(([candidate,maximum])=>positive(candidate,maximum));
}
function limitsEqual(value) {return exact(value,limitKeys);}

export function validatePdfLimits(value={}) {
  const supplied=value===undefined?{}:value;
  if(!supplied||typeof supplied!=='object'||Array.isArray(supplied)||Object.keys(supplied).some(key=>!limitKeys.includes(key)))fail('PDF_INVALID_LIMITS');
  const normalized=Object.fromEntries(limitKeys.map(key=>[key,field(supplied,key)]));
  if(!validRanges(normalized)||normalized.maxPageBytes>normalized.maxTotalBytes||normalized.dpi!==PDF_BOUNDS.dpi)fail('PDF_INVALID_LIMITS');
  return normalized;
}

function inputBytes(value,maximum) {
  if(!(value instanceof Uint8Array))fail('PDF_INVALID_INPUT');
  if(!value.length||value.length>maximum)fail('PDF_TOO_LARGE');
  const bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(!/%PDF-[12]\.\d/.test(bytes.subarray(0,1024).toString('latin1')))fail('PDF_UNSUPPORTED');
  return bytes;
}
// Header identification and hashing do not parse or establish that a PDF is safe to render.
export function pdfInputMetadata(bytes,{maxBytes=PDF_BOUNDS.sourceBytes}={}) {
  if(!positive(maxBytes,PDF_BOUNDS.sourceBytes))fail('PDF_INVALID_LIMITS');
  const source=inputBytes(bytes,maxBytes);
  return {mediaType:'application/pdf',size:source.length,sha256:digest(source)};
}
function base64(bytes) {return Buffer.from(bytes).toString('base64');}
function decode(value,maximum,code) {
  if(typeof value!=='string'||!value.length||value.length>Math.ceil(maximum/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail(code);
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>maximum||base64(bytes)!==value)fail(code);
  return bytes;
}
function validIdentity(value) {return typeof value==='string'&&sha.test(value);}

export function createPdfRequest({bytes,jobId=randomUUID(),processorDigest,expiresAt,limits},{now=Date.now()}={}) {
  const time=nowValue(now),normalized=validatePdfLimits(limits),source=inputBytes(bytes,normalized.maxBytes);
  if(typeof jobId!=='string'||!uuid.test(jobId)||!validIdentity(processorDigest))fail('PDF_INVALID_INPUT');
  validExpiry(expiresAt,time);
  return {version:1,jobId,inputSha256:digest(source),processorDigest,expiresAt,limits:normalized,data:base64(source)};
}

function checkRequest(value,now) {
  const time=nowValue(now);
  if(!exact(value,requestKeys)||value.version!==1||typeof value.jobId!=='string'||!uuid.test(value.jobId)
    ||!validIdentity(value.inputSha256)||!validIdentity(value.processorDigest))fail('PDF_INVALID_INPUT');
  const limits=validatePdfLimits(value.limits);if(!limitsEqual(value.limits))fail('PDF_INVALID_LIMITS');
  validExpiry(value.expiresAt,time);
  const bytes=decode(value.data,limits.maxBytes,'PDF_INVALID_INPUT');
  if(!/%PDF-[12]\.\d/.test(bytes.subarray(0,1024).toString('latin1'))||digest(bytes)!==value.inputSha256)fail('PDF_INVALID_INPUT');
  return {version:1,jobId:value.jobId,inputSha256:value.inputSha256,processorDigest:value.processorDigest,expiresAt:value.expiresAt,limits, data:base64(bytes)};
}
export function validatePdfRequest(request,{now=Date.now()}={}) {return checkRequest(request,now);}

export function pdfRequestByteLimit(request) {
  const limits=validatePdfLimits(request?.limits);
  return 4*Math.ceil(limits.maxBytes/3)+PDF_BOUNDS.requestOverhead;
}
export function pdfResponseByteLimit(request) {
  const limits=validatePdfLimits(request?.limits);
  return 4*Math.ceil((limits.maxTotalBytes+2*limits.maxPages)/3)+PDF_BOUNDS.responseOverhead;
}

function responseIdentity(value,request) {
  return value?.version===1&&value.complete===true&&value.jobId===request.jobId
    &&value.inputSha256===request.inputSha256&&value.processorDigest===request.processorDigest;
}
function responsePages(value,limits) {
  return Number.isSafeInteger(value?.pageCount)&&value.pageCount>0&&value.pageCount<=limits.maxPages
    &&Array.isArray(value.pages)&&value.pages.length===value.pageCount;
}
function responseShape(value,request) {
  if(value?.encrypted===true)fail('PDF_UNSUPPORTED');
  if(!exact(value,responseKeys)||value.encrypted!==false||!responseIdentity(value,request)||!responsePages(value,request.limits))fail('PDF_INVALID_OUTPUT');
}
function verifyPage(page,index,limits) {
  if(!exact(page,pageKeys)||page.pageNumber!==index+1||page.mediaType!=='image/png')fail('PDF_INVALID_OUTPUT');
  if(typeof page.data!=='string'||page.data.length>4*Math.ceil(limits.maxPageBytes/3))fail('PDF_TOO_LARGE');
  const bytes=decode(page.data,limits.maxPageBytes,'PDF_INVALID_OUTPUT');
  let metadata;
  try {metadata=validateImage(bytes,{mediaType:'image/png',maxBytes:limits.maxPageBytes,maxPixels:limits.maxPixels});}
  catch(error) {if(error?.code==='IMAGE_TOO_LARGE')fail('PDF_TOO_LARGE');fail('PDF_INVALID_OUTPUT');}
  return {bytes,metadata};
}
export function validatePdfResponse(response,{request,now=Date.now()}={}) {
  const checked=checkRequest(request,now);responseShape(response,checked);
  const verified=response.pages.map((page,index)=>verifyPage(page,index,checked.limits));
  if(verified.reduce((sum,page)=>sum+page.bytes.length,0)>checked.limits.maxTotalBytes)fail('PDF_TOO_LARGE');
  const pages=verified.map(({bytes,metadata},index)=>({pageNumber:index+1,mediaType:'image/png',bytes:Buffer.from(bytes),
    width:metadata.width,height:metadata.height,sha256:metadata.sha256}));
  return {version:1,complete:true,jobId:checked.jobId,inputSha256:checked.inputSha256,processorDigest:checked.processorDigest,
    pageCount:pages.length,encrypted:false,pages};
}
