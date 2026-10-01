import {isDeepStrictEqual} from 'node:util';
import {createImageArtifacts} from './image-artifacts.mjs';
import {createTextArtifacts} from './text-artifacts.mjs';
import {prepareImages,imageParts} from './image-intake.mjs';
import {buildTextAttachmentReply} from './attachment-reply.mjs';
import {digest} from './policy.mjs';
import {removeArtifactReferences,cleanExpiredRunOrphans} from './artifact-files.mjs';
import {ImageError,imageFail} from './image-validation.mjs';
import {pageOptions} from './runtime-operations.mjs';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';

export const DOCUMENT_UNSUPPORTED_REPLY = 'This inbox accepts plain text requests and supported PNG or baseline JPEG image documents. Send non-inline images within the configured limits. PDF, linked files, other attachment formats and incomplete requests cannot be processed.';
const ATTACHMENT_NOTICE = 'The generated transcription is attached as a text file. Review it against the source images; uncertain or unreadable text may require correction.';
export const artifactFailure=error=>error instanceof ImageError && (error.code.startsWith('IMAGE_ARTIFACT_') || error.code==='IMAGE_EXPIRED');
export const unsupportedDocumentInput=error=>error instanceof ImageError && ['IMAGE_UNSUPPORTED','IMAGE_TOO_LARGE','IMAGE_INVALID'].includes(error.code);

function attachment(handle,bytes) {
  return {bytes,name:handle.name,contentType:handle.mediaType,sha256:handle.sha256,expiresAt:handle.expiresAt};
}

function intent(run,handle,payload) {
  return {messageId:run.mail.id,conversationId:run.mail.conversationId,recipient:payload.recipient,
    bodySha256:digest(run.reply),artifactId:handle.id,artifactSha256:handle.sha256,
    filename:handle.name,mediaType:handle.mediaType,size:handle.size,expiresAt:handle.expiresAt,
    payloadSha256:payload.payloadSha256};
}

/** Private artifacts remain behind these explicit run/store/mail boundaries. */
export function createDocumentWorkflow({config,stateRoot,store,clock}) {
  const enabled=config.schema_version===2 && config.documents?.images.enabled===true;
  const expiresAt=run=>run.createdAt+config.retention.content_hours*3600000;
  const imageStore=run=>createImageArtifacts({stateRoot,runId:run.id,expiresAt:expiresAt(run),clock});
  const textStore=run=>createTextArtifacts({stateRoot,runId:run.id,expiresAt:expiresAt(run),clock});
  const contextOptions=run=>({artifacts:run.imageArtifacts??[],imageContextTokens:config.model.image_context_tokens??0});
  const attachmentOutput=run=>run.responseKind==='images' && config.documents?.output.format==='text-attachment';
  const attachmentDelivery=run=>(run.replyKind==='transcript' && config.documents?.output.format==='text-attachment')
    || Boolean(run.outputArtifact || run.deliveryIntent);

  async function verifyImages(run,{signal}={}) {
    if (run.responseKind!=='images') return;
    if (!enabled || !Array.isArray(run.imageArtifacts) || !run.imageArtifacts.length) imageFail('IMAGE_ARTIFACT_INVALID');
    if (run.imageArtifacts.some(handle=>handle.runId!==run.id || handle.source.messageId!==run.mail.id)) imageFail('IMAGE_ARTIFACT_INVALID');
    verifyContext(run);
    await imageParts(run.imageArtifacts,imageStore(run),{signal});
  }

  function verifyContext(run) {
    if (!run.messages) return;
    if (!Array.isArray(run.messages) || run.messages.length>4096) imageFail('IMAGE_ARTIFACT_INVALID');
    const references=run.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(part=>part?.type==='image-reference').map(part=>part.artifact):[]);
    if (!isDeepStrictEqual(references,run.imageArtifacts)) imageFail('IMAGE_ARTIFACT_INVALID');
  }

  async function intake(run,{client,read,signal}) {
    if (!enabled || typeof client.getImageAttachments!=='function' || typeof client.getAttachmentBytes!=='function') {
      throw new Error('Image adapter is unavailable.');
    }
    const limits=config.documents.images;
    const attachments=await read(signal=>client.getImageAttachments(run.mail.id,{maxImages:limits.max_count,signal}));
    const artifacts=imageStore(run);
    const handles=await prepareImages({mail:run.mail,attachments,artifacts,signal,
      limits:{maxImages:limits.max_count,maxBytes:limits.max_file_bytes,maxTotalBytes:limits.max_total_bytes,maxPixels:limits.max_pixels},
      readAttachment:(messageId,attachmentId,options)=>read(signal=>client.getAttachmentBytes(messageId,attachmentId,{...options,signal}))});
    try {
      const staged={...run,imageArtifacts:handles,responseKind:'images'};
      store.transaction(()=>{
        for(const handle of handles)store.saveArtifact({purpose:'image-input',handle,createdAt:clock()});
        store.saveRun(staged);
      });
      Object.assign(run,staged);
    } catch(error) {
      for(const handle of handles)await artifacts.remove(handle).catch(()=>{});
      throw error;
    }
  }

  async function stageReply(run,text,{signal}={}) {
    if (!attachmentOutput(run)) return false;
    if (!text.trim()) throw new Error('No transcription was produced.');
    const artifacts=textStore(run);
    const handle=await artifacts.put(text,{source:{messageId:run.mail.id,attachmentId:'generated-transcript'},
      maxBytes:config.documents.output.max_bytes,signal});
    try {
      const bytes=await artifacts.read(handle,{signal});
      const staged={...run,reply:ATTACHMENT_NOTICE,outputArtifact:handle,replyKind:'transcript',status:'ready_to_send'};
      const payload=buildTextAttachmentReply({message:run.mail,bodyText:staged.reply,artifact:attachment(handle,bytes),now:clock()});
      staged.deliveryIntent=intent(staged,handle,payload);
      store.transaction(()=>{
        store.saveArtifact({purpose:'text-output',handle,createdAt:clock()});
        store.saveRun(staged);
      });
      Object.assign(run,staged);
      return true;
    } catch(error) {await artifacts.remove(handle).catch(()=>{});throw error;}
  }

  async function delivery(run,{signal}={}) {
    const required=run.replyKind==='transcript' && config.documents?.output.format==='text-attachment';
    if (!required && !run.outputArtifact && !run.deliveryIntent) return {};
    if (!enabled || !run.outputArtifact || !run.deliveryIntent) throw new Error('Attachment delivery intent is incomplete.');
    const handle=run.outputArtifact;
    const bytes=await textStore(run).read(handle,{signal}),value=attachment(handle,bytes);
    const payload=buildTextAttachmentReply({message:run.mail,bodyText:run.reply,artifact:value,now:clock()});
    if (!isDeepStrictEqual(run.deliveryIntent,intent(run,handle,payload))) throw new Error('Attachment delivery intent changed.');
    return {attachment:value,expectedPayloadSha256:payload.payloadSha256};
  }

  async function collect({signal}={}) {
    let failed=0;
    let after;
    do {
      const page=store.artifactGcBatch({limit:100,after});
      for(const item of page.items) {
        const handle=item.handle;
        try {
          await removeArtifactReferences({stateRoot,references:[{handle,retired:true}],clock,signal});
          store.deleteRetiredArtifact(handle.id);
        } catch {failed++; /* Keep the durable retired reference for a later safe retry. */ }
      }
      after=page.nextCursor;
    } while(after && !signal?.aborted);
    try {failed+=await collectOrphans(signal);} catch {failed++;}
    return {failed};
  }

  async function collectOrphans(signal) {
    try {await lstat(join(stateRoot,'artifacts'));}
    catch(error) {if (error.code==='ENOENT') return 0;throw error;}
    let failed=0;
    const raw=store.getMetaBounded('artifact_orphan_cursor',1024);
    const options=pageOptions({limit:10,after:raw?JSON.parse(raw):undefined});
    const page=store.runPage(options);
    for(const run of page.items) {
      try {await collectRunOrphans(run,signal);} catch {failed++;}
    }
    store.setMeta('artifact_orphan_cursor',page.nextCursor?JSON.stringify(page.nextCursor):'');
    return failed;
  }

  async function collectRunOrphans(run,signal) {
    if (!run || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id) || !Number.isSafeInteger(run.createdAt)) return;
    const expiry=expiresAt(run);
    if (expiry>clock()) return;
    await cleanExpiredRunOrphans({stateRoot,runId:run.id,expiresAt:expiry,
      references:store.artifactIdsForRun(run.id),clock,signal,maxEntries:100});
  }

  async function collectExpiredRuns(ids,{signal}={}) {
    if (!Array.isArray(ids) || ids.length>100) throw new Error('Invalid artifact maintenance batch.');
    let failed=0;
    for(const id of ids) {
      try {await collectRunOrphans(store.getRun(id),signal);} catch {failed++;}
    }
    return {failed};
  }

  return {enabled,intake,stageReply,delivery,collect,collectExpiredRuns,contextOptions,imageStore,attachmentOutput,attachmentDelivery,verifyImages};
}
