import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactFiles, validateArtifactHandle } from '../src/artifact-files.mjs';
import { ImageError } from '../src/image-validation.mjs';

const runId='11111111-1111-4111-8111-111111111111';
const bytes=Buffer.from('%PDF-1.7\nsynthetic bounded fixture');
const digest=value=>createHash('sha256').update(value).digest('hex');

async function setup(t) {
  const stateRoot=await mkdtemp(join(tmpdir(),'mail-artifact-contract-'));
  await chmod(stateRoot,0o700);
  t.after(()=>rm(stateRoot,{recursive:true,force:true}));
  return stateRoot;
}

function validatePdfSource(source) {
  if(!source||typeof source!=='object'||Array.isArray(source)
    ||Object.keys(source).sort().join(',')!=='attachmentId,messageId,pageNumber,pdfSha256'
    ||source.messageId!=='synthetic-message'||source.attachmentId!=='synthetic-pdf'
    ||source.pageNumber!==1||source.pdfSha256!==digest(bytes)) {
    throw new Error('invalid trusted synthetic PDF provenance');
  }
  return true;
}

function validatePdfHandle(handle) {
  if(!handle||typeof handle!=='object'||handle.mediaType!=='application/pdf'
    ||Object.keys(handle).sort().join(',')!=='expiresAt,id,mediaType,runId,sha256,size,source'
    ||handle.runId!==runId||handle.expiresAt!==2000||handle.size!==bytes.length
    ||handle.sha256!==digest(bytes)||!/^([a-f0-9-]{36})$/.test(handle.id)) {
    throw new Error('invalid trusted synthetic PDF handle');
  }
  validatePdfSource(handle.source);
  return structuredClone(handle);
}

function makeFiles(stateRoot) {
  return createArtifactFiles({stateRoot,runId,expiresAt:2000,clock:()=>1000,
    validateSource:validatePdfSource,validateHandle:validatePdfHandle,
    validateBytes(value) {
      if(!Buffer.from(value).equals(bytes))throw new Error('unexpected synthetic bytes');
      return {size:value.length,sha256:digest(value)};
    }});
}

test('injected trusted PDF contract stores, reopens, verifies and removes artifact bytes',async t=>{
  const stateRoot=await setup(t),files=makeFiles(stateRoot);
  const handle=await files.put(bytes,{metadata:{mediaType:'application/pdf',size:bytes.length,sha256:digest(bytes)},
    source:{messageId:'synthetic-message',attachmentId:'synthetic-pdf',pageNumber:1,pdfSha256:digest(bytes)}});
  assert.equal(handle.runId,runId);assert.equal(handle.expiresAt,2000);
  assert.deepEqual(await files.read(handle),bytes);
  assert.deepEqual(await makeFiles(stateRoot).read(handle),bytes);
  assert.equal(await files.remove(handle),true);
  await assert.rejects(files.read(handle),ImageError);
});

test('injected source and handle validators run before artifact publication',async t=>{
  const stateRoot=await setup(t),files=makeFiles(stateRoot);
  await assert.rejects(files.put(bytes,{metadata:{mediaType:'application/pdf',size:bytes.length,sha256:digest(bytes)},source:{messageId:'bad'}}),ImageError);
  await assert.rejects(files.put(bytes,{metadata:{mediaType:'application/pdf',size:bytes.length,sha256:digest(bytes),unexpected:true},
    source:{messageId:'synthetic-message',attachmentId:'synthetic-pdf',pageNumber:1,pdfSha256:digest(bytes)}}),ImageError);
});

test('default validators still reject PDF handles and malformed injected validators',async()=>{
  const handle={id:randomUUID(),runId,mediaType:'application/pdf',size:bytes.length,width:1,height:1,
    sha256:digest(bytes),expiresAt:2000,source:{messageId:'synthetic-message',attachmentId:'synthetic-pdf'}};
  assert.throws(()=>validateArtifactHandle(handle),ImageError);
  for(const option of ['validateHandle','validateSource']) {
    assert.throws(()=>createArtifactFiles({stateRoot:'/tmp/state',runId,expiresAt:2000,validateBytes:()=>({}),[option]:null}),ImageError);
  }
});
